/* 声读 - offline EPUB reader with system speech synthesis */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  const fmtDate = (t) => {
    const d = new Date(t), now = new Date();
    const same = d.toDateString() === now.toDateString();
    return same ? '今天 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      : (d.getMonth() + 1) + '月' + d.getDate() + '日';
  };

  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2200);
  }
  function loading(text) { $('loadingText').textContent = text; $('loading').hidden = false; }
  function loaded() { $('loading').hidden = true; }

  function loadJSON(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? Object.assign({}, fallback, JSON.parse(v)) : Object.assign({}, fallback); }
    catch (e) { return Object.assign({}, fallback); }
  }
  function saveJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }

  const DEFAULT_SETTINGS = {
    voiceURI: '', rate: 1, pitch: 1, autoScroll: true, autoNext: true, wakeLock: true,
    fontSize: 19, lineHeight: 1.9, theme: 'paper', timerMin: 0
  };
  let settings = loadJSON('vr.settings.v1', DEFAULT_SETTINGS);
  let progressMap = loadJSON('vr.progress.v1', {});
  const saveSettings = () => saveJSON('vr.settings.v1', settings);
  const saveProgressMap = () => saveJSON('vr.progress.v1', progressMap);

  /* ---------------- local book storage (IndexedDB, memory fallback) ---------------- */
  let dbPromise = null, dbOK = true;
  const memBooks = new Map();
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open('voicereader', 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    }).catch((e) => { dbOK = false; return null; });
    return dbPromise;
  }
  function runStore(mode, fn) {
    return db().then((d) => {
      if (!d) {
        const fake = {
          getAll: () => ({ result: Array.from(memBooks.values()) }),
          put: (r) => ({ result: memBooks.set(r.id, r) }),
          delete: (id) => ({ result: memBooks.delete(id) }),
          clear: () => ({ result: memBooks.clear() })
        };
        const r = fn(fake, true);
        return r && r.result !== undefined ? r.result : null;
      }
      return new Promise((resolve, reject) => {
        const t = d.transaction('books', mode), store = t.objectStore('books');
        const request = fn(store, false);
        t.oncomplete = () => resolve(request && request.result !== undefined ? request.result : null);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    });
  }
  const allBooks = () => runStore('readonly', (s) => s.getAll());
  const putBook = (r) => runStore('readwrite', (s) => s.put(r));
  const delBook = (id) => runStore('readwrite', (s) => s.delete(id));
  const clearBooks = () => runStore('readwrite', (s) => s.clear());

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function readFileBuffer(file) {
    if (file.arrayBuffer) return file.arrayBuffer();
    return new Promise((res, rej) => {
      const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(file);
    });
  }

  /* ---------------- EPUB parsing ---------------- */
  function normPath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/#.*$/, '').replace(/\?.*$/, '');
  }
  function resolvePath(base, href) {
    let h;
    try { h = decodeURIComponent(normPath(href)); } catch (e) { h = normPath(href); }
    if (!h) return '';
    if (/^[a-z]+:\/\//i.test(h)) return h;
    const parts = (base ? base.split('/').slice(0, -1) : []).concat(h.split('/'));
    const out = [];
    parts.forEach((p) => {
      if (!p || p === '.') return;
      if (p === '..') out.pop(); else out.push(p);
    });
    return out.join('/');
  }
  function findFile(zip, path) {
    if (!path) return null;
    const raw = normPath(path), dec = (() => { try { return decodeURIComponent(raw); } catch (e) { return raw; } })();
    const tries = [raw, dec, './' + raw, raw.replace(/^\.\//, '')];
    for (const t of tries) { if (zip.files[t] && !zip.files[t].dir) return zip.file(t); }
    const keys = Object.keys(zip.files).filter((k) => !zip.files[k].dir);
    const want = dec.replace(/\.\.\//g, '').replace(/\.\//g, '').toLowerCase();
    let hit = keys.find((k) => k.toLowerCase().replace(/\.\//g, '') === want);
    if (hit) return zip.file(hit);
    const bn = dec.split('/').pop().toLowerCase();
    hit = keys.find((k) => k.split('/').pop().toLowerCase() === bn);
    return hit ? zip.file(hit) : null;
  }
  function parseXML(text) {
    let doc = new DOMParser().parseFromString(text, 'application/xml');
    if (!doc || doc.querySelector('parsererror')) doc = new DOMParser().parseFromString(text, 'text/html');
    return doc;
  }
  function nodesByLocal(root, name) {
    const out = [];
    const all = root.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const ln = (all[i].localName || all[i].nodeName).toLowerCase();
      if (ln === name) out.push(all[i]);
    }
    return out;
  }
  function childByLocal(node, name) {
    for (let i = 0; i < node.children.length; i++) {
      const c = node.children[i];
      if ((c.localName || c.nodeName).toLowerCase() === name) return c;
    }
    return null;
  }
  function textOf(node) { return node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : ''; }

  function readTocNCX(text, base, zip) {
    const doc = parseXML(text), out = [];
    const navMaps = nodesByLocal(doc, 'navmap');
    const walk = (parent, level) => {
      for (let i = 0; i < parent.children.length; i++) {
        const np = parent.children[i];
        if ((np.localName || np.nodeName).toLowerCase() !== 'navpoint') continue;
        const labelNode = childByLocal(np, 'navlabel');
        const label = textOf(labelNode ? childByLocal(labelNode, 'text') : null) || textOf(labelNode);
        const content = childByLocal(np, 'content');
        const src = content ? content.getAttribute('src') : '';
        out.push({ path: resolvePath(base, src), label: label || '未命名章节', level: level });
        walk(np, Math.min(level + 1, 2));
      }
    };
    if (navMaps.length) walk(navMaps[0], 0);
    return out;
  }
  function readTocNav(text, base) {
    const doc = new DOMParser().parseFromString(text, 'text/html'), out = [];
    let nav = null;
    const navs = doc.querySelectorAll('nav');
    for (let i = 0; i < navs.length; i++) {
      const type = (navs[i].getAttribute('epub:type') || '') + ' ' + (navs[i].getAttribute('id') || '');
      if (/toc/i.test(type)) { nav = navs[i]; break; }
    }
    if (!nav && navs.length) nav = navs[0];
    if (!nav) return out;
    nav.querySelectorAll('a[href]').forEach((a) => {
      let level = 0, p = a.parentElement;
      while (p && p !== nav) { if (p.tagName === 'LI') level++; p = p.parentElement; }
      out.push({ path: resolvePath(base, a.getAttribute('href')), label: textOf(a) || '未命名章节', level: clamp(level - 1, 0, 2) });
    });
    return out;
  }

  async function parseEpub(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    let opfPath = '';
    const container = findFile(zip, 'META-INF/container.xml');
    if (container) {
      const cdoc = parseXML(await container.async('string'));
      const roots = nodesByLocal(cdoc, 'rootfile');
      if (roots.length) opfPath = roots[0].getAttribute('full-path') || '';
    }
    if (!opfPath) {
      const opfKey = Object.keys(zip.files).find((k) => /\.opf$/i.test(k));
      opfPath = opfKey || '';
    }
    const opfFile = findFile(zip, opfPath);
    if (!opfFile) throw new Error('未找到 OPF 文件，可能不是标准 EPUB');
    const opfDoc = parseXML(await opfFile.async('string'));

    const title = textOf(nodesByLocal(opfDoc, 'title')[0]) || '未命名书籍';
    const creator = nodesByLocal(opfDoc, 'creator').map(textOf).filter(Boolean);
    const author = creator.length ? creator.join('、') : '';

    const manifestNodes = nodesByLocal(opfDoc, 'manifest')[0];
    const items = {};
    if (manifestNodes) {
      for (let i = 0; i < manifestNodes.children.length; i++) {
        const it = manifestNodes.children[i];
        if ((it.localName || it.nodeName).toLowerCase() !== 'item') continue;
        const id = it.getAttribute('id') || '';
        items[id] = { id: id, href: it.getAttribute('href') || '', type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' };
      }
    }
    const spineNodes = nodesByLocal(opfDoc, 'spine')[0];
    const spine = [];
    if (spineNodes) {
      for (let i = 0; i < spineNodes.children.length; i++) {
        const ir = spineNodes.children[i];
        if ((ir.localName || ir.nodeName).toLowerCase() !== 'itemref') continue;
        if ((ir.getAttribute('linear') || 'yes') === 'no') continue;
        const it = items[ir.getAttribute('idref')];
        if (it && it.href) spine.push(it);
      }
    }
    if (!spine.length) Object.keys(items).forEach((k) => { if (/xhtml|html/i.test(items[k].type)) spine.push(items[k]); });
    if (!spine.length) throw new Error('未找到可阅读的章节');

    // table of contents
    let toc = [];
    const navItem = Object.keys(items).find((k) => /\bnav\b/.test(items[k].props));
    const ncxItem = Object.keys(items).find((k) => /ncx/i.test(items[k].type) || /\.ncx$/i.test(items[k].href));
    if (navItem) {
      const f = findFile(zip, resolvePath(opfPath, items[navItem].href));
      if (f) toc = readTocNav(await f.async('string'), resolvePath(opfPath, items[navItem].href));
    }
    if (!toc.length && ncxItem) {
      const f = findFile(zip, resolvePath(opfPath, items[ncxItem].href));
      if (f) toc = readTocNCX(await f.async('string'), resolvePath(opfPath, items[ncxItem].href));
    }
    const tocMap = {};
    toc.forEach((t) => { if (t.path && !tocMap[t.path]) tocMap[t.path] = { label: t.label, level: t.level }; });

    const chapters = spine.map((it, i) => {
      const path = resolvePath(opfPath, it.href);
      const t = tocMap[path];
      return { path: path, title: t ? t.label : '第 ' + (i + 1) + ' 章', level: t ? t.level : 0 };
    });

    // cover
    let cover = '';
    const metaEls = nodesByLocal(opfDoc, 'meta');
    let coverId = '';
    for (let i = 0; i < metaEls.length; i++) {
      if ((metaEls[i].getAttribute('name') || '').toLowerCase() === 'cover') coverId = metaEls[i].getAttribute('content') || '';
    }
    let coverItem = items[coverId];
    if (!coverItem) coverItem = Object.keys(items).map((k) => items[k]).find((it) =>
      /^image\//.test(it.type) && (/cover/i.test(it.id) || /cover/i.test(it.href) || /cover-image/.test(it.props)));
    if (coverItem) {
      const f = findFile(zip, resolvePath(opfPath, coverItem.href));
      if (f) {
        try {
          const b64 = await f.async('base64');
          if (b64.length < 2200000) {
            const mime = coverItem.type || ('image/' + (coverItem.href.split('.').pop() || 'jpeg').replace(/jpg/i, 'jpeg'));
            cover = 'data:' + mime + ';base64,' + b64;
          }
        } catch (e) {}
      }
    }
    return { zip: zip, opfPath: opfPath, title: title, author: author, cover: cover, chapters: chapters };
  }

  /* ---------------- chapter rendering ---------------- */
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', css: 'text/css', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' };
  const mimeOf = (p) => MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

  const state = {
    book: null, record: null, chapter: 0, paragraphs: [], assets: [],
    cache: new Map(), currentPara: -1
  };

  function releaseAssets() {
    state.assets.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) {} });
    state.assets = [];
  }
  async function assetURL(book, path) {
    if (/^(data|blob|https?):/i.test(path)) return path;
    const f = findFile(book.zip, path);
    if (!f) return '';
    try {
      const buf = await f.async('arraybuffer');
      const url = URL.createObjectURL(new Blob([buf], { type: mimeOf(path) }));
      state.assets.push(url);
      return url;
    } catch (e) { return ''; }
  }
  async function rewriteCSS(book, cssText, base) {
    const matches = cssText.match(/url\(([^)]*)\)/g) || [];
    let out = cssText;
    for (const m of Array.from(new Set(matches))) {
      const raw = m.slice(4, -1).trim().replace(/^["']|["']$/g, '');
      if (!raw || /^(data|blob|https?):/i.test(raw)) continue;
      const u = await assetURL(book, resolvePath(base, raw));
      if (u) out = out.split(m).join('url(' + u + ')');
    }
    return out;
  }
  async function inlineStyles(book, doc, chapterPath) {
    const links = Array.from(doc.querySelectorAll('link[rel~="stylesheet"], link[href$=".css"]'));
    for (const link of links) {
      const href = link.getAttribute('href');
      const p = resolvePath(chapterPath, href);
      const f = findFile(book.zip, p);
      if (!f) { link.remove(); continue; }
      try {
        const css = await f.async('string');
        const style = doc.createElement('style');
        style.textContent = await rewriteCSS(book, css, p);
        link.parentNode.replaceChild(style, link);
      } catch (e) { link.remove(); }
    }
    const styles = Array.from(doc.querySelectorAll('style'));
    for (const s of styles) s.textContent = await rewriteCSS(book, s.textContent || '', chapterPath);
  }
  async function renderChapterHtml(book, chapterPath) {
    const f = findFile(book.zip, chapterPath);
    if (!f) throw new Error('章节文件缺失：' + chapterPath);
    const raw = await f.async('string');
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    await inlineStyles(book, doc, chapterPath);

    const drop = 'script,iframe,object,embed,video,audio,form,input,button,meta,base,link,math';
    doc.querySelectorAll(drop).forEach((n) => n.remove());
    const body = doc.body;
    body.querySelectorAll('*').forEach((n) => {
      Array.from(n.attributes).forEach((a) => {
        const nm = a.name.toLowerCase(), v = a.value || '';
        if (nm.indexOf('on') === 0 || /^\s*javascript:/i.test(v)) n.removeAttribute(a.name);
        else if (nm === 'style' && /url\(/i.test(v)) n.setAttribute('style', v.replace(/url\([^)]*\)/gi, 'none'));
      });
    });

    const imgs = Array.from(body.querySelectorAll('img[src], source[src]')).concat(
      Array.from(body.querySelectorAll('image')).filter((n) => n.hasAttribute('href') || n.hasAttribute('xlink:href'))
    );
    for (const im of imgs) {
      const attr = im.hasAttribute('src') ? 'src' : (im.hasAttribute('href') ? 'href' : 'xlink:href');
      const src = im.getAttribute(attr);
      if (!src || /^(data|blob):/i.test(src)) continue;
      if (/^https?:/i.test(src)) { im.setAttribute(attr, src); continue; }
      const u = await assetURL(book, resolvePath(chapterPath, src));
      if (u) im.setAttribute(attr, u);
    }
    // Stylesheets were inlined into <head>; move them into <body> so they survive.
    Array.from(doc.querySelectorAll('style')).forEach((s) => {
      if (!body.contains(s)) body.insertBefore(s, body.firstChild);
    });
    return body.innerHTML;
  }

  const BLOCK_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,dd,dt,div,section,article,td,th,figcaption,pre,ul,ol,table,figure,aside,header,footer';
  const LEAF_SEL = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,dd,dt,div,section,article,td,th,figcaption,pre';
  function collectParagraphs(root) {
    const out = [];
    root.querySelectorAll(LEAF_SEL).forEach((n) => {
      if (n.querySelector(BLOCK_SEL)) return;
      if (n.closest('nav, header.ignore, [hidden]')) return;
      const text = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 2) return;
      n.classList.add('vr-para');
      n.setAttribute('data-para', String(out.length));
      out.push({ el: n, text: text });
    });
    return out;
  }

  /* ---------------- speech engine ---------------- */
  const speech = {
    synth: window.speechSynthesis || null, voices: [], playing: false, queue: [], qi: 0,
    sleepAt: 0, watchdog: null, keepAlive: null, tick: null, wakeLock: null, token: 0
  };

  function voiceQuality(v) {
    const s = (v.name + ' ' + v.lang).toLowerCase();
    let score = 0;
    if (/siri|enhanced|premium|增强|优质|neural/.test(s)) score += 100;
    if (/zh[-_]?cn|cmn|mandarin|普通话/.test(s)) score += 30;
    if (/zh|cmn|yue|chinese/.test(s)) score += 10;
    if (v.localService) score += 5;
    return score;
  }
  function chineseVoices() {
    return speech.voices.filter((v) => /^(zh|cmn|yue|wuu|hak)/i.test(v.lang) ||
      /chinese|中文|普通话|ting|sin|mei|siri/i.test(v.name)).sort((a, b) => voiceQuality(b) - voiceQuality(a));
  }
  function refreshVoices() {
    if (!speech.synth) return;
    const list = speech.synth.getVoices() || [];
    if (list.length) speech.voices = Array.from(list);
    const zh = chineseVoices();
    $('voiceCount').textContent = zh.length ? '检测到 ' + zh.length + ' 个中文音色' : '未检测到，将使用系统默认';
    const sel = $('voiceSelect');
    sel.innerHTML = '<option value="">系统默认（自动挑选最佳中文音色）</option>' +
      zh.map((v) => '<option value="' + esc(v.voiceURI) + '">' + esc(v.name) + ' · ' + esc(v.lang) +
        (voiceQuality(v) >= 100 ? ' · 增强' : '') + '</option>').join('');
    sel.value = settings.voiceURI && zh.some((v) => v.voiceURI === settings.voiceURI) ? settings.voiceURI : '';
    const label = $('voiceToolLabel');
    if (label) label.textContent = zh.length ? '音色 · ' + zh.length : '音色';
  }
  function pickVoice() {
    const zh = chineseVoices();
    if (settings.voiceURI) {
      const hit = speech.voices.find((v) => v.voiceURI === settings.voiceURI);
      if (hit) return hit;
    }
    return zh[0] || null;
  }
  function splitText(text, max) {
    max = max || 64;
    const out = []; let cur = '';
    for (const ch of text) {
      cur += ch;
      if (/[。！？!?；;…\n，,、]/.test(ch) && cur.length >= 26) { out.push(cur); cur = ''; }
      else if (cur.length >= max) {
        let idx = Math.max(cur.lastIndexOf('，'), cur.lastIndexOf(','), cur.lastIndexOf('、'), cur.lastIndexOf(' '));
        if (idx > max * 0.45) { out.push(cur.slice(0, idx + 1)); cur = cur.slice(idx + 1); }
        else { out.push(cur); cur = ''; }
      }
    }
    if (cur.trim()) out.push(cur);
    return out.filter((s) => s.trim());
  }
  function buildQueue(fromPara) {
    const q = [];
    for (let i = fromPara; i < state.paragraphs.length; i++) {
      splitText(state.paragraphs[i].text).forEach((t) => q.push({ para: i, text: t }));
    }
    return q;
  }
  function highlight(para) {
    if (state.currentPara >= 0 && state.paragraphs[state.currentPara]) state.paragraphs[state.currentPara].el.classList.remove('speaking');
    state.currentPara = para;
    const p = state.paragraphs[para];
    if (!p) return;
    p.el.classList.add('speaking');
    const pct = Math.round((para + 1) / state.paragraphs.length * 100);
    $('paraProgress').style.width = pct + '%';
    $('paraProgressText').textContent = '朗读中 · 第 ' + (para + 1) + ' / ' + state.paragraphs.length + ' 段';
    if (settings.autoScroll) {
      const sc = $('readerScroller'), r = p.el.getBoundingClientRect(), sr = sc.getBoundingClientRect();
      sc.scrollTo({ top: sc.scrollTop + r.top - sr.top - sc.clientHeight * 0.34, behavior: 'smooth' });
    }
    saveCurrentProgress();
  }
  function clearWatchdog() { if (speech.watchdog) { clearTimeout(speech.watchdog); speech.watchdog = null; } }
  function speakNext() {
    if (!speech.playing || !speech.synth) return;
    if (speech.qi >= speech.queue.length) { onQueueEnd(); return; }
    const item = speech.queue[speech.qi];
    const u = new SpeechSynthesisUtterance(item.text);
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'zh-CN'; }
    u.rate = clamp(settings.rate, 0.5, 2);
    u.pitch = clamp(settings.pitch, 0.7, 1.4);
    u.volume = 1;
    const token = ++speech.token;
    const advance = () => {
      if (!speech.playing || token !== speech.token) return;
      clearWatchdog(); speech.qi += 1;
      setTimeout(() => { if (speech.playing && token === speech.token) speakNext(); }, 70);
    };
    u.onend = advance;
    u.onerror = (e) => {
      if (!speech.playing || token !== speech.token) return;
      if (e && /interrupted|canceled|cancelled/i.test(e.error || '')) return;
      advance();
    };
    highlight(item.para);
    try { speech.synth.speak(u); }
    catch (e) { stopSpeech(); toast('朗读启动失败，请检查系统语音设置'); return; }
    // iOS Safari occasionally drops onend; force-advance if a chunk never reports back.
    const estimate = clamp(item.text.length / (settings.rate * 3.5) * 1000 + 5000, 5000, 40000);
    const expectedQi = speech.qi;
    clearWatchdog();
    speech.watchdog = setTimeout(() => {
      if (!speech.playing || token !== speech.token || speech.qi !== expectedQi) return;
      clearWatchdog(); speech.qi += 1; speakNext();
    }, estimate);
  }
  function onQueueEnd() {
    if (!speech.playing) return;
    if (settings.autoNext && state.chapter + 1 < state.book.chapters.length) {
      toast('下一章');
      loadChapter(state.chapter + 1, true).then(() => { if (speech.playing) startFrom(0); });
    } else {
      stopSpeech();
      $('playerStatus').textContent = '已读完';
      toast('本书已读完');
    }
  }
  function setPlayIcon(playing) {
    const use = $('playBtn').querySelector('use');
    use.setAttribute('href', playing ? '#i-pause' : '#i-play');
    $('playBtn').classList.toggle('playing', playing);
    $('playBtn').setAttribute('aria-label', playing ? '暂停' : '播放');
  }
  function requestWake() {
    if (!settings.wakeLock || !('wakeLock' in navigator)) return;
    try {
      navigator.wakeLock.request('screen').then((w) => { speech.wakeLock = w; }).catch(() => {});
    } catch (e) {}
  }
  function releaseWake() {
    try { if (speech.wakeLock) speech.wakeLock.release(); } catch (e) {}
    speech.wakeLock = null;
  }
  function setSleepTimer() {
    clearInterval(speech.tick);
    speech.sleepAt = settings.timerMin ? Date.now() + settings.timerMin * 60000 : 0;
    if (!settings.timerMin) { $('sleepCountdown').textContent = ''; return; }
    speech.tick = setInterval(() => {
      const left = speech.sleepAt - Date.now();
      if (left <= 0) { stopSpeech(); toast('定时结束，已停止朗读'); $('playerStatus').textContent = '定时结束'; return; }
      const m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
      $('sleepCountdown').textContent = '定时 ' + m + ':' + String(s).padStart(2, '0');
    }, 1000);
  }
  function startSpeechHooks() {
    requestWake();
    setSleepTimer();
    clearInterval(speech.keepAlive);
    speech.keepAlive = setInterval(() => {
      if (speech.playing && speech.synth && !speech.synth.paused) { try { speech.synth.resume(); } catch (e) {} }
    }, 9000);
  }
  function startFrom(para) {
    if (!speech.synth) { toast('当前浏览器不支持语音合成'); return; }
    if (!state.paragraphs.length) { toast('本章没有可朗读的文字'); return; }
    refreshVoices();
    stopTimersOnly();
    try { speech.synth.cancel(); } catch (e) {}
    speech.playing = true;
    speech.queue = buildQueue(clamp(para, 0, state.paragraphs.length - 1));
    speech.qi = 0;
    setPlayIcon(true);
    $('playerStatus').textContent = '正在朗读';
    startSpeechHooks();
    // iOS Safari needs a short gap after cancel() before a fresh utterance.
    setTimeout(() => { if (speech.playing) speakNext(); }, 130);
  }
  function stopTimersOnly() {
    speech.token += 1; // invalidate callbacks from cancelled utterances
    clearWatchdog(); clearInterval(speech.keepAlive); clearInterval(speech.tick);
    speech.tick = null; speech.keepAlive = null;
  }
  function stopSpeech() {
    speech.playing = false;
    stopTimersOnly();
    try { if (speech.synth) speech.synth.cancel(); } catch (e) {}
    releaseWake();
    setPlayIcon(false);
    $('sleepCountdown').textContent = '';
    clearHighlight();
    saveCurrentProgress();
  }
  function pauseSpeech() {
    if (!speech.playing) return;
    speech.playing = false;
    stopTimersOnly();
    try { if (speech.synth) speech.synth.cancel(); } catch (e) {}
    releaseWake();
    setPlayIcon(false);
    $('playerStatus').textContent = '已暂停';
    $('sleepCountdown').textContent = '';
    saveCurrentProgress();
  }
  function clearHighlight() {
    if (state.currentPara >= 0 && state.paragraphs[state.currentPara]) state.paragraphs[state.currentPara].el.classList.remove('speaking');
  }
  function toggleSpeech() {
    if (speech.playing) { pauseSpeech(); return; }
    if (speech.queue.length && speech.qi < speech.queue.length) {
      speech.playing = true; setPlayIcon(true); $('playerStatus').textContent = '正在朗读'; startSpeechHooks(); speakNext();
    } else startFrom(state.currentPara >= 0 ? state.currentPara : 0);
  }

  /* ---------------- progress ---------------- */
  let saveTimer = null;
  function saveCurrentProgress() {
    if (!state.record) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const pct = state.book && state.book.chapters.length > 1
        ? Math.round((state.chapter + (state.paragraphs.length ? (state.currentPara + 1) / state.paragraphs.length : 0)) / state.book.chapters.length * 100)
        : (state.paragraphs.length ? Math.round((state.currentPara + 1) / state.paragraphs.length * 100) : 0);
      progressMap[state.record.id] = {
        chapter: state.chapter, para: state.currentPara,
        scroll: $('readerScroller').scrollTop, pct: clamp(pct, 0, 100), t: Date.now()
      };
      saveProgressMap();
      try { localStorage.setItem('vr.lastBook', state.record.id); } catch (e) {}
    }, 350);
  }

  /* ---------------- views ---------------- */
  function switchView(name) {
    $('shelfView').classList.toggle('active', name === 'shelf');
    $('settingsView').classList.toggle('active', name === 'settings');
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === name));
    (name === 'shelf' ? $('shelfView') : $('settingsView')).scrollTop = 0;
  }
  function openReader() {
    $('readerView').hidden = false;
    $('tabbar').hidden = true;
    document.body.style.overflow = 'hidden';
    applyReadingStyle();
  }
  function closeReader() {
    stopSpeech();
    $('readerView').hidden = true;
    $('tabbar').hidden = false;
    document.body.style.overflow = '';
    closeAllMasks();
    releaseAssets();
    state.book = null; state.record = null; state.paragraphs = []; state.currentPara = -1;
    renderShelf();
  }
  function closeAllMasks() {
    ['tocMask', 'sheetMask'].forEach((id) => { $(id).hidden = true; });
  }

  async function loadChapter(index, keepPlaying) {
    if (!state.book) return;
    const wasPlaying = keepPlaying && speech.playing;
    stopTimersOnly();
    if (speech.synth) { try { speech.synth.cancel(); } catch (e) {} }
    if (!keepPlaying) stopSpeech();
    clearWatchdog();
    clearHighlight();
    releaseAssets();
    const chap = state.book.chapters[index];
    if (!chap) return;
    state.chapter = index;
    loading('正在排版…');
    try {
      const html = await renderChapterHtml(state.book, chap.path);
      $('readerContent').innerHTML = html;
      state.paragraphs = collectParagraphs($('readerContent'));
      $('readerScroller').scrollTop = 0;
      $('chapterIndicator').textContent = (index + 1) + ' / ' + state.book.chapters.length;
      $('tocSub').textContent = state.book.title + ' · 共 ' + state.book.chapters.length + ' 章';
      $('chapterEnd').hidden = false;
      $('nextChapterBtn').hidden = index >= state.book.chapters.length - 1;
      $('chapterEndText').textContent = index >= state.book.chapters.length - 1 ? '全书完' : '本章完';
      $('paraProgress').style.width = '0%';
      $('paraProgressText').textContent = state.paragraphs.length
        ? '共 ' + state.paragraphs.length + ' 段 · 点击任意段落开始朗读' : '本章暂无文字，可翻到下一章';
      state.currentPara = -1;
      buildToc();
      saveCurrentProgress();
    } catch (e) {
      toast('章节读取失败：' + (e.message || '未知错误'), 3200);
      $('readerContent').innerHTML = '<p class="chap-title">章节内容无法读取</p><p>' + esc(e.message || '') + '</p>';
      state.paragraphs = [];
    }
    loaded();
    if (wasPlaying) startFrom(0);
  }

  function buildToc() {
    $('tocList').innerHTML = state.book.chapters.map((c, i) =>
      '<button class="toc-item' + (c.level ? ' indent' : '') + (i === state.chapter ? ' on' : '') + '" data-chapter="' + i + '">' +
      esc(c.title) + '</button>').join('');
  }

  async function openBook(id, autoPlay) {
    loading('正在打开书籍…');
    try {
      const d = await db();
      let rec;
      if (!d) rec = memBooks.get(id);
      else rec = await new Promise((res, rej) => {
        const r = d.transaction('books', 'readonly').objectStore('books').get(id);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      if (!rec) throw new Error('书籍数据不存在，请重新导入');
      let parsed = state.cache.get(id);
      if (!parsed) { parsed = await parseEpub(rec.buf); state.cache.set(id, parsed); }
      state.record = rec; state.book = parsed;
      $('readerBookTitle').textContent = rec.title;
      const pr = progressMap[id] || { chapter: 0, para: -1, scroll: 0 };
      const idx = clamp(pr.chapter || 0, 0, parsed.chapters.length - 1);
      openReader();
      await loadChapter(idx, false);
      if (pr.scroll) setTimeout(() => { $('readerScroller').scrollTop = pr.scroll; }, 120);
      if (autoPlay) setTimeout(() => startFrom(clamp(pr.para >= 0 ? pr.para : 0, 0, Math.max(0, state.paragraphs.length - 1))), 260);
      loaded();
    } catch (e) {
      loaded(); toast('打开失败：' + (e.message || e), 3200);
    }
  }

  /* ---------------- shelf ---------------- */
  async function renderShelf() {
    const books = (await allBooks()) || [];
    books.sort((a, b) => (progressMap[b.id] ? progressMap[b.id].t || 0 : b.addedAt) - (progressMap[a.id] ? progressMap[a.id].t || 0 : a.addedAt));
    $('emptyState').hidden = books.length > 0;
    $('gridTitle').hidden = books.length === 0;
    $('bookCount').textContent = books.length ? '· ' + books.length + ' 本' : '';
    $('shelfSubtitle').textContent = books.length ? '共 ' + books.length + ' 本 · 全部保存在本机' : '把书装进口袋，用耳朵读完';

    $('shelfGrid').innerHTML = books.map((b) => {
      const pr = progressMap[b.id];
      const pct = pr ? pr.pct : 0;
      const cover = b.cover
        ? '<img src="' + esc(b.cover) + '" alt=""><span class="cover-shade"></span>'
        : '<span>' + esc((b.title || '书').slice(0, 1)) + '</span><span class="cover-shade"></span>';
      return '<div class="book-card" data-id="' + esc(b.id) + '">' +
        '<button class="book-del" data-del="' + esc(b.id) + '" aria-label="删除"><svg><use href="#i-trash"/></svg></button>' +
        '<div class="book-cover">' + cover + '</div>' +
        '<div class="book-name">' + esc(b.title) + '</div>' +
        '<div class="book-author">' + esc(b.author || '未知作者') + '</div>' +
        '<div class="book-bar"><i style="width:' + pct + '%"></i></div></div>';
    }).join('');

    const lastId = (() => { try { return localStorage.getItem('vr.lastBook'); } catch (e) { return null; } })();
    const last = books.find((b) => b.id === lastId && progressMap[b.id]) || books.find((b) => progressMap[b.id]);
    const card = $('continueCard');
    if (last) {
      card.hidden = false;
      const pr = progressMap[last.id];
      $('continueCover').style.backgroundImage = last.cover ? 'url(' + last.cover + ')' : '';
      $('continueTitle').textContent = last.title;
      $('continueMeta').textContent = (pr.pct || 0) + '% · ' + (last.author || '继续上次进度') + ' · ' + fmtDate(pr.t || last.addedAt);
      $('continueProgress').style.width = (pr.pct || 0) + '%';
      card.dataset.id = last.id;
    } else card.hidden = true;

    const total = books.reduce((s, b) => s + (b.size || 0), 0);
    $('storageInfo').textContent = books.length + ' 本 · ' + fmtSize(total);
    if (!dbOK) toast('本机数据库不可用，书籍仅保留在本次会话');
  }

  async function importFiles(files) {
    const list = Array.from(files).filter((f) => /\.epub$/i.test(f.name) || /epub/.test(f.type));
    if (!list.length) { toast('请选择 .epub 格式的电子书'); return; }
    for (const f of list) {
      loading('正在导入《' + f.name.replace(/\.epub$/i, '') + '》…');
      try {
        const buf = await readFileBuffer(f);
        const parsed = await parseEpub(buf);
        const rec = {
          id: uid(), title: parsed.title, author: parsed.author, cover: parsed.cover,
          buf: buf, size: buf.byteLength || buf.length, addedAt: Date.now(), fileName: f.name
        };
        await putBook(rec);
        state.cache.set(rec.id, parsed);
        toast('《' + parsed.title + '》已加入书架');
      } catch (e) {
        toast('导入失败：' + (e.message || e), 3500);
      }
    }
    loaded();
    await renderShelf();
  }

  /* ---------------- settings / sheets ---------------- */
  function applyReadingStyle() {
    const rv = $('readerView');
    rv.style.setProperty('--read-font', settings.fontSize + 'px');
    rv.style.setProperty('--read-lh', String(settings.lineHeight));
    rv.dataset.readerTheme = settings.theme;
  }
  function syncSettingsUI() {
    $('rateRange').value = settings.rate; $('rateValue').textContent = Number(settings.rate).toFixed(2).replace(/0$/, '') + '×';
    $('pitchRange').value = settings.pitch; $('pitchValue').textContent = Number(settings.pitch).toFixed(2).replace(/0$/, '');
    $('fontRange').value = settings.fontSize; $('fontValue').textContent = settings.fontSize + 'px';
    $('autoScrollToggle').checked = !!settings.autoScroll;
    $('autoNextToggle').checked = !!settings.autoNext;
    $('wakeLockToggle').checked = !!settings.wakeLock;
    $('rateToolLabel').textContent = '语速 ' + Number(settings.rate).toFixed(2).replace(/0$/, '') + '×';
    $('timerToolLabel').textContent = settings.timerMin ? '定时 ' + settings.timerMin + '分' : '定时';
    $('timerToolBtn').classList.toggle('on', !!settings.timerMin);
    document.querySelectorAll('#lineHeightSeg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.value) === settings.lineHeight));
    document.querySelectorAll('#themePicker button').forEach((b) => b.classList.toggle('on', b.dataset.theme === settings.theme));
    applyReadingStyle();
  }
  function previewVoice() {
    if (!speech.synth) return;
    refreshVoices();
    const u = new SpeechSynthesisUtterance('你好，这是语音试听。今天，我们一起安静地读一本好书。');
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'zh-CN';
    u.rate = settings.rate; u.pitch = settings.pitch;
    speech.synth.cancel(); speech.synth.speak(u);
  }
  function openSheet(kind) {
    const body = $('sheetBody');
    if (kind === 'voice') {
      $('sheetTitle').textContent = '选择音色';
      const zh = chineseVoices();
      body.innerHTML = '<button class="voice-opt' + (settings.voiceURI ? '' : ' on') + '" data-voice=""><span><span class="vname">系统默认（自动挑选最佳）</span><span class="vtag">优先使用增强 / Siri 中文语音</span></span>' + (settings.voiceURI ? '' : '<svg><use href="#i-check"/></svg>') + '</button>' +
        (zh.length ? zh.map((v) => '<button class="voice-opt' + (settings.voiceURI === v.voiceURI ? ' on' : '') + '" data-voice="' + esc(v.voiceURI) + '"><span><span class="vname">' + esc(v.name) + (voiceQuality(v) >= 100 ? ' · 增强' : '') + '</span><span class="vtag">' + esc(v.lang) + ' · ' + (v.localService ? '本机语音，离线可用' : '在线语音') + '</span></span>' + (settings.voiceURI === v.voiceURI ? '<svg><use href="#i-check"/></svg>' : '') + '</button>').join('')
          : '<div class="tip-box" style="margin:12px 0">暂未检测到中文语音。请在 iPhone「设置 → 辅助功能 → 朗读内容 → 声音 → 中文」下载语音后，回到设置页点「重新检测」。</div>') +
        '<div class="setting-line"><span>语速</span><span class="row-value">' + settings.rate.toFixed(2) + '×</span></div>' +
        '<div class="range-block"><div class="range-label"><span>0.5×</span><span>2.0×</span></div><input type="range" id="sheetRate" min="0.5" max="2" step="0.05" value="' + settings.rate + '"></div>' +
        '<button class="btn-soft" id="sheetPreview" style="width:100%;justify-content:center;margin-top:6px">试听一句</button>';
    } else if (kind === 'rate') {
      $('sheetTitle').textContent = '朗读速度';
      const opts = [0.75, 0.9, 1, 1.15, 1.35, 1.6];
      body.innerHTML = '<div class="range-block" style="border:0"><div class="range-label"><span>慢速细读</span><span id="sheetRateVal">' + settings.rate.toFixed(2) + '×</span></div><input type="range" id="sheetRate" min="0.5" max="2" step="0.05" value="' + settings.rate + '"></div>' +
        '<div class="timer-grid" style="grid-template-columns:repeat(3,1fr)">' + opts.map((o) => '<button data-rate="' + o + '" class="' + (Math.abs(o - settings.rate) < 0.01 ? 'on' : '') + '">' + o.toFixed(2).replace(/0$/, '') + '×</button>').join('') + '</div>' +
        '<div class="tip-box">中文朗读建议 0.9×–1.2×；长句会自动断句，减少 iOS 语音被系统截断的情况。</div>';
    } else if (kind === 'timer') {
      $('sheetTitle').textContent = '睡眠定时';
      const opts = [[0, '关闭'], [15, '15 分钟'], [30, '30 分钟'], [45, '45 分钟'], [60, '60 分钟'], [90, '90 分钟']];
      body.innerHTML = '<div class="timer-grid" style="grid-template-columns:repeat(3,1fr)">' + opts.map((o) => '<button data-timer="' + o[0] + '" class="' + (settings.timerMin === o[0] ? 'on' : '') + '">' + o[1] + '</button>').join('') + '</div>' +
        '<div class="tip-box">定时从下一次开始朗读时生效；朗读中修改会立即重新计时。</div>';
    } else {
      $('sheetTitle').textContent = '阅读排版';
      body.innerHTML = '<div class="range-block" style="border:0"><div class="range-label"><span>字号</span><span id="sheetFontVal">' + settings.fontSize + 'px</span></div><input type="range" id="sheetFont" min="15" max="28" step="1" value="' + settings.fontSize + '"></div>' +
        '<div class="setting-line"><span>行距</span></div><div class="segmented" id="sheetLh">' + [[1.6, '紧凑'], [1.9, '标准'], [2.2, '宽松']].map((o) => '<button data-lh="' + o[0] + '" class="' + (settings.lineHeight === o[0] ? 'on' : '') + '">' + o[1] + '</button>').join('') + '</div>' +
        '<div class="setting-line"><span>背景</span></div><div class="themes" id="sheetThemes">' + [['paper', '米黄'], ['white', '纯白'], ['green', '护眼'], ['dark', '夜间']].map((o) => '<button data-theme="' + o[0] + '" class="theme-dot ' + o[0] + (settings.theme === o[0] ? ' on' : '') + '" title="' + o[1] + '"></button>').join('') + '</div>';
    }
    $('sheetMask').hidden = false;
    $('sheetMask').dataset.kind = kind;
  }

  /* ---------------- events ---------------- */
  function bind() {
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
    $('importBtn').addEventListener('click', () => $('fileInput').click());
    $('emptyImportBtn').addEventListener('click', () => $('fileInput').click());
    $('sampleBtn').addEventListener('click', async () => {
      loading('正在载入示例书…');
      try {
        const res = await fetch('./sample.epub');
        if (!res.ok) throw new Error('示例文件不可用');
        const blob = await res.blob();
        const file = new File([blob], '雨后的车站.epub', { type: 'application/epub+zip' });
        await importFiles([file]);
      } catch (e) { loaded(); toast('示例载入失败：' + (e.message || e), 3000); }
    });
    $('fileInput').addEventListener('change', (e) => { importFiles(e.target.files); e.target.value = ''; });
    $('shelfView').addEventListener('dragover', (e) => e.preventDefault());
    $('shelfView').addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });

    $('shelfGrid').addEventListener('click', (e) => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const id = del.dataset.del;
        if (!confirm('从书架移除这本书？阅读进度也会一并删除。')) return;
        delBook(id).then(() => {
          state.cache.delete(id); delete progressMap[id]; saveProgressMap();
          toast('已移除'); renderShelf();
        });
        return;
      }
      const card = e.target.closest('.book-card');
      if (card) openBook(card.dataset.id, false);
    });
    $('continuePlay').addEventListener('click', () => openBook($('continueCard').dataset.id, true));
    $('continueCard').addEventListener('click', (e) => { if (e.target.closest('#continuePlay')) return; openBook($('continueCard').dataset.id, false); });

    $('backBtn').addEventListener('click', closeReader);
    $('tocBtn').addEventListener('click', () => { $('tocMask').hidden = false; });
    $('aaBtn').addEventListener('click', () => openSheet('aa'));
    $('tocList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-chapter]');
      if (!b) return;
      $('tocMask').hidden = true;
      loadChapter(Number(b.dataset.chapter), false);
    });
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { $(b.dataset.close).hidden = true; }));
    document.querySelectorAll('.mask').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));

    $('prevChapterBtn').addEventListener('click', () => { if (state.chapter > 0) loadChapter(state.chapter - 1, false); });
    $('nextChapterBtn').addEventListener('click', () => { if (state.chapter + 1 < state.book.chapters.length) loadChapter(state.chapter + 1, false); });
    $('nextChapterBtn2').addEventListener('click', () => { if (state.chapter + 1 < state.book.chapters.length) loadChapter(state.chapter + 1, false); });
    $('readerContent').addEventListener('click', (e) => {
      if (window.getSelection && String(window.getSelection()).trim()) return;
      const p = e.target.closest('.vr-para');
      if (p) startFrom(Number(p.getAttribute('data-para')));
    });
    $('readerScroller').addEventListener('scroll', () => { if (state.record) saveCurrentProgress(); }, { passive: true });

    $('playBtn').addEventListener('click', toggleSpeech);
    $('prevParaBtn').addEventListener('click', () => startFrom(Math.max(0, state.currentPara - 1)));
    $('nextParaBtn').addEventListener('click', () => startFrom(Math.min(state.paragraphs.length - 1, state.currentPara + 1)));
    $('voiceToolBtn').addEventListener('click', () => { refreshVoices(); openSheet('voice'); });
    $('rateToolBtn').addEventListener('click', () => openSheet('rate'));
    $('timerToolBtn').addEventListener('click', () => openSheet('timer'));

    $('voiceSelect').addEventListener('change', (e) => { settings.voiceURI = e.target.value; saveSettings(); });
    $('previewBtn').addEventListener('click', previewVoice);
    $('reloadVoicesBtn').addEventListener('click', () => {
      if (speech.synth) speech.synth.getVoices();
      refreshVoices(); setTimeout(refreshVoices, 600); toast('已重新检测中文语音');
    });
    $('rateRange').addEventListener('input', (e) => { settings.rate = Number(e.target.value); saveSettings(); syncSettingsUI(); });
    $('pitchRange').addEventListener('input', (e) => { settings.pitch = Number(e.target.value); saveSettings(); syncSettingsUI(); });
    $('fontRange').addEventListener('input', (e) => { settings.fontSize = Number(e.target.value); saveSettings(); syncSettingsUI(); });
    $('autoScrollToggle').addEventListener('change', (e) => { settings.autoScroll = e.target.checked; saveSettings(); });
    $('autoNextToggle').addEventListener('change', (e) => { settings.autoNext = e.target.checked; saveSettings(); });
    $('wakeLockToggle').addEventListener('change', (e) => { settings.wakeLock = e.target.checked; saveSettings(); });
    $('lineHeightSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-value]'); if (!b) return;
      settings.lineHeight = Number(b.dataset.value); saveSettings(); syncSettingsUI();
    });
    $('themePicker').addEventListener('click', (e) => {
      const b = e.target.closest('[data-theme]'); if (!b) return;
      settings.theme = b.dataset.theme; saveSettings(); syncSettingsUI();
    });
    $('clearBtn').addEventListener('click', () => {
      if (!confirm('确定清空所有本地书籍与阅读进度？此操作不可恢复。')) return;
      clearBooks().then(() => {
        memBooks.clear(); state.cache.clear(); progressMap = {};
        saveProgressMap(); try { localStorage.removeItem('vr.lastBook'); } catch (e) {}
        renderShelf(); toast('已清空');
      });
    });

    $('sheetBody').addEventListener('click', (e) => {
      const v = e.target.closest('[data-voice]');
      if (v) { settings.voiceURI = v.dataset.voice; saveSettings(); refreshVoices(); openSheet('voice'); return; }
      const r = e.target.closest('[data-rate]');
      if (r) { settings.rate = Number(r.dataset.rate); saveSettings(); syncSettingsUI(); openSheet('rate'); return; }
      const tm = e.target.closest('[data-timer]');
      if (tm) {
        settings.timerMin = Number(tm.dataset.timer); saveSettings(); syncSettingsUI();
        if (speech.playing) setSleepTimer();
        openSheet('timer'); return;
      }
      const lh = e.target.closest('[data-lh]');
      if (lh) { settings.lineHeight = Number(lh.dataset.lh); saveSettings(); syncSettingsUI(); openSheet('aa'); return; }
      const th = e.target.closest('[data-theme]');
      if (th) { settings.theme = th.dataset.theme; saveSettings(); syncSettingsUI(); openSheet('aa'); return; }
      if (e.target.closest('#sheetPreview')) previewVoice();
    });
    $('sheetBody').addEventListener('input', (e) => {
      if (e.target.id === 'sheetRate') {
        settings.rate = Number(e.target.value); saveSettings(); syncSettingsUI();
        const v = $('sheetRateVal'); if (v) v.textContent = settings.rate.toFixed(2) + '×';
      } else if (e.target.id === 'sheetFont') {
        settings.fontSize = Number(e.target.value); saveSettings(); syncSettingsUI();
        const v = $('sheetFontVal'); if (v) v.textContent = settings.fontSize + 'px';
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && speech.playing) { requestWake(); try { if (speech.synth) speech.synth.resume(); } catch (e) {} }
    });
    window.addEventListener('beforeunload', () => { try { if (speech.synth) speech.synth.cancel(); } catch (e) {} });
    document.addEventListener('keydown', (e) => {
      if ($('readerView').hidden) return;
      if (e.key === 'Escape') closeAllMasks();
      if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); toggleSpeech(); }
    });
  }

  /* ---------------- boot ---------------- */
  function boot() {
    bind();
    syncSettingsUI();
    applyReadingStyle();
    if (speech.synth) {
      refreshVoices();
      if ('onvoiceschanged' in speech.synth) speech.synth.onvoiceschanged = refreshVoices;
      setTimeout(refreshVoices, 400);
      setTimeout(refreshVoices, 1500);
    } else {
      $('voiceCount').textContent = '当前浏览器不支持语音合成';
    }
    renderShelf();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
    }
    if (/[?&]selftest=1/.test(location.search)) {
      window.__vr = { parseEpub: parseEpub, renderChapterHtml: renderChapterHtml,
        collectParagraphs: collectParagraphs, splitText: splitText, state: state };
    }
    // Small bridge used by the native WKWebView shell (harmless in a browser).
    window.VoiceReaderNative = {
      importFiles: importFiles,
      toggle: toggleSpeech,
      stop: stopSpeech,
      next: function () { if (state.paragraphs.length) startFrom(Math.min(state.paragraphs.length - 1, state.currentPara + 1)); },
      previous: function () { startFrom(Math.max(0, state.currentPara - 1)); },
      isPlaying: function () { return speech.playing; },
      remote: function (op) {
        if (op === 'play' && !speech.playing) toggleSpeech();
        else if (op === 'pause' && speech.playing) toggleSpeech();
        else if (op === 'next') this.next();
        else if (op === 'previous') this.previous();
      }
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
