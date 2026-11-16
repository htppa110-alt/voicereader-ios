#!/usr/bin/env python3
"""Produce the native-shell variants of the existing PWA files.

The original index.html / app.js are left untouched (they still work as a PWA).
The generated copies route all read-aloud control to the native queue so playback
is not driven by JavaScript timers, which iOS suspends in the background.
"""
import pathlib
import sys

WEB = pathlib.Path(__file__).resolve().parents[1] / "native" / "Resources" / "Web"

REPLACEMENTS = [
    (
        """  function speakNext() {
    if (!speech.playing || !speech.synth) return;""",
        """  function speakNext() {
    if (window.__vrNative) return; /* native queue owns playback; JS timers stop in background */
    if (!speech.playing || !speech.synth) return;""",
    ),
    (
        """    $('playerStatus').textContent = '正在朗读';
    startSpeechHooks();
    // iOS Safari needs a short gap after cancel() before a fresh utterance.
    setTimeout(() => { if (speech.playing) speakNext(); }, 130);""",
        """    $('playerStatus').textContent = '正在朗读';
    startSpeechHooks();
    if (window.__vrNative) {
      const v = pickVoice();
      window.__vrNative.startQueue({
        items: speech.queue.map((q) => ({ para: q.para, text: q.text })),
        index: 0,
        rate: clamp(settings.rate, 0.5, 2), pitch: clamp(settings.pitch, 0.7, 1.4),
        voiceURI: settings.voiceURI || '', lang: v ? v.lang : 'zh-CN',
        book: state.book ? state.book.title : '声读',
        chapter: state.chapter + 1, chapters: state.book ? state.book.chapters.length : 1
      });
      return;
    }
    // iOS Safari needs a short gap after cancel() before a fresh utterance.
    setTimeout(() => { if (speech.playing) speakNext(); }, 130);""",
    ),
    (
        """  function stopSpeech() {
    speech.playing = false;
    stopTimersOnly();
    try { if (speech.synth) speech.synth.cancel(); } catch (e) {}""",
        """  function stopSpeech() {
    speech.playing = false;
    stopTimersOnly();
    if (window.__vrNative) window.__vrNative.stop();
    try { if (speech.synth) speech.synth.cancel(); } catch (e) {}""",
    ),
    (
        """  function pauseSpeech() {
    if (!speech.playing) return;
    speech.playing = false;
    stopTimersOnly();""",
        """  function pauseSpeech() {
    if (!speech.playing) return;
    speech.playing = false;
    stopTimersOnly();
    if (window.__vrNative) window.__vrNative.pause();""",
    ),
    (
        """  function toggleSpeech() {
    if (speech.playing) { pauseSpeech(); return; }
    if (speech.queue.length && speech.qi < speech.queue.length) {""",
        """  function toggleSpeech() {
    if (speech.playing) { pauseSpeech(); return; }
    if (window.__vrNative) {
      speech.playing = true; setPlayIcon(true); $('playerStatus').textContent = '正在朗读';
      startSpeechHooks(); window.__vrNative.resume(); return;
    }
    if (speech.queue.length && speech.qi < speech.queue.length) {""",
    ),
    (
        """  function previewVoice() {
    if (!speech.synth) return;
    refreshVoices();
    const u = new SpeechSynthesisUtterance(""",
        """  function previewVoice() {
    if (!speech.synth) return;
    refreshVoices();
    if (window.__vrNative) {
      const pv = pickVoice();
      window.__vrNative.preview('你好，这是语音试听。今天，我们一起安静地读一本好书。', {
        rate: settings.rate, pitch: settings.pitch,
        voiceURI: settings.voiceURI || '', lang: pv ? pv.lang : 'zh-CN'
      });
      return;
    }
    const u = new SpeechSynthesisUtterance(""",
    ),
    (
        """    if (speech.synth) { try { speech.synth.cancel(); } catch (e) {} }
    if (!keepPlaying) stopSpeech();""",
        """    if (window.__vrNative) window.__vrNative.stop();
    if (speech.synth) { try { speech.synth.cancel(); } catch (e) {} }
    if (!keepPlaying) stopSpeech();""",
    ),
    (
        """  /* ---------------- boot ---------------- */""",
        """  /* ---------------- native playback callbacks ----------------
   * These are invoked by Swift via evaluateJavaScript. They contain no timers:
   * when the app is backgrounded, WKWebView JS is suspended, but the native
   * queue keeps speaking; on return to foreground Swift replays the last
   * position here so highlight and progress catch up. */
  window.__vrTTS__ = {
    sentence: function (para, index) {
      if (!state.paragraphs.length) return;
      speech.qi = index; highlight(para);
    },
    sync: function (para, index) {
      if (!state.paragraphs.length) return;
      speech.qi = index; highlight(para);
    },
    ended: function () { if (speech.playing) onQueueEnd(); },
    state: function (playing) {
      speech.playing = !!playing;
      setPlayIcon(speech.playing);
      $('playerStatus').textContent = speech.playing ? '正在朗读' : '已暂停';
    },
    voices: function (list) {
      speech.voices = Array.isArray(list) ? list : [];
      refreshVoices();
    }
  };

  /* ---------------- boot ---------------- */""",
    ),
]


def main() -> int:
    src = (WEB / "app.js").read_text(encoding="utf-8")
    for i, (old, new) in enumerate(REPLACEMENTS, 1):
        count = src.count(old)
        if count != 1:
            print(f"FAIL patch {i}: expected 1 match, found {count}", file=sys.stderr)
            return 1
        src = src.replace(old, new, 1)
    (WEB / "app.native.js").write_text(src, encoding="utf-8")

    html = (WEB / "index.html").read_text(encoding="utf-8")
    old_scripts = '<script src="./jszip.min.js"></script>\n<script src="./app.js"></script>'
    new_scripts = ('<script src="./bridge.js"></script>\n'
                   '<script src="./jszip.min.js"></script>\n'
                   '<script src="./app.native.js"></script>')
    if html.count(old_scripts) != 1:
        print("FAIL: could not locate script tags in index.html", file=sys.stderr)
        return 1
    html = html.replace(old_scripts, new_scripts, 1)
    (WEB / "index.native.html").write_text(html, encoding="utf-8")

    print(f"OK: {len(REPLACEMENTS)} patches applied")
    print("    app.native.js      ", len(src), "chars")
    print("    index.native.html  ", len(html), "chars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
