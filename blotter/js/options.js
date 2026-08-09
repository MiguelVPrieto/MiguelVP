/* Blotter — option pricing.

   No free market-data plan gives a live option chain, so contracts here are
   generated locally and priced with Black-Scholes on the live underlying:
     · volatility  = 60-day realised volatility of daily closes, with a simple
                     equity skew applied by moneyness
     · rate        = the risk-free rate you set in Settings
     · dividends   = ignored
   Everything is marked with the same model, so P/L is internally consistent —
   but these are model values, not quotes you could actually trade on.
*/
(function (global) {
  'use strict';

  var MULT = 100; // shares per contract

  // Cumulative normal, Abramowitz & Stegun 26.2.17 (|err| < 7.5e-8)
  function cnd(x) {
    var a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    var sign = x < 0 ? -1 : 1;
    var z = Math.abs(x) / Math.SQRT2;
    var t = 1 / (1 + p * z);
    var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);
    return 0.5 * (1 + sign * y);
  }
  function npdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

  var Options = {
    MULT: MULT,

    /* Black-Scholes price + greeks. T in years, sigma annualised, r decimal. */
    price: function (right, S, K, T, sigma, r) {
      var isCall = right === 'call';
      if (!(S > 0) || !(K > 0)) return null;
      if (!(T > 0) || !(sigma > 0)) {
        var intr = Math.max(0, isCall ? S - K : K - S);
        return { value: intr, delta: intr > 0 ? (isCall ? 1 : -1) : 0, gamma: 0, vega: 0, theta: 0, rho: 0, intrinsic: intr, extrinsic: 0 };
      }
      var sq = sigma * Math.sqrt(T);
      var d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / sq;
      var d2 = d1 - sq;
      var disc = Math.exp(-r * T);
      var value = isCall
        ? S * cnd(d1) - K * disc * cnd(d2)
        : K * disc * cnd(-d2) - S * cnd(-d1);
      var delta = isCall ? cnd(d1) : cnd(d1) - 1;
      var gamma = npdf(d1) / (S * sq);
      var vega = S * npdf(d1) * Math.sqrt(T) / 100;               // per 1 vol point
      var theta = (-(S * npdf(d1) * sigma) / (2 * Math.sqrt(T))
        + (isCall ? -1 : 1) * r * K * disc * cnd(isCall ? d2 : -d2)) / 365; // per day
      var rho = (isCall ? 1 : -1) * K * T * disc * cnd(isCall ? d2 : -d2) / 100;
      var intrinsic = Math.max(0, isCall ? S - K : K - S);
      return {
        value: Math.max(value, 0),
        delta: delta, gamma: gamma, vega: vega, theta: theta, rho: rho,
        intrinsic: intrinsic, extrinsic: Math.max(value - intrinsic, 0)
      };
    },

    /* Annualised realised volatility from a list of daily closes. */
    realisedVol: function (closes) {
      if (!closes || closes.length < 12) return null;
      var use = closes.slice(-61);
      var rets = [];
      for (var i = 1; i < use.length; i++) {
        if (use[i] > 0 && use[i - 1] > 0) rets.push(Math.log(use[i] / use[i - 1]));
      }
      if (rets.length < 10) return null;
      var mean = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
      var varr = rets.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (rets.length - 1);
      var vol = Math.sqrt(varr * 252);
      return Util.clamp(vol, 0.08, 2.5);
    },

    /* Implied vol for a strike: base vol plus a plain equity skew. */
    volFor: function (baseVol, S, K, T) {
      var v = baseVol || 0.32;
      if (!(S > 0) || !(K > 0)) return v;
      var m = Math.log(K / S);
      var skew = 1 - 0.42 * m + 0.9 * m * m;          // OTM puts richer, OTM calls cheaper
      var term = 1 + 0.06 * Math.max(0, 0.25 - (T || 0.1)); // slight short-dated kicker
      return Util.clamp(v * skew * term, 0.05, 3);
    },

    /* Full quote for one contract at the current underlying price. */
    contract: function (spec, S, baseVol, r) {
      var T = Util.yearsTo(spec.expiry);
      var sigma = this.volFor(baseVol, S, spec.strike, T);
      var p = this.price(spec.right, S, spec.strike, T, sigma, r);
      if (!p) return null;
      p.iv = sigma;
      p.T = T;
      p.days = Util.daysTo(spec.expiry);
      p.perContract = p.value * MULT;
      return p;
    },

    /* Expiry ladder: the next five Fridays plus monthly third Fridays. */
    expiries: function () {
      var out = [];
      var now = new Date();
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      // weeklies
      var probe = new Date(d);
      while (out.length < 5) {
        probe.setDate(probe.getDate() + 1);
        if (probe.getDay() === 5) out.push(Util.isoDate(probe));
      }
      // monthlies (third Friday) for the next 8 months
      for (var m = 0; m < 9; m++) {
        var first = new Date(now.getFullYear(), now.getMonth() + m, 1);
        var fri = 1 + ((5 - first.getDay() + 7) % 7) + 14;
        var third = new Date(now.getFullYear(), now.getMonth() + m, fri);
        if (third > d) out.push(Util.isoDate(third));
      }
      return out.filter(function (v, i, a) { return a.indexOf(v) === i; }).sort().slice(0, 10);
    },

    strikeStep: function (S) {
      if (S < 25) return 1;
      if (S < 60) return 2.5;
      if (S < 200) return 5;
      if (S < 500) return 10;
      if (S < 1200) return 25;
      return 50;
    },

    /* Strikes bracketing the spot price. */
    strikes: function (S, count) {
      var step = this.strikeStep(S);
      var atm = Math.round(S / step) * step;
      var n = Math.floor((count || 21) / 2);
      var out = [];
      for (var i = -n; i <= n; i++) {
        var k = Util.round2(atm + i * step);
        if (k > 0) out.push(k);
      }
      return out;
    },

    /* "AAPL 2026-09-18 220 C" */
    label: function (o) {
      return o.symbol + ' ' + o.expiry + ' ' + Util.px(o.strike) + ' ' + (o.right === 'call' ? 'C' : 'P');
    },
    shortLabel: function (o) {
      var d = new Date(o.expiry + 'T12:00:00');
      var mon = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
      return o.symbol + ' ' + d.getDate() + mon + String(d.getFullYear()).slice(2) + ' ' +
        Util.px(o.strike) + (o.right === 'call' ? 'C' : 'P');
    }
  };

  global.Options = Options;
})(window);
