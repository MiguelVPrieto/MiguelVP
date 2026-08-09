/* Blotter — market data.
   The only part of this app that talks to the outside world.
   Providers are swappable; each one normalises into the same shapes:

     quote  -> {symbol,name,exchange,last,prevClose,open,high,low,volume,ts,currency}
     series -> {symbol,interval,bars:[{t,o,h,l,c,v}]}
     search -> [{symbol,name,exchange,type}]
*/
(function (global) {
  'use strict';

  var RANGES = {
    '1D': { interval: '5min', size: 110, ttl: 90000 },
    '5D': { interval: '30min', size: 90, ttl: 300000 },
    '1M': { interval: '1day', size: 24, ttl: 900000 },
    '6M': { interval: '1day', size: 132, ttl: 900000 },
    '1Y': { interval: '1day', size: 260, ttl: 900000 }
  };

  // ── tiny rolling-window rate limiter ────────────────────────────
  function Limiter(rpm, minGapMs) {
    this.rpm = rpm; this.gap = minGapMs; this.hits = []; this.chain = Promise.resolve();
  }
  Limiter.prototype.run = function (fn) {
    var self = this;
    var next = this.chain.then(function () { return self._wait(); }).then(fn);
    // keep the chain alive even if a call rejects
    this.chain = next.then(function () {}, function () {});
    return next;
  };
  Limiter.prototype._wait = function () {
    var self = this;
    var now = Date.now();
    this.hits = this.hits.filter(function (t) { return now - t < 60000; });
    var delay = 0;
    if (this.hits.length >= this.rpm) delay = 60000 - (now - this.hits[0]) + 60;
    var last = this.hits[this.hits.length - 1];
    if (last && now - last < this.gap) delay = Math.max(delay, this.gap - (now - last));
    return new Promise(function (r) { setTimeout(r, delay); }).then(function () {
      self.hits.push(Date.now());
    });
  };

  // ── cache ───────────────────────────────────────────────────────
  var cache = new Map();
  function cacheGet(key) {
    var e = cache.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) { cache.delete(key); return null; }
    return e.val;
  }
  function cacheSet(key, val, ttl) { cache.set(key, { val: val, exp: Date.now() + ttl }); }

  function getJson(url) {
    return fetch(url, { mode: 'cors' }).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = JSON.parse(txt); } catch (e) { /* not json */ }
        if (!r.ok) {
          var m = (data && (data.message || data.error)) || ('HTTP ' + r.status);
          if (r.status === 401 || r.status === 403) m = 'The feed rejected the key (' + r.status + '). Check it in Settings.';
          if (r.status === 429) m = 'Rate limit reached. Slow the auto-refresh down in Settings.';
          throw new Error(m);
        }
        if (data && data.status === 'error') throw new Error(data.message || 'The feed returned an error.');
        return data;
      });
    });
  }

  // ── Twelve Data ─────────────────────────────────────────────────
  var TwelveData = {
    id: 'twelvedata',
    label: 'Twelve Data',
    needsKey: true,
    help: 'Free plan: 800 credits a day, 8 requests a minute, real-time US market data. Get a key at twelvedata.com.',
    limiter: new Limiter(8, 400),
    base: 'https://api.twelvedata.com',
    _q: function (path, params, key) {
      params.apikey = key;
      var qs = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      }).join('&');
      return this.limiter.run(function () { return getJson(TwelveData.base + path + '?' + qs); });
    },
    quotes: function (symbols, key) {
      return this._q('/quote', { symbol: symbols.join(','), dp: '4' }, key).then(function (data) {
        var out = {};
        var rows = symbols.length === 1 ? (function () { var o = {}; o[symbols[0]] = data; return o; })() : data;
        symbols.forEach(function (s) {
          var d = rows && rows[s];
          if (!d || d.status === 'error' || d.code) return;
          out[s] = {
            symbol: s,
            name: d.name || '',
            exchange: d.exchange || '',
            currency: d.currency || 'USD',
            last: parseFloat(d.close),
            prevClose: parseFloat(d.previous_close),
            open: parseFloat(d.open),
            high: parseFloat(d.high),
            low: parseFloat(d.low),
            volume: parseFloat(d.volume),
            marketOpen: d.is_market_open === true || d.is_market_open === 'true',
            ts: d.timestamp ? d.timestamp * 1000 : Date.now()
          };
        });
        return out;
      });
    },
    series: function (symbol, interval, size, key) {
      return this._q('/time_series', { symbol: symbol, interval: interval, outputsize: size, order: 'ASC', dp: '4' }, key)
        .then(function (data) {
          var vals = (data && data.values) || [];
          return {
            symbol: symbol,
            interval: interval,
            bars: vals.map(function (v) {
              return {
                t: new Date(v.datetime.length <= 10 ? v.datetime + 'T16:00:00' : v.datetime.replace(' ', 'T')).getTime(),
                o: parseFloat(v.open), h: parseFloat(v.high), l: parseFloat(v.low),
                c: parseFloat(v.close), v: parseFloat(v.volume || 0)
              };
            }).filter(function (b) { return isFinite(b.c); })
          };
        });
    },
    search: function (q, key) {
      return this._q('/symbol_search', { symbol: q, outputsize: 30 }, key).then(function (data) {
        return ((data && data.data) || []).map(function (r) {
          return {
            symbol: r.symbol,
            name: r.instrument_name || '',
            exchange: r.exchange || '',
            country: r.country || '',
            type: r.instrument_type || ''
          };
        });
      });
    }
  };

  // ── Finnhub ─────────────────────────────────────────────────────
  var Finnhub = {
    id: 'finnhub',
    label: 'Finnhub',
    needsKey: true,
    help: 'Free plan: 60 calls a minute, real-time US quotes and symbol search. Historical candles are a paid endpoint, so charts may be unavailable on a free key.',
    limiter: new Limiter(55, 120),
    base: 'https://finnhub.io/api/v1',
    _q: function (path, params, key) {
      params.token = key;
      var qs = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
      }).join('&');
      return this.limiter.run(function () { return getJson(Finnhub.base + path + '?' + qs); });
    },
    quotes: function (symbols, key) {
      var self = this;
      return Promise.all(symbols.map(function (s) {
        return self._q('/quote', { symbol: s }, key).then(function (d) {
          if (!d || !isFinite(d.c) || d.c === 0) return null;
          return {
            symbol: s, name: '', exchange: '', currency: 'USD',
            last: d.c, prevClose: d.pc, open: d.o, high: d.h, low: d.l,
            volume: NaN, ts: d.t ? d.t * 1000 : Date.now()
          };
        }).catch(function () { return null; });
      })).then(function (list) {
        var out = {};
        list.forEach(function (q) { if (q) out[q.symbol] = q; });
        return out;
      });
    },
    series: function (symbol, interval, size, key) {
      var res = { '5min': '5', '30min': '30', '1h': '60', '1day': 'D' }[interval] || 'D';
      var perBar = { '5': 300, '30': 1800, '60': 3600, 'D': 86400 }[res];
      var to = Math.floor(Date.now() / 1000);
      var from = to - perBar * size * (res === 'D' ? 1.6 : 3);
      return this._q('/stock/candle', { symbol: symbol, resolution: res, from: Math.floor(from), to: to }, key)
        .then(function (d) {
          if (!d || d.s !== 'ok' || !d.t) return { symbol: symbol, interval: interval, bars: [] };
          return {
            symbol: symbol, interval: interval,
            bars: d.t.map(function (t, i) {
              return { t: t * 1000, o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: d.v ? d.v[i] : 0 };
            }).slice(-size)
          };
        });
    },
    search: function (q, key) {
      return this._q('/search', { q: q, exchange: 'US' }, key).then(function (d) {
        return ((d && d.result) || []).map(function (r) {
          return { symbol: r.displaySymbol || r.symbol, name: r.description || '', exchange: 'US', country: 'United States', type: r.type || '' };
        }).filter(function (r) { return r.symbol && r.symbol.indexOf('.') === -1; });
      });
    }
  };

  // ── Demo (no network, clearly fake) ─────────────────────────────
  var DEMO_UNIVERSE = [
    ['AAPL', 'Apple Inc.'], ['MSFT', 'Microsoft Corporation'], ['NVDA', 'NVIDIA Corporation'],
    ['AMZN', 'Amazon.com, Inc.'], ['GOOGL', 'Alphabet Inc.'], ['META', 'Meta Platforms, Inc.'],
    ['TSLA', 'Tesla, Inc.'], ['AVGO', 'Broadcom Inc.'], ['COST', 'Costco Wholesale Corporation'],
    ['NFLX', 'Netflix, Inc.'], ['AMD', 'Advanced Micro Devices, Inc.'], ['INTC', 'Intel Corporation'],
    ['PEP', 'PepsiCo, Inc.'], ['ADBE', 'Adobe Inc.'], ['CSCO', 'Cisco Systems, Inc.'],
    ['QCOM', 'QUALCOMM Incorporated'], ['TXN', 'Texas Instruments Incorporated'],
    ['AMAT', 'Applied Materials, Inc.'], ['MU', 'Micron Technology, Inc.'], ['SBUX', 'Starbucks Corporation'],
    ['PYPL', 'PayPal Holdings, Inc.'], ['ABNB', 'Airbnb, Inc.'], ['MRVL', 'Marvell Technology, Inc.'],
    ['PLTR', 'Palantir Technologies Inc.'], ['QQQ', 'Invesco QQQ Trust']
  ];

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0);
  }
  function rng(seed) {
    var s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  var Demo = {
    id: 'demo',
    label: 'Demo feed',
    needsKey: false,
    help: 'Simulated prices generated in your browser. Useful for trying the app out — these are not real market prices.',
    _base: function (symbol) {
      var h = hash(symbol);
      return 20 + (h % 44000) / 100; // $20–$460
    },
    _walk: function (symbol, steps, stepSec, endTs) {
      var base = this._base(symbol);
      var r = rng(hash(symbol + Math.floor((endTs || Date.now()) / 86400000)));
      var vol = 0.012 + (hash(symbol + 'v') % 30) / 1500;
      var bars = [];
      var px = base * (0.9 + r() * 0.2);
      var t0 = (endTs || Date.now()) - steps * stepSec * 1000;
      for (var i = 0; i < steps; i++) {
        var drift = (r() - 0.5) * vol * px * Math.sqrt(stepSec / 86400);
        var o = px; px = Math.max(1, px + drift);
        bars.push({
          t: t0 + i * stepSec * 1000,
          o: o, c: px,
          h: Math.max(o, px) * (1 + r() * 0.002),
          l: Math.min(o, px) * (1 - r() * 0.002),
          v: Math.floor(200000 + r() * 3000000)
        });
      }
      return bars;
    },
    quotes: function (symbols) {
      var self = this;
      var out = {};
      symbols.forEach(function (s) {
        var bars = self._walk(s, 80, 300);
        var last = bars[bars.length - 1].c;
        var prev = bars[0].o;
        var name = (DEMO_UNIVERSE.filter(function (u) { return u[0] === s; })[0] || [s, s + ' (demo)'])[1];
        // gentle intra-minute jitter so refreshes visibly move
        var jitter = 1 + (Math.sin(Date.now() / 45000 + hash(s)) * 0.0018);
        out[s] = {
          symbol: s, name: name, exchange: 'NASDAQ', currency: 'USD',
          last: Util.round2(last * jitter), prevClose: Util.round2(prev),
          open: Util.round2(bars[0].c),
          high: Util.round2(Math.max.apply(null, bars.map(function (b) { return b.h; }))),
          low: Util.round2(Math.min.apply(null, bars.map(function (b) { return b.l; }))),
          volume: bars.reduce(function (a, b) { return a + b.v; }, 0),
          ts: Date.now(), demo: true
        };
      });
      return Promise.resolve(out);
    },
    series: function (symbol, interval, size) {
      var stepSec = { '5min': 300, '30min': 1800, '1h': 3600, '1day': 86400 }[interval] || 86400;
      return Promise.resolve({ symbol: symbol, interval: interval, bars: this._walk(symbol, size, stepSec) });
    },
    search: function (q) {
      q = q.toUpperCase();
      return Promise.resolve(DEMO_UNIVERSE.filter(function (u) {
        return u[0].indexOf(q) === 0 || u[1].toUpperCase().indexOf(q) >= 0;
      }).map(function (u) {
        return { symbol: u[0], name: u[1], exchange: 'NASDAQ', country: 'United States', type: 'Common Stock' };
      }));
    }
  };

  var PROVIDERS = { twelvedata: TwelveData, finnhub: Finnhub, demo: Demo };

  // ── public façade ───────────────────────────────────────────────
  var Market = {
    providerId: 'twelvedata',
    apiKey: '',
    nasdaqOnly: true,

    provider: function () { return PROVIDERS[this.providerId] || TwelveData; },
    providerInfo: function (id) { return PROVIDERS[id || this.providerId] || TwelveData; },
    isDemo: function () { return this.providerId === 'demo'; },
    ready: function () { return !this.provider().needsKey || !!this.apiKey; },

    ranges: RANGES,
    clearCache: function () { cache.clear(); },

    /* Quotes for a list of symbols. Cached for `ttl` ms; pass force to bypass. */
    quotes: function (symbols, opts) {
      opts = opts || {};
      var ttl = opts.ttl == null ? 30000 : opts.ttl;
      var p = this.provider();
      var key = this.apiKey;
      var out = {};
      var need = [];
      symbols.forEach(function (s) {
        s = s.toUpperCase();
        var hit = opts.force ? null : cacheGet('q:' + p.id + ':' + s);
        if (hit) out[s] = hit; else if (need.indexOf(s) === -1) need.push(s);
      });
      if (!need.length) return Promise.resolve(out);
      if (p.needsKey && !key) return Promise.reject(new Error('No API key set. Open Settings and paste a free key.'));
      return p.quotes(need, key).then(function (fresh) {
        Object.keys(fresh).forEach(function (s) {
          cacheSet('q:' + p.id + ':' + s, fresh[s], ttl);
          out[s] = fresh[s];
        });
        return out;
      });
    },

    quote: function (symbol, opts) {
      return this.quotes([symbol], opts).then(function (m) {
        var q = m[symbol.toUpperCase()];
        if (!q) throw new Error('No quote came back for ' + symbol + '.');
        return q;
      });
    },

    series: function (symbol, range, opts) {
      opts = opts || {};
      symbol = symbol.toUpperCase();
      var cfg = RANGES[range] || RANGES['1M'];
      var p = this.provider();
      var ck = 's:' + p.id + ':' + symbol + ':' + range;
      var hit = opts.force ? null : cacheGet(ck);
      if (hit) return Promise.resolve(hit);
      if (p.needsKey && !this.apiKey) return Promise.reject(new Error('No API key set. Open Settings and paste a free key.'));
      return p.series(symbol, cfg.interval, cfg.size, this.apiKey).then(function (s) {
        if (s.bars.length) cacheSet(ck, s, cfg.ttl);
        return s;
      });
    },

    /* Daily closes used to estimate volatility for the option model. */
    dailyCloses: function (symbol) {
      symbol = symbol.toUpperCase();
      var p = this.provider();
      var ck = 'd:' + p.id + ':' + symbol;
      var hit = cacheGet(ck);
      if (hit) return Promise.resolve(hit);
      if (p.needsKey && !this.apiKey) return Promise.reject(new Error('No API key set.'));
      return p.series(symbol, '1day', 130, this.apiKey).then(function (s) {
        var closes = s.bars.map(function (b) { return b.c; }).filter(isFinite);
        cacheSet(ck, closes, 3600000);
        return closes;
      });
    },

    search: function (q) {
      var self = this;
      q = (q || '').trim();
      if (!q) return Promise.resolve([]);
      var p = this.provider();
      var ck = 'f:' + p.id + ':' + q.toLowerCase() + ':' + (this.nasdaqOnly ? 1 : 0);
      var hit = cacheGet(ck);
      if (hit) return Promise.resolve(hit);
      if (p.needsKey && !this.apiKey) return Promise.reject(new Error('No API key set. Open Settings and paste a free key.'));
      return p.search(q, this.apiKey).then(function (rows) {
        var filtered = rows.filter(function (r) {
          if (!r.symbol) return false;
          if (!self.nasdaqOnly) return true;
          if (p.id === 'finnhub') return true; // Finnhub search is already US-scoped
          return /nasdaq/i.test(r.exchange || '');
        });
        // exact ticker match first, then prefix, then the rest
        var qq = q.toUpperCase();
        filtered.sort(function (a, b) {
          var sa = a.symbol === qq ? 0 : a.symbol.indexOf(qq) === 0 ? 1 : 2;
          var sb = b.symbol === qq ? 0 : b.symbol.indexOf(qq) === 0 ? 1 : 2;
          return sa - sb || a.symbol.length - b.symbol.length;
        });
        var top = filtered.slice(0, 25);
        cacheSet(ck, top, 600000);
        return top;
      });
    }
  };

  Market.PROVIDERS = PROVIDERS;
  global.Market = Market;
})(window);
