/* Blotter — shared helpers. Loaded first; everything hangs off window.Util. */
(function (global) {
  'use strict';

  var USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var USD0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  var NUM = new Intl.NumberFormat('en-US');

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  var Util = {
    // ── numbers ───────────────────────────────────────────────
    money: function (v, compact) {
      if (!isNum(v)) return '—';
      if (compact && Math.abs(v) >= 100000) return USD0.format(v);
      return USD.format(v);
    },
    signedMoney: function (v) {
      if (!isNum(v)) return '—';
      return (v > 0 ? '+' : v < 0 ? '\u2212' : '') + USD.format(Math.abs(v));
    },
    signedPct: function (v, dp) {
      if (!isNum(v)) return '—';
      return (v > 0 ? '+' : v < 0 ? '\u2212' : '') + Math.abs(v).toFixed(dp == null ? 2 : dp) + '%';
    },
    num: function (v) { return isNum(v) ? NUM.format(v) : '—'; },
    px: function (v) { return isNum(v) ? v.toFixed(2) : '—'; },
    volume: function (v) {
      if (!isNum(v) || v <= 0) return '—';
      if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
      if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
      return NUM.format(v);
    },
    dirClass: function (v) { return !isNum(v) || v === 0 ? 'flat' : v > 0 ? 'up' : 'down'; },
    round2: function (v) { return Math.round((v + Number.EPSILON) * 100) / 100; },
    clamp: function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); },

    // ── dates ─────────────────────────────────────────────────
    isoDate: function (d) {
      d = d || new Date();
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },
    shortDate: function (ts) {
      if (!ts) return '—';
      return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    },
    stamp: function (ts) {
      if (!ts) return '—';
      return new Date(ts).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
    clock: function (ts) {
      return new Date(ts || Date.now()).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },
    // Days between now and an expiry date string, in years (365-day basis).
    yearsTo: function (isoExpiry) {
      var end = new Date(isoExpiry + 'T21:00:00Z').getTime(); // ~16:00 ET close
      var days = (end - Date.now()) / 86400000;
      return Math.max(days, 0) / 365;
    },
    daysTo: function (isoExpiry) {
      var end = new Date(isoExpiry + 'T21:00:00Z').getTime();
      return Math.ceil((end - Date.now()) / 86400000);
    },
    // Is the US equity market open right now? (regular session, ignores holidays)
    marketSession: function () {
      var now = new Date();
      // Convert to New York wall clock via locale trick.
      var ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      var day = ny.getDay();
      if (day === 0 || day === 6) return 'weekend';
      var mins = ny.getHours() * 60 + ny.getMinutes();
      if (mins >= 570 && mins < 960) return 'open';       // 09:30–16:00
      if (mins >= 240 && mins < 570) return 'pre';        // 04:00–09:30
      if (mins >= 960 && mins < 1200) return 'post';      // 16:00–20:00
      return 'closed';
    },

    // ── dom ───────────────────────────────────────────────────
    $: function (id) { return document.getElementById(id); },
    el: function (tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    },
    setText: function (id, text, cls) {
      var n = document.getElementById(id);
      if (!n) return;
      n.textContent = text;
      if (cls != null) {
        n.classList.remove('up', 'down', 'flat');
        if (cls) n.classList.add(cls);
      }
    },
    show: function (id, on) {
      var n = document.getElementById(id);
      if (n) n.hidden = !on;
    },

    uid: function () {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },

    // ── files ─────────────────────────────────────────────────
    downloadText: function (filename, text, mime) {
      var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    },
    readFile: function (file) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(String(r.result)); };
        r.onerror = function () { reject(new Error('That file could not be read.')); };
        r.readAsText(file);
      });
    },
    csvCell: function (v) {
      var s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    },
    toCsv: function (rows) {
      var self = this;
      return rows.map(function (r) { return r.map(self.csvCell).join(','); }).join('\r\n');
    },

    // ── local persistence (best effort; the file is the record) ─
    ls: {
      get: function (k) {
        try { return localStorage.getItem('blotter.' + k); } catch (e) { return null; }
      },
      set: function (k, v) {
        try { localStorage.setItem('blotter.' + k, v); return true; } catch (e) { return false; }
      },
      del: function (k) {
        try { localStorage.removeItem('blotter.' + k); } catch (e) { /* ignore */ }
      }
    },

    toast: function (msg, kind) {
      var box = document.getElementById('toasts');
      if (!box) return;
      var t = Util.el('div', 'toast' + (kind ? ' toast--' + kind : ''), msg);
      box.appendChild(t);
      setTimeout(function () {
        t.style.opacity = '0';
        t.style.transition = 'opacity .3s';
        setTimeout(function () { t.remove(); }, 320);
      }, kind === 'bad' ? 5200 : 3200);
    }
  };

  global.Util = Util;
})(window);
