/* AEEC — sayt skriptləri: menyu, dil seçimi, formalar, layihə filtri, kopyalama */
(function () {
  'use strict';
  /* ── FORMA AYARLARI ──────────────────────────────────────────────────
     FORM_EMAIL    — ehtiyat ünvan: server cavab vermədikdə ziyarətçinin e-poçt proqramında
                     bu ünvana hazır məktub açılır.
     FORM_ENDPOINT — idarəetmə panelinin API-si. Sorğu panelə yazılır (Sorğular bölməsi) və
                     bildiriş məktubu göndərilir. Server cavab vermirsə, forma avtomatik olaraq
                     ziyarətçinin e-poçt proqramında hazır məktub açır. Boş ('') qoyulsa, yalnız
                     e-poçt proqramı rejimi işləyir.
     STATS_ENDPOINT — ziyarət statistikası (kukisiz; boş qoyulsa, statistika toplanmır).
     ──────────────────────────────────────────────────────────────────── */
  var FORM_EMAIL = 'office@aeec.az';
  var FORM_ENDPOINT = '/api/public/form';
  var STATS_ENDPOINT = '/api/public/collect';

  var doc = document;
  var LANG = doc.documentElement.lang || 'az';
  var MSG = {
    az: { bad: 'Zəhmət olmasa işarələnmiş sahələri düzəldin.',
          req: 'Bu sahəni doldurun.', mailbad: 'Düzgün e-poçt ünvanı daxil edin.', consent: 'Davam etmək üçün razılığı təsdiqləyin.',
          sent: 'Təşəkkür edirik! Sorğunuz göndərildi — ən qısa zamanda sizinlə əlaqə saxlayacağıq.',
          mail: 'E-poçt proqramınızda hazır məktub açıldı — göndərmək üçün «Göndər» düyməsini basın. Açılmadısa, office@aeec.az ünvanına yazın və ya +994 50 362 30 38 nömrəsinə zəng edin.',
          fail: 'Sorğunu saytdan göndərmək alınmadı. E-poçt proqramınızda hazır məktub açılır; açılmasa, office@aeec.az ünvanına yazın və ya +994 50 362 30 38 nömrəsinə zəng edin.',
          copied: 'Kopyalandı: ' },
    en: { bad: 'Please correct the highlighted fields.',
          req: 'Please fill in this field.', mailbad: 'Please enter a valid e-mail address.', consent: 'Please confirm your consent to continue.',
          sent: 'Thank you! Your enquiry has been sent — we will get back to you as soon as possible.',
          mail: 'A ready-to-send message has opened in your e-mail app — press Send to deliver it. If nothing opened, write to office@aeec.az or call +994 50 362 30 38.',
          fail: 'The enquiry could not be sent from the website. A ready-to-send message is opening in your e-mail app; if it does not, write to office@aeec.az or call +994 50 362 30 38.',
          copied: 'Copied: ' },
    ru: { bad: 'Пожалуйста, исправьте отмеченные поля.',
          req: 'Заполните это поле.', mailbad: 'Укажите корректный адрес e-mail.', consent: 'Подтвердите согласие, чтобы продолжить.',
          sent: 'Спасибо! Ваш запрос отправлен — мы свяжемся с вами в кратчайшие сроки.',
          mail: 'В вашей почтовой программе открылось готовое письмо — нажмите «Отправить». Если письмо не открылось, напишите на office@aeec.az или позвоните по номеру +994 50 362 30 38.',
          fail: 'Не удалось отправить запрос с сайта. В почтовой программе откроется готовое письмо; если этого не произошло, напишите на office@aeec.az или позвоните по номеру +994 50 362 30 38.',
          copied: 'Скопировано: ' }
  };
  var T = MSG[LANG] || MSG.az;
  var T0 = Date.now();

  /* ── ziyarət statistikası (kukisiz) ──
     Brauzerdə yalnız bu sekmə üçün təsadüfi seans nömrəsi (sessionStorage) və ilk ziyarətin
     tarixi (localStorage) saxlanılır; IP ünvanı serverdə saxlanılmır. */
  (function () {
    if (!STATS_ENDPOINT || !window.JSON) return;
    var sid = null, ret = 0, utm = '', tz = '';
    try {
      sid = sessionStorage.getItem('aeec_sid');
      if (!sid) {
        var a = new Uint8Array(16); crypto.getRandomValues(a); sid = '';
        for (var i = 0; i < a.length; i++) sid += ('0' + a[i].toString(16)).slice(-2);
        sessionStorage.setItem('aeec_sid', sid);
      }
    } catch (err) { sid = null; }
    if (!sid) return;
    try { var today = new Date().toISOString().slice(0, 10), first = localStorage.getItem('aeec_first'); if (first && first !== today) ret = 1; if (!first) localStorage.setItem('aeec_first', today); } catch (err) { ret = 0; }
    try { utm = new URLSearchParams(location.search).get('utm_source') || ''; } catch (err) { utm = ''; }
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (err) { tz = ''; }
    function send(t) {
      var body = JSON.stringify(t === 'pv'
        ? { t: 'pv', sid: sid, path: location.pathname, title: doc.title, ref: doc.referrer, sw: screen.width, sh: screen.height, lang: LANG, tz: tz, ret: ret, utm: utm }
        : { t: 'ping', sid: sid, path: location.pathname });
      try { if (navigator.sendBeacon && navigator.sendBeacon(STATS_ENDPOINT, new Blob([body], { type: 'text/plain' }))) return; } catch (err) { /* fetch ilə davam */ }
      try { fetch(STATS_ENDPOINT, { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain' }, keepalive: true, credentials: 'same-origin' }).catch(function () {}); } catch (err) { /* statistika vacib deyil */ }
    }
    send('pv');
    var pinged = false;
    function ping() { if (!pinged) { pinged = true; send('ping'); setTimeout(function () { pinged = false; }, 1000); } }
    doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'hidden') ping(); });
    window.addEventListener('pagehide', ping);
  })();

  /* ── mobil menyu ── */
  var menuBtn = doc.getElementById('menuBtn'), nav = doc.getElementById('nav');
  function setMenu(open) {
    if (!menuBtn || !nav) return;
    nav.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    menuBtn.setAttribute('aria-label', open ? menuBtn.dataset.close : menuBtn.dataset.open);
  }
  if (menuBtn && nav) {
    menuBtn.addEventListener('click', function () { setMenu(!nav.classList.contains('open')); });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('open')) { setMenu(false); menuBtn.focus(); }
    });
    doc.addEventListener('click', function (e) {
      if (nav.classList.contains('open') && !nav.contains(e.target) && !menuBtn.contains(e.target)) setMenu(false);
    });
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    window.addEventListener('resize', function () { if (window.innerWidth > 1180) setMenu(false); });
  }

  /* ── dil seçimini yadda saxla (yalnız bu brauzerdə) ── */
  doc.querySelectorAll('[data-lang]').forEach(function (a) {
    a.addEventListener('click', function () { try { localStorage.setItem('aeec-lang', a.dataset.lang); } catch (err) {} });
  });

  /* ── bildiriş ── */
  var toast = doc.getElementById('toast'), tt;
  function say(msg) { if (!toast) return; toast.textContent = msg; toast.hidden = false; clearTimeout(tt); tt = setTimeout(function () { toast.hidden = true; }, 4000); }

  /* ── formalar ── */
  function labelOf(el) {
    var l = el.closest('label'); if (!l) return el.name || el.id;
    var s = l.querySelector('.lbl'); if (s && s.firstChild) return s.firstChild.textContent.trim();
    for (var i = 0; i < l.childNodes.length; i++) { var n = l.childNodes[i]; if (n.nodeType === 3 && n.textContent.trim()) return n.textContent.trim(); }
    return el.name || el.id;
  }
  function setErr(el, msg) {
    var id = el.id + '-err', e = doc.getElementById(id);
    if (!msg) { if (e) e.remove(); el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); return; }
    if (!e) { e = doc.createElement('span'); e.id = id; e.className = 'err'; (el.closest('label') || el.parentNode).appendChild(e); }
    e.textContent = msg; el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', id);
  }
  function check(el) {
    var msg = '';
    if (el.type === 'checkbox') { if (!el.checked) msg = T.consent; }
    else if (!el.value.trim()) msg = T.req;
    else if (el.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(el.value.trim())) msg = T.mailbad;
    setErr(el, msg); return !msg;
  }
  function collect(f) {
    var rows = [], data = {};
    [].slice.call(f.elements).forEach(function (el) {
      if (!el.name || el.type === 'submit' || el.type === 'button' || el.type === 'checkbox' || el.name === 'aeec_hp') return;
      var v = (el.value || '').trim(); if (!v) return;
      rows.push(labelOf(el) + ': ' + v); data[el.name] = v;
    });
    return { rows: rows, data: data };
  }
  function status(f, text, warn) {
    var ok = doc.createElement('p'); ok.className = 'form-ok full' + (warn ? ' warn' : ''); ok.setAttribute('role', 'status'); ok.textContent = text;
    var old = f.querySelector('.form-ok[role="status"]'); if (old) old.remove();
    f.appendChild(ok);
  }
  function openMail(subject, rows) {
    var body = rows.join('\n') + '\n\n—\n' + doc.title + '\n' + location.origin + location.pathname;
    window.location.href = 'mailto:' + FORM_EMAIL + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }
  doc.querySelectorAll('.js-form').forEach(function (f) {
    var hp = doc.createElement('input'); /* spam tələsi: insanlar görmür, botlar doldurur */
    hp.type = 'text'; hp.name = 'aeec_hp'; hp.className = 'hp'; hp.tabIndex = -1; hp.autocomplete = 'off'; hp.setAttribute('aria-hidden', 'true'); f.appendChild(hp);
    var req = [].slice.call(f.querySelectorAll('[required]'));
    req.forEach(function (el) { el.addEventListener(el.type === 'checkbox' ? 'change' : 'blur', function () { if (el.getAttribute('aria-invalid')) check(el); }); });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var bad = req.filter(function (el) { return !check(el); });
      if (bad.length) { bad[0].focus(); say(T.bad); return; }
      var c = collect(f);
      var subject = 'AEEC sayt sorğusu — ' + (c.data.name || '') + ' [' + LANG.toUpperCase() + ']';
      if (!FORM_ENDPOINT) { openMail(subject, c.rows); status(f, T.mail); return; }
      if (hp.value) { status(f, T.sent); f.reset(); return; }
      var btn = f.querySelector('[type="submit"]'); if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
      var payload = { form: f.dataset.form || '', lang: LANG, page: location.pathname, consent: true, aeec_hp: hp.value, elapsed: Date.now() - T0 };
      Object.keys(c.data).forEach(function (k) { payload[k] = c.data[k]; });
      fetch(FORM_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(payload), credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j || j.ok !== true) throw new Error('send'); }); })
        .then(function () { status(f, T.sent); f.reset(); })
        .catch(function () { status(f, T.fail, true); openMail(subject, c.rows); })
        .then(function () { if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); } });
    });
  });

  /* ── layihə filtri ── */
  doc.querySelectorAll('.chip').forEach(function (c) {
    c.addEventListener('click', function () {
      var f = c.dataset.f;
      doc.querySelectorAll('.chip').forEach(function (x) { x.setAttribute('aria-pressed', x === c ? 'true' : 'false'); });
      doc.querySelectorAll('#plist .prow').forEach(function (r) { r.hidden = !(f === 'all' || r.dataset.f === f); });
    });
  });

  /* ── kopyalama ── */
  doc.querySelectorAll('.copy').forEach(function (b) {
    b.addEventListener('click', function () {
      var t = b.dataset.copy;
      try { navigator.clipboard.writeText(t).then(function () { say(T.copied + t); }, function () { say(t); }); } catch (err) { say(t); }
    });
  });
})();
