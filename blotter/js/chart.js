/* Blotter — charts drawn straight onto a canvas. No chart library, nothing
   loaded from a CDN: the whole app runs from this folder. */
(function (global) {
  'use strict';

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function niceTicks(min, max, count) {
    if (!isFinite(min) || !isFinite(max) || min === max) return [min];
    var span = max - min;
    var step = Math.pow(10, Math.floor(Math.log10(span / count)));
    var err = (span / count) / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var out = [];
    for (var v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) out.push(v);
    return out;
  }

  function PriceChart(canvas, opts) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.bars = [];
    this.meta = {};
    this.hover = null;
    var self = this;

    this._move = function (e) {
      var r = self.c.getBoundingClientRect();
      self._pick(e.clientX - r.left);
    };
    this._leave = function () { self.hover = null; self.draw(); if (self.opts.onHover) self.opts.onHover(null); };
    canvas.addEventListener('mousemove', this._move);
    canvas.addEventListener('mouseleave', this._leave);
    canvas.addEventListener('touchmove', function (e) {
      var r = self.c.getBoundingClientRect();
      self._pick(e.touches[0].clientX - r.left);
    }, { passive: true });

    this._resize = function () { self.draw(); };
    global.addEventListener('resize', this._resize);
  }

  PriceChart.prototype.setData = function (bars, meta) {
    this.bars = (bars || []).filter(function (b) { return isFinite(b.c); });
    this.meta = meta || {};
    this.hover = null;
    this.draw();
  };

  PriceChart.prototype._pick = function (x) {
    if (!this.bars.length || !this.plot) return;
    var p = this.plot;
    var i = Math.round(((x - p.l) / p.w) * (this.bars.length - 1));
    i = Util.clamp(i, 0, this.bars.length - 1);
    if (i !== this.hover) {
      this.hover = i;
      this.draw();
      if (this.opts.onHover) this.opts.onHover(this.bars[i], i);
    }
  };

  PriceChart.prototype.draw = function () {
    var c = this.c, ctx = this.ctx;
    var dpr = global.devicePixelRatio || 1;
    var W = c.clientWidth || 600, H = c.clientHeight || 300;
    c.width = W * dpr; c.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!this.bars.length) { this.plot = null; return; }

    var ink = cssVar('--ink', '#141D22');
    var ink3 = cssVar('--ink-3', '#7C8A8D');
    var rule = cssVar('--rule-2', '#DFE4DA');
    var up = cssVar('--long', '#1C6A4A');
    var down = cssVar('--short', '#A6382F');
    var stamp = cssVar('--stamp', '#2B4A8C');

    var padL = 8, padR = 58, padT = 12, padB = 24;
    var w = W - padL - padR, h = H - padT - padB;
    this.plot = { l: padL, t: padT, w: w, h: h };

    var bars = this.bars;
    var lows = bars.map(function (b) { return isFinite(b.l) ? b.l : b.c; });
    var highs = bars.map(function (b) { return isFinite(b.h) ? b.h : b.c; });
    var min = Math.min.apply(null, lows);
    var max = Math.max.apply(null, highs);
    var prev = this.meta.prevClose;
    if (isFinite(prev)) { min = Math.min(min, prev); max = Math.max(max, prev); }
    var pad = (max - min) * 0.08 || Math.max(max * 0.01, 0.5);
    min -= pad; max += pad;

    var X = function (i) { return padL + (bars.length === 1 ? w / 2 : (i / (bars.length - 1)) * w); };
    var Y = function (v) { return padT + h - ((v - min) / (max - min)) * h; };

    var first = bars[0].c, last = bars[bars.length - 1].c;
    var ref = isFinite(prev) ? prev : first;
    var color = last >= ref ? up : down;

    // horizontal rules + right-hand price scale
    ctx.font = '11px ' + cssVar('--mono', 'monospace');
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    niceTicks(min, max, 5).forEach(function (v) {
      var y = Y(v);
      if (y < padT - 2 || y > padT + h + 2) return;
      ctx.strokeStyle = rule;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(padL + w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = ink3;
      ctx.fillText(v.toFixed(v < 10 ? 2 : v < 1000 ? 1 : 0), padL + w + 8, y);
    });

    // previous close reference
    if (isFinite(prev)) {
      var py = Y(prev);
      ctx.save();
      ctx.strokeStyle = ink3;
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, py); ctx.lineTo(padL + w, py); ctx.stroke();
      ctx.restore();
    }

    // area fill
    var grad = ctx.createLinearGradient(0, padT, 0, padT + h);
    grad.addColorStop(0, color + '2E');
    grad.addColorStop(1, color + '00');
    ctx.beginPath();
    ctx.moveTo(X(0), Y(bars[0].c));
    bars.forEach(function (b, i) { ctx.lineTo(X(i), Y(b.c)); });
    ctx.lineTo(X(bars.length - 1), padT + h);
    ctx.lineTo(X(0), padT + h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // price line
    ctx.beginPath();
    bars.forEach(function (b, i) { i ? ctx.lineTo(X(i), Y(b.c)) : ctx.moveTo(X(i), Y(b.c)); });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // x labels
    ctx.fillStyle = ink3;
    ctx.textBaseline = 'top';
    var intraday = this.meta.intraday;
    var labels = 4;
    for (var k = 0; k <= labels; k++) {
      var idx = Math.round((k / labels) * (bars.length - 1));
      var d = new Date(bars[idx].t);
      var txt = intraday
        ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      ctx.textAlign = k === 0 ? 'left' : k === labels ? 'right' : 'center';
      ctx.fillText(txt, Util.clamp(X(idx), padL, padL + w), padT + h + 7);
    }

    // crosshair
    if (this.hover != null && bars[this.hover]) {
      var b = bars[this.hover];
      var hx = X(this.hover), hy = Y(b.c);
      ctx.save();
      ctx.strokeStyle = stamp;
      ctx.globalAlpha = 0.45;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + h); ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.strokeStyle = cssVar('--card', '#fff'); ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      // last point marker
      ctx.beginPath();
      ctx.arc(X(bars.length - 1), Y(last), 3, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
    }
    ctx.strokeStyle = ink; // keep ink referenced for future annotations
  };

  PriceChart.prototype.destroy = function () {
    global.removeEventListener('resize', this._resize);
  };

  /* Small filled sparkline for the dashboard. */
  function sparkline(canvas, values, colorVar) {
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var dpr = global.devicePixelRatio || 1;
    var W = canvas.clientWidth || 200, H = canvas.clientHeight || 40;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var v = (values || []).filter(isFinite);
    if (v.length < 2) return;
    var min = Math.min.apply(null, v), max = Math.max.apply(null, v);
    var span = (max - min) || 1;
    var X = function (i) { return (i / (v.length - 1)) * W; };
    var Y = function (val) { return H - 3 - ((val - min) / span) * (H - 8); };
    var color = cssVar(colorVar || '--long', '#1C6A4A');
    ctx.beginPath();
    ctx.moveTo(0, H);
    v.forEach(function (val, i) { ctx.lineTo(X(i), Y(val)); });
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = color + '22';
    ctx.fill();
    ctx.beginPath();
    v.forEach(function (val, i) { i ? ctx.lineTo(X(i), Y(val)) : ctx.moveTo(X(i), Y(val)); });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }

  global.PriceChart = PriceChart;
  global.sparkline = sparkline;
})(window);
