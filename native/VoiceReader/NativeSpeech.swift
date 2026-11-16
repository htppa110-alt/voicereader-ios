import AVFoundation
import MediaPlayer
import UIKit
import WebKit

/// Native speech engine. It owns the playback queue so reading keeps going when
/// WKWebView JavaScript is suspended after the app is backgrounded / screen locked.
/// The web layer sends commands through the `vrTTS` WKScriptMessageHandler; the
/// native layer drives AVSpeechSynthesizer via its delegate and calls back into JS.
final class NativeSpeech: NSObject, AVSpeechSynthesizerDelegate {

  static let shared = NativeSpeech()

  private let synth = AVSpeechSynthesizer()
  private var items: [[String: Any]] = []
  private var index: Int = 0
  private var isQueueMode = false
  private var oneShotId: String? = nil

  private var currentBook = "声读"
  private var currentChapter = 1
  private var totalChapters = 1
  private var rate: Float = 1
  private var pitch: Float = 1
  private var lang = "zh-CN"
  private var voiceURI = ""

  var isPlaying = false
  weak var webView: WKWebView?

  private override init() {
    super.init()
    synth.delegate = self
    configureAudioSession()
    setupRemoteCommands()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(appDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification,
      object: nil
    )
  }

  // MARK: - Audio session (background playback)

  private func configureAudioSession() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .spokenAudio,
                              options: [.duckOthers, .allowBluetooth, .allowBluetoothA2DP])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      print("[VoiceReader] audio session error: \(error)")
    }
  }

  // MARK: - JS bridge commands

  func handle(_ body: [String: Any]) {
    guard let cmd = body["cmd"] as? String else { return }
    switch cmd {
    case "ready", "reloadVoices":
      sendVoices()
    case "speakOne":
      oneShotId = body["id"] as? String
      speakOnce(body)
    case "preview":
      oneShotId = "__preview__"
      speakOnce(body)
    case "startQueue":
      startQueue(body)
    case "stop":
      stopAll()
    case "pause":
      pauseQueue()
    case "resume":
      resumeQueue()
    default:
      break
    }
  }

  private func sendVoices() {
    let list: [[String: Any]] = AVSpeechSynthesisVoice.speechVoices().map { v in
      return [
        "name": v.name,
        "lang": v.language,
        "voiceURI": v.identifier,
        "localService": true
      ]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: list, options: []),
          let json = String(data: data, encoding: .utf8) else { return }
    eval("window.__vrSetVoices && window.__vrSetVoices(\(json));")
    eval("window.__vrTTS__ && window.__vrTTS__.voices(\(json));")
  }

  private func speakOnce(_ m: [String: Any]) {
    synth.stopSpeaking(at: .immediate)
    let u = AVSpeechUtterance(string: m["text"] as? String ?? "")
    u.rate = clampRate(num(m["rate"], 1))
    u.pitchMultiplier = clampPitch(num(m["pitch"], 1))
    u.volume = clampVolume(m["volume"])
    let uri = m["voiceURI"] as? String ?? ""
    let language = m["lang"] as? String ?? lang
    if let v = pickVoice(voiceURI: uri, lang: language) { u.voice = v }
    isQueueMode = false
    synth.speak(u)
  }

  private func startQueue(_ m: [String: Any]) {
    items = m["items"] as? [[String: Any]] ?? []
    index = m["index"] as? Int ?? 0
    rate = num(m["rate"], 1)
    pitch = num(m["pitch"], 1)
    voiceURI = m["voiceURI"] as? String ?? ""
    lang = m["lang"] as? String ?? "zh-CN"
    currentBook = m["book"] as? String ?? "声读"
    currentChapter = m["chapter"] as? Int ?? 1
    totalChapters = m["chapters"] as? Int ?? 1
    isQueueMode = true
    isPlaying = true
    synth.stopSpeaking(at: .immediate)
    eval("window.__vrTTS__ && window.__vrTTS__.state(true);")
    speakCurrent()
  }

  private func speakCurrent() {
    guard index >= 0, index < items.count else { queueEnded(); return }
    let item = items[index]
    let text = item["text"] as? String ?? ""
    if text.isEmpty {
      index += 1
      speakCurrent()
      return
    }
    let u = AVSpeechUtterance(string: text)
    u.rate = clampRate(rate)
    u.pitchMultiplier = clampPitch(pitch)
    u.volume = 1.0
    if let v = pickVoice(voiceURI: voiceURI, lang: lang) { u.voice = v }
    synth.speak(u)
    updateNowPlaying()
  }

  private func stopAll() {
    synth.stopSpeaking(at: .immediate)
    isQueueMode = false
    isPlaying = false
    items = []
    index = 0
    eval("window.__vrTTS__ && window.__vrTTS__.state(false);")
    clearNowPlaying()
  }

  private func pauseQueue() {
    isPlaying = false
    if synth.isSpeaking { synth.pauseSpeaking(at: .word) }
    eval("window.__vrTTS__ && window.__vrTTS__.state(false);")
    updateNowPlaying()
  }

  private func resumeQueue() {
    guard !items.isEmpty else { return }
    isPlaying = true
    if synth.isPaused {
      synth.continueSpeaking()
    } else if !synth.isSpeaking {
      isQueueMode = true
      speakCurrent()
    }
    eval("window.__vrTTS__ && window.__vrTTS__.state(true);")
    updateNowPlaying()
  }

  private func queueEnded() {
    isPlaying = false
    eval("window.__vrTTS__ && window.__vrTTS__.ended();")
    eval("window.__vrTTS__ && window.__vrTTS__.state(false);")
    clearNowPlaying()
  }

  // MARK: - AVSpeechSynthesizerDelegate

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                         willSpeakRangeOfSpeechString characterRange: NSRange,
                         utterance: AVSpeechUtterance) {
    guard isQueueMode, index >= 0, index < items.count else { return }
    let para = (items[index] as? [String: Any])?["para"] as? Int ?? index
    eval("window.__vrTTS__ && window.__vrTTS__.sentence(\(para), \(index));")
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                         didFinish utterance: AVSpeechUtterance) {
    if isQueueMode {
      index += 1
      if index < items.count { speakCurrent() } else { queueEnded() }
    } else if let id = oneShotId {
      oneShotId = nil
      eval("window.__vrOneFinished && window.__vrOneFinished(\(jsq(id)), null);")
    }
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                         didCancel utterance: AVSpeechUtterance) {
    // Explicit stop()/startQueue() call stopSpeaking -> didCancel; no queue change here.
  }

  // MARK: - Lock-screen / remote controls

  private func setupRemoteCommands() {
    let cc = MPRemoteCommandCenter.shared()
    cc.playCommand.addTarget { [weak self] _ in self?.remote("play"); return .success }
    cc.pauseCommand.addTarget { [weak self] _ in self?.remote("pause"); return .success }
    cc.togglePlayPauseCommand.addTarget { [weak self] _ in
      self?.remote((self?.isPlaying ?? false) ? "pause" : "play")
      return .success
    }
    cc.nextTrackCommand.addTarget { [weak self] _ in self?.remote("next"); return .success }
    cc.previousTrackCommand.addTarget { [weak self] _ in self?.remote("previous"); return .success }
  }

  private func remote(_ op: String) {
    eval("window.VoiceReaderNative && window.VoiceReaderNative.remote(\(jsq(op)));")
  }

  private func updateNowPlaying() {
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: "第 \(currentChapter) 章",
      MPMediaItemPropertyArtist: currentBook,
      MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0
    ]
    if let path = Bundle.main.path(forResource: "apple-touch-icon", ofType: "png"),
       let img = UIImage(contentsOfFile: path) {
      info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
    }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  private func clearNowPlaying() {
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
  }

  // MARK: - Foreground sync

  @objc private func appDidBecomeActive() {
    guard !items.isEmpty, index >= 0, index < items.count else { return }
    let para = (items[index] as? [String: Any])?["para"] as? Int ?? index
    eval("window.__vrTTS__ && window.__vrTTS__.sync(\(para), \(index));")
  }

  // MARK: - Helpers

  private func eval(_ js: String) {
    DispatchQueue.main.async { [weak self] in
      self?.webView?.evaluateJavaScript(js, completionHandler: nil)
    }
  }

  private func num(_ v: Any?, _ fallback: Float) -> Float {
    if let n = v as? NSNumber { return n.floatValue }
    if let s = v as? String, let f = Float(s) { return f }
    return fallback
  }

  private func clampVolume(_ v: Any?) -> Float {
    var f: Float = 1
    if let n = v as? NSNumber { f = n.floatValue }
    else if let s = v as? String, let parsed = Float(s) { f = parsed }
    return min(max(f, 0), 1)
  }

  private func clampRate(_ r: Float) -> Float {
    let v = AVSpeechUtteranceDefaultSpeechRate * r
    return min(max(v, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
  }

  private func clampPitch(_ p: Float) -> Float {
    return min(max(p, 0.5), 2.0)
  }

  private func pickVoice(voiceURI uri: String, lang language: String) -> AVSpeechSynthesisVoice? {
    let all = AVSpeechSynthesisVoice.speechVoices()
    if !uri.isEmpty {
      if let hit = all.first(where: { $0.identifier == uri }) { return hit }
      if let hit = AVSpeechSynthesisVoice(voiceWithIdentifier: uri) { return hit }
    }
    let preferred = all.filter { $0.language.hasPrefix("zh") || $0.language.hasPrefix("cmn") }
    if let best = preferred.max(by: { self.quality($0) < self.quality($1) }) { return best }
    return AVSpeechSynthesisVoice(language: language.hasPrefix("zh") ? language : "zh-CN")
  }

  private func quality(_ v: AVSpeechSynthesisVoice) -> Int {
    if #available(iOS 16.0, *) {
      switch v.quality {
      case .premium: return 3
      case .enhanced: return 2
      case .default: return 1
      @unknown default: return 1
      }
    }
    // iOS 15: premium enum case is unavailable; enhanced is still detectable.
    return v.quality == .enhanced ? 2 : 1
  }

  /// Escape a Swift String into a valid JavaScript string literal via JSON,
  /// which is a subset of JS, so quotes/backslashes/newlines are always safe.
  private func jsq(_ s: String) -> String {
    if let data = try? JSONSerialization.data(withJSONObject: [s], options: []),
       let arr = String(data: data, encoding: .utf8),
       arr.count >= 2 {
      return String(arr.dropFirst().dropLast()) // strip [ ]
    }
    return "\"\""
  }
}
