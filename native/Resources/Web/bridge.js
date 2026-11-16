/* VoiceReader native TTS bridge.
 * Injected at document start, BEFORE app.js. Replaces window.speechSynthesis so
 * every read-aloud call goes to the native AVSpeechSynthesizer instead of Safari.
 * The web layer keeps owning the UI; the native layer owns the playback queue so
 * reading continues when the app is backgrounded or the screen locks.
 */
(function () {
  'use strict';
  var H = (window.webkit && window.webkit.messageHandlers &&
           window.webkit.messageHandlers.vrTTS) || null;
  if (!H) return; // not inside the native shell: leave the browser alone

  var voices = Array.isArray(window.__VR_VOICES__) ? window.__VR_VOICES__ : [];
  var oneShots = {};

  function Utterance(text) {
    this.text = String(text == null ? '' : text);
    this.lang = 'zh-CN';
    this.voice = null;
    this.rate = 1; this.pitch = 1; this.volume = 1;
    this.onstart = null; this.onend = null; this.onerror = null;
  }

  var fakeSynth = {
    paused: false,
    speaking: false,
    pending: false,
    onvoiceschanged: null,
    getVoices: function () { return voices.slice(); },
    speak: function (u) {
      // Only one-shot previews reach this path; chapter queues use __vrNative.startQueue.
      this.speaking = true;
      this.paused = false;
      var id = 'one-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      oneShots[id] = u;
      H.postMessage({
        cmd: 'speakOne', id: id, text: u.text,
        voiceURI: (u.voice && u.voice.voiceURI) || '',
        lang: u.lang || 'zh-CN',
        rate: u.rate || 1, pitch: u.pitch || 1, volume: u.volume || 1
      });
      if (typeof u.onstart === 'function') u.onstart({});
    },
    cancel: function () {
      H.postMessage({ cmd: 'stop' });
      this.speaking = false; this.pending = false;
      oneShots = {};
    },
    pause: function () { H.postMessage({ cmd: 'pause' }); this.paused = true; },
    resume: function () { H.postMessage({ cmd: 'resume' }); this.paused = false; }
  };

  function define(name, value) {
    try {
      Object.defineProperty(window, name,
        { value: value, configurable: true, writable: true });
    } catch (e) {
      try { window[name] = value; } catch (e2) {}
    }
  }
  define('speechSynthesis', fakeSynth);
  define('SpeechSynthesisUtterance', Utterance);

  // Called by the native layer when a one-shot preview finishes.
  window.__vrOneFinished = function (id, err) {
    var u = oneShots[id];
    if (!u) return;
    delete oneShots[id];
    fakeSynth.speaking = false;
    if (err && typeof u.onerror === 'function') u.onerror({ error: String(err) });
    else if (typeof u.onend === 'function') u.onend({});
  };

  window.__vrSetVoices = function (list) {
    voices = Array.isArray(list) ? list : [];
    if (typeof fakeSynth.onvoiceschanged === 'function') fakeSynth.onvoiceschanged();
  };

  // The playback queue lives entirely in Swift. None of these calls rely on JS
  // timers, which iOS suspends while the app is in the background.
  window.__vrNative = {
    startQueue: function (opts) {
      var msg = { cmd: 'startQueue' };
      for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) msg[k] = opts[k];
      H.postMessage(msg);
    },
    stop: function () { H.postMessage({ cmd: 'stop' }); },
    pause: function () { H.postMessage({ cmd: 'pause' }); },
    resume: function () { H.postMessage({ cmd: 'resume' }); },
    preview: function (text, opts) {
      var msg = { cmd: 'preview', text: text };
      for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) msg[k] = opts[k];
      H.postMessage(msg);
    },
    reloadVoices: function () { H.postMessage({ cmd: 'reloadVoices' }); },
    ready: function () { H.postMessage({ cmd: 'ready' }); }
  };

  if (window.__vrNative) window.__vrNative.ready();
})();
