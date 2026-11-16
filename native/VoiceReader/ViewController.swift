import UIKit
import WebKit
import AVFoundation

class ViewController: UIViewController, WKScriptMessageHandler {

  private var webView: WKWebView!

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .white

    let config = WKWebViewConfiguration()
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []

    // Register the message handler BEFORE loading content, so bridge.js sees it.
    let cc = config.userContentController
    cc.add(self, name: "vrTTS")

    // Seed the voice list at document start: bridge.js reads window.__VR_VOICES__.
    let voices = AVSpeechSynthesisVoice.speechVoices().map { v -> [String: Any] in
      return ["name": v.name, "lang": v.language, "voiceURI": v.identifier, "localService": true]
    }
    var seed = "window.__VR_VOICES__ = [];"
    if let data = try? JSONSerialization.data(withJSONObject: voices, options: []),
       let json = String(data: data, encoding: .utf8) {
      seed = "window.__VR_VOICES__ = \(json);"
    }
    let script = WKUserScript(source: seed, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    cc.addUserScript(script)

    // file:// fetch() of the bundled sample can be blocked by WKWebView. Seed the
    // sample as base64 and shim only that one request so "载入示例书" always works.
    if let sampleURL = Bundle.main.url(forResource: "sample", withExtension: "epub",
                                       subdirectory: "Resources/Web"),
       let sampleData = try? Data(contentsOf: sampleURL) {
      let b64 = sampleData.base64EncodedString()
      let shim = """
      window.__VR_SAMPLE_B64__ = "\(b64)";
      (function () {
        var realFetch = window.fetch;
        window.fetch = function (u, o) {
          var url = String(u || '');
          if (url.indexOf('sample.epub') >= 0 && window.__VR_SAMPLE_B64__) {
            try {
              var bin = atob(window.__VR_SAMPLE_B64__);
              var bytes = new Uint8Array(bin.length);
              for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              return Promise.resolve(new Response(bytes, { status: 200,
                headers: { 'Content-Type': 'application/epub+zip' } }));
            } catch (e) {}
          }
          return realFetch.apply(this, arguments);
        };
      })();
      """
      cc.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentStart,
                                    forMainFrameOnly: true))
    }

    let webView = WKWebView(frame: .zero, configuration: config)
    webView.translatesAutoresizingMaskIntoConstraints = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.backgroundColor = .white
    view.addSubview(webView)
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: view.topAnchor),
      webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
    ])
    self.webView = webView
    NativeSpeech.shared.webView = webView

    loadWeb()

    NotificationCenter.default.addObserver(
      self,
      selector: #selector(appDidBecomeActive),
      name: UIApplication.didBecomeActiveNotification,
      object: nil
    )
  }

  private func loadWeb() {
    guard let url = Bundle.main.url(forResource: "index.native", withExtension: "html", subdirectory: "Resources/Web")
                ?? Bundle.main.url(forResource: "index.native", withExtension: "html") else {
      webView.loadHTMLString("<h3 style='font-family:sans-serif'>Missing web bundle</h3>", baseURL: nil)
      return
    }
    webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
  }

  @objc private func appDidBecomeActive() {
    // Deliver any queued voices once the JS bridge is alive again.
    NativeSpeech.shared.handle(["cmd": "reloadVoices"])
  }

  // MARK: - WKScriptMessageHandler

  func userContentController(_ userContentController: WKUserContentController,
                             didReceive message: WKScriptMessage) {
    guard message.name == "vrTTS" else { return }
    if let body = message.body as? [String: Any] {
      NativeSpeech.shared.handle(body)
    }
  }
}
