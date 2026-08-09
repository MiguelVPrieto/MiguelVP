/* Blotter — the book itself: positions, cash, margin, valuation, file IO.

   Cash conventions
     · Buying stock debits cash. Selling short credits the sale proceeds.
     · A short position carries an obligation of 150% of its market value
       (100% to buy it back plus 50% Reg-T style margin), so shorting uses
       buying power even though it adds cash.
     · A written option reserves 20% of the underlying notional plus the cost
       of buying the contract back.
     · Buying power = cash − obligations. Orders that would push it below zero
       are rejected.
*/
(function (global) {
  'use strict';

  var SCHEMA = 'blotter.portfolio';
  var VERSION = 1;
  var MULT = 100;
  var MAX_LOG = 1200;
  var MAX_CURVE = 1500;

  function nyToday() {
    var ny = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return Util.isoDate(ny);
  }

  function Portfolio(data) {
    this.d = data;
  }

  // ── construction ──────────────────────────────────────────────
  Portfolio.create = function (name, cash) {
    var now = Date.now();
    return new Portfolio({
      schema: SCHEMA,
      version: VERSION,
      name: name || 'My paper account',
      createdAt: now,
      updatedAt: now,
      startingCash: cash,
      cash: cash,
      realized: 0,
      settings: { commissionStock: 0, commissionOption: 0.65, riskFreeRate: 0.043 },
      stats: { high: cash, highAt: now, low: cash, lowAt: now },
      positions: [],
      options: [],
      transactions: [],
      equityCurve: [{ t: now, v: cash }]
    });
  };

  Portfolio.parse = function (text) {
    var raw;
    try { raw = JSON.parse(text); } catch (e) {
      throw new Error('That file is not valid JSON. Blotter reads the .json file it writes.');
    }
    if (!raw || typeof raw !== 'object') throw new Error('That file has no portfolio in it.');
    if (raw.schema !== SCHEMA) throw new Error('That JSON file was not written by Blotter.');
    if (typeof raw.cash !== 'number' || !isFinite(raw.cash)) throw new Error('The file is missing a valid cash balance.');

    var d = {
      schema: SCHEMA,
      version: VERSION,
      name: String(raw.name || 'Restored account').slice(0, 64),
      createdAt: raw.createdAt || Date.now(),
      updatedAt: Date.now(),
      startingCash: typeof raw.startingCash === 'number' ? raw.startingCash : raw.cash,
      cash: raw.cash,
      realized: typeof raw.realized === 'number' ? raw.realized : 0,
      settings: Object.assign({ commissionStock: 0, commissionOption: 0.65, riskFreeRate: 0.043 }, raw.settings || {}),
      stats: Object.assign({ high: raw.cash, highAt: Date.now(), low: raw.cash, lowAt: Date.now() }, raw.stats || {}),
      positions: [],
      options: [],
      transactions: Array.isArray(raw.transactions) ? raw.transactions.slice(-MAX_LOG) : [],
      equityCurve: Array.isArray(raw.equityCurve) ? raw.equityCurve.slice(-MAX_CURVE) : []
    };

    (Array.isArray(raw.positions) ? raw.positions : []).forEach(function (p) {
      if (!p || !p.symbol || !(p.qty > 0)) return;
      d.positions.push({
        id: p.id || Util.uid(),
        symbol: String(p.symbol).toUpperCase(),
        side: p.side === 'short' ? 'short' : 'long',
        qty: Math.floor(p.qty),
        avgPrice: Number(p.avgPrice) || 0,
        openedAt: p.openedAt || Date.now()
      });
    });

    (Array.isArray(raw.options) ? raw.options : []).forEach(function (o) {
      if (!o || !o.symbol || !(o.contracts > 0) || !o.expiry || !(o.strike > 0)) return;
      d.options.push({
        id: o.id || Util.uid(),
        symbol: String(o.symbol).toUpperCase(),
        right: o.right === 'put' ? 'put' : 'call',
        side: o.side === 'short' ? 'short' : 'long',
        contracts: Math.floor(o.contracts),
        strike: Number(o.strike),
        expiry: String(o.expiry).slice(0, 10),
        premium: Number(o.premium) || 0,
        openedAt: o.openedAt || Date.now()
      });
    });

    return new Portfolio(d);
  };

  var P = Portfolio.prototype;

  P.toJson = function () {
    this.d.updatedAt = Date.now();
    return JSON.stringify(this.d, null, 2);
  };
  P.filename = function () {
    var slug = (this.d.name || 'blotter').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'blotter';
    return slug + '-' + Util.isoDate() + '.json';
  };

  /* A cheap clone used to dry-run an order without touching the real book.
     Skips the transaction log and equity curve, which can be long. */
  P.probe = function () {
    var d = this.d;
    return new Portfolio({
      schema: SCHEMA, version: VERSION, name: d.name,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
      startingCash: d.startingCash, cash: d.cash, realized: d.realized,
      settings: Object.assign({}, d.settings),
      stats: Object.assign({}, d.stats),
      positions: d.positions.map(function (p) { return Object.assign({}, p); }),
      options: d.options.map(function (o) { return Object.assign({}, o); }),
      transactions: [], equityCurve: []
    });
  };

  // ── lookups ───────────────────────────────────────────────────
  P.symbols = function () {
    var set = {};
    this.d.positions.forEach(function (p) { set[p.symbol] = 1; });
    this.d.options.forEach(function (o) { set[o.symbol] = 1; });
    return Object.keys(set);
  };
  P.position = function (symbol, side) {
    symbol = symbol.toUpperCase();
    return this.d.positions.filter(function (p) { return p.symbol === symbol && p.side === side; })[0] || null;
  };
  P.optionLeg = function (spec) {
    return this.d.options.filter(function (o) {
      return o.symbol === spec.symbol && o.right === spec.right && o.side === spec.side &&
        o.expiry === spec.expiry && Math.abs(o.strike - spec.strike) < 0.001;
    })[0] || null;
  };

  // ── obligations & buying power ────────────────────────────────
  P.obligations = function (marks) {
    var total = 0;
    this.d.positions.forEach(function (p) {
      if (p.side !== 'short') return;
      var px = (marks.stock[p.symbol] != null) ? marks.stock[p.symbol] : p.avgPrice;
      total += 1.5 * p.qty * px;
    });
    this.d.options.forEach(function (o) {
      if (o.side !== 'short') return;
      var S = (marks.stock[o.symbol] != null) ? marks.stock[o.symbol] : o.strike;
      var v = (marks.option[o.id] != null) ? marks.option[o.id] : o.premium;
      total += o.contracts * MULT * (0.20 * S + v);
    });
    return total;
  };
  P.buyingPower = function (marks) {
    return this.d.cash - this.obligations(marks);
  };

  // ── trading ───────────────────────────────────────────────────
  /* action: buy | sell | short | cover */
  P.tradeStock = function (symbol, action, qty, price, marks) {
    symbol = symbol.toUpperCase();
    qty = Math.floor(qty);
    if (!(qty > 0)) throw new Error('Enter a whole number of shares.');
    if (!(price > 0)) throw new Error('No live price for ' + symbol + ' — refresh and try again.');

    var comm = Number(this.d.settings.commissionStock) || 0;
    var principal = qty * price;
    var long = this.position(symbol, 'long');
    var short = this.position(symbol, 'short');
    var cashDelta, realized = 0;

    if (action === 'buy') {
      if (short) throw new Error('Cover the short in ' + symbol + ' before going long.');
      cashDelta = -(principal + comm);
    } else if (action === 'short') {
      if (long) throw new Error('Sell the long position in ' + symbol + ' before shorting it.');
      cashDelta = principal - comm;
    } else if (action === 'sell') {
      if (!long) throw new Error('You hold no shares of ' + symbol + ' to sell.');
      if (qty > long.qty) throw new Error('You hold ' + long.qty + ' shares of ' + symbol + '.');
      cashDelta = principal - comm;
      realized = qty * (price - long.avgPrice) - comm;
    } else if (action === 'cover') {
      if (!short) throw new Error('You have no short position in ' + symbol + ' to cover.');
      if (qty > short.qty) throw new Error('Your short position is ' + short.qty + ' shares.');
      cashDelta = -(principal + comm);
      realized = qty * (short.avgPrice - price) - comm;
    } else {
      throw new Error('Unknown action.');
    }

    // Shorting adds a margin obligation; covering releases one.
    var obligationDelta = 0;
    if (action === 'short') obligationDelta = 1.5 * principal;
    if (action === 'cover') obligationDelta = -1.5 * qty * (marks.stock[symbol] != null ? marks.stock[symbol] : price);
    this._checkBuyingPower(cashDelta, obligationDelta, marks, action);

    // apply
    this.d.cash = Util.round2(this.d.cash + cashDelta);
    this.d.realized = Util.round2(this.d.realized + realized);

    if (action === 'buy' || action === 'short') {
      var side = action === 'buy' ? 'long' : 'short';
      var pos = side === 'long' ? long : short;
      if (pos) {
        pos.avgPrice = (pos.avgPrice * pos.qty + principal) / (pos.qty + qty);
        pos.qty += qty;
      } else {
        this.d.positions.push({
          id: Util.uid(), symbol: symbol, side: side, qty: qty,
          avgPrice: price, openedAt: Date.now()
        });
      }
    } else {
      var target = action === 'sell' ? long : short;
      target.qty -= qty;
      if (target.qty <= 0) this._drop(target.id);
    }

    this._log({
      type: action, asset: 'stock', symbol: symbol,
      detail: symbol + ' \u00b7 ' + ({ buy: 'buy', sell: 'sell', short: 'sell short', cover: 'buy to cover' }[action]),
      qty: qty, price: price, amount: Util.round2(cashDelta), realized: Util.round2(realized)
    });
    return { cashDelta: cashDelta, realized: realized };
  };

  /* action: bto | stc | sto | btc  (spec: {symbol,right,strike,expiry}) */
  P.tradeOption = function (spec, action, contracts, premium, marks) {
    contracts = Math.floor(contracts);
    if (!(contracts > 0)) throw new Error('Enter a whole number of contracts.');
    if (!(premium >= 0)) throw new Error('No model price for that contract yet.');

    var comm = (Number(this.d.settings.commissionOption) || 0) * contracts;
    var principal = contracts * MULT * premium;
    var longLeg = this.optionLeg(Object.assign({}, spec, { side: 'long' }));
    var shortLeg = this.optionLeg(Object.assign({}, spec, { side: 'short' }));
    var cashDelta, realized = 0, extraObligation = 0;

    if (action === 'bto') {
      if (shortLeg) throw new Error('You are short that contract — buy it back instead.');
      cashDelta = -(principal + comm);
    } else if (action === 'sto') {
      if (longLeg) throw new Error('You are long that contract — sell it to close instead.');
      cashDelta = principal - comm;
      var S = marks.stock[spec.symbol] || spec.strike;
      extraObligation = contracts * MULT * (0.20 * S + premium);
    } else if (action === 'stc') {
      if (!longLeg) throw new Error('You do not hold that contract.');
      if (contracts > longLeg.contracts) throw new Error('You hold ' + longLeg.contracts + ' contract(s).');
      cashDelta = principal - comm;
      realized = contracts * MULT * (premium - longLeg.premium) - comm;
    } else if (action === 'btc') {
      if (!shortLeg) throw new Error('You are not short that contract.');
      if (contracts > shortLeg.contracts) throw new Error('You are short ' + shortLeg.contracts + ' contract(s).');
      cashDelta = -(principal + comm);
      realized = contracts * MULT * (shortLeg.premium - premium) - comm;
      var Sb = marks.stock[spec.symbol] || spec.strike;
      extraObligation = -(contracts * MULT * (0.20 * Sb + premium));
    } else {
      throw new Error('Unknown action.');
    }

    this._checkBuyingPower(cashDelta, extraObligation, marks, action);

    this.d.cash = Util.round2(this.d.cash + cashDelta);
    this.d.realized = Util.round2(this.d.realized + realized);

    if (action === 'bto' || action === 'sto') {
      var side = action === 'bto' ? 'long' : 'short';
      var leg = side === 'long' ? longLeg : shortLeg;
      if (leg) {
        leg.premium = (leg.premium * leg.contracts + premium * contracts) / (leg.contracts + contracts);
        leg.contracts += contracts;
      } else {
        this.d.options.push({
          id: Util.uid(), symbol: spec.symbol, right: spec.right, side: side,
          contracts: contracts, strike: spec.strike, expiry: spec.expiry,
          premium: premium, openedAt: Date.now()
        });
      }
    } else {
      var t = action === 'stc' ? longLeg : shortLeg;
      t.contracts -= contracts;
      if (t.contracts <= 0) this._dropOption(t.id);
    }

    var names = { bto: 'buy to open', stc: 'sell to close', sto: 'sell to open', btc: 'buy to close' };
    this._log({
      type: action, asset: 'option', symbol: spec.symbol,
      detail: Options.shortLabel(spec) + ' \u00b7 ' + names[action],
      qty: contracts, price: premium, amount: Util.round2(cashDelta), realized: Util.round2(realized)
    });
    return { cashDelta: cashDelta, realized: realized };
  };

  P._checkBuyingPower = function (cashDelta, extraObligation, marks, action) {
    var bpNow = this.buyingPower(marks);
    var after = bpNow + cashDelta - extraObligation;
    if (after < -0.005) {
      var need = Util.money(-after);
      throw new Error('Not enough buying power — you are ' + need + ' short of this order.' +
        (action === 'short' || action === 'sto' ? ' Short positions reserve margin as well as cash.' : ''));
    }
  };

  P._drop = function (id) {
    this.d.positions = this.d.positions.filter(function (p) { return p.id !== id; });
  };
  P._dropOption = function (id) {
    this.d.options = this.d.options.filter(function (o) { return o.id !== id; });
  };
  P._log = function (entry) {
    entry.id = Util.uid();
    entry.ts = Date.now();
    entry.cashAfter = this.d.cash;
    this.d.transactions.push(entry);
    if (this.d.transactions.length > MAX_LOG) this.d.transactions = this.d.transactions.slice(-MAX_LOG);
  };

  /* Cash-settle anything that has expired. Returns a list of what happened. */
  P.settleExpired = function (marks) {
    var today = nyToday();
    var self = this;
    var done = [];
    this.d.options.slice().forEach(function (o) {
      if (o.expiry >= today) return;
      var S = marks.stock[o.symbol];
      var intrinsic = S == null ? 0 : Math.max(0, o.right === 'call' ? S - o.strike : o.strike - S);
      var amount = o.contracts * MULT * intrinsic * (o.side === 'long' ? 1 : -1);
      var realized = (o.side === 'long'
        ? o.contracts * MULT * (intrinsic - o.premium)
        : o.contracts * MULT * (o.premium - intrinsic));
      self.d.cash = Util.round2(self.d.cash + amount);
      self.d.realized = Util.round2(self.d.realized + realized);
      self._log({
        type: 'expiry', asset: 'option', symbol: o.symbol,
        detail: Options.shortLabel(o) + ' \u00b7 expired ' + (intrinsic > 0 ? 'in the money' : 'worthless'),
        qty: o.contracts, price: intrinsic, amount: Util.round2(amount), realized: Util.round2(realized)
      });
      self._dropOption(o.id);
      done.push({ label: Options.shortLabel(o), intrinsic: intrinsic, amount: amount });
    });
    return done;
  };

  // ── valuation ─────────────────────────────────────────────────
  /* ctx: {quotes:{SYM:quote}, vols:{SYM:number}, rate:number} */
  P.value = function (ctx) {
    var rate = ctx.rate != null ? ctx.rate : (this.d.settings.riskFreeRate || 0.04);
    var stockRows = [], optRows = [];
    var stockValue = 0, optValue = 0, dayChange = 0, openPL = 0;
    var marks = { stock: {}, option: {} };

    this.d.positions.forEach(function (p) {
      var q = ctx.quotes[p.symbol];
      var last = q && isFinite(q.last) ? q.last : p.avgPrice;
      var prev = q && isFinite(q.prevClose) ? q.prevClose : last;
      marks.stock[p.symbol] = last;
      var sign = p.side === 'long' ? 1 : -1;
      var value = sign * p.qty * last;
      var dc = sign * p.qty * (last - prev);
      var pl = sign * p.qty * (last - p.avgPrice);
      var basis = p.qty * p.avgPrice;
      stockValue += value;
      dayChange += dc;
      openPL += pl;
      stockRows.push({
        id: p.id, symbol: p.symbol, side: p.side, qty: p.qty, avgPrice: p.avgPrice,
        last: last, prevClose: prev, value: value, dayChange: dc,
        dayChangePct: prev ? (sign * (last - prev) / prev) * 100 : 0,
        openPL: pl, openPLPct: basis ? (pl / basis) * 100 : 0,
        stale: !q
      });
    });

    this.d.options.forEach(function (o) {
      var q = ctx.quotes[o.symbol];
      var S = q && isFinite(q.last) ? q.last : o.strike;
      var prevS = q && isFinite(q.prevClose) ? q.prevClose : S;
      var vol = ctx.vols[o.symbol];
      var now = Options.contract(o, S, vol, rate);
      var then = Options.contract(o, prevS, vol, rate);
      var px = now ? now.value : 0;
      var pxPrev = then ? then.value : px;
      marks.option[o.id] = px;
      var sign = o.side === 'long' ? 1 : -1;
      var value = sign * o.contracts * MULT * px;
      var dc = sign * o.contracts * MULT * (px - pxPrev);
      var pl = sign * o.contracts * MULT * (px - o.premium);
      var basis = o.contracts * MULT * o.premium;
      optValue += value;
      dayChange += dc;
      openPL += pl;
      optRows.push({
        id: o.id, symbol: o.symbol, right: o.right, side: o.side, contracts: o.contracts,
        strike: o.strike, expiry: o.expiry, premium: o.premium, label: Options.shortLabel(o),
        model: px, value: value, dayChange: dc,
        dayChangePct: pxPrev ? (sign * (px - pxPrev) / pxPrev) * 100 : 0,
        openPL: pl, openPLPct: basis ? (pl / basis) * 100 : 0,
        days: Util.daysTo(o.expiry), iv: now ? now.iv : null, delta: now ? now.delta : null,
        stale: !q
      });
    });

    var total = this.d.cash + stockValue + optValue;
    var obligations = this.obligations(marks);
    var prevTotal = total - dayChange;

    return {
      cash: this.d.cash,
      stockValue: stockValue,
      optionValue: optValue,
      invested: stockValue + optValue,
      total: total,
      dayChange: dayChange,
      dayChangePct: prevTotal ? (dayChange / Math.abs(prevTotal)) * 100 : 0,
      openPL: openPL,
      realized: this.d.realized,
      totalReturn: total - this.d.startingCash,
      totalReturnPct: this.d.startingCash ? ((total - this.d.startingCash) / this.d.startingCash) * 100 : 0,
      obligations: obligations,
      buyingPower: this.d.cash - obligations,
      marginCall: this.d.cash - obligations < 0,
      stockRows: stockRows,
      optRows: optRows,
      marks: marks
    };
  };

  /* Record a valuation point; keeps the running high/low water marks. */
  P.mark = function (total) {
    if (!isFinite(total)) return;
    var s = this.d.stats;
    var now = Date.now();
    if (!isFinite(s.high) || total > s.high) { s.high = total; s.highAt = now; }
    if (!isFinite(s.low) || total < s.low) { s.low = total; s.lowAt = now; }
    var curve = this.d.equityCurve;
    var last = curve[curve.length - 1];
    if (!last || now - last.t > 60000) {
      curve.push({ t: now, v: Util.round2(total) });
      if (curve.length > MAX_CURVE) {
        // thin the oldest half rather than dropping history entirely
        var head = curve.slice(0, curve.length - 500).filter(function (_, i) { return i % 2 === 0; });
        this.d.equityCurve = head.concat(curve.slice(-500));
      }
    } else {
      last.v = Util.round2(total);
      last.t = now;
    }
  };

  // ── CSV export of the book ────────────────────────────────────
  P.toCsv = function (val) {
    var rows = [['section', 'symbol', 'position', 'quantity', 'avg_cost', 'last_or_model', 'market_value', 'day_change', 'open_pl', 'detail']];
    rows.push(['summary', '', 'cash', '', '', '', Util.round2(this.d.cash), '', '', this.d.name]);
    (val ? val.stockRows : []).forEach(function (r) {
      rows.push(['stock', r.symbol, r.side, r.qty, Util.round2(r.avgPrice), Util.round2(r.last),
        Util.round2(r.value), Util.round2(r.dayChange), Util.round2(r.openPL), '']);
    });
    (val ? val.optRows : []).forEach(function (r) {
      rows.push(['option', r.symbol, r.side, r.contracts, Util.round2(r.premium), Util.round2(r.model),
        Util.round2(r.value), Util.round2(r.dayChange), Util.round2(r.openPL), r.label]);
    });
    rows.push([]);
    rows.push(['transactions']);
    rows.push(['timestamp', 'action', 'asset', 'symbol', 'detail', 'quantity', 'price', 'cash_effect', 'realized_pl', 'cash_after']);
    this.d.transactions.forEach(function (t) {
      rows.push([new Date(t.ts).toISOString(), t.type, t.asset, t.symbol, t.detail,
        t.qty, Util.round2(t.price), Util.round2(t.amount), Util.round2(t.realized || 0), Util.round2(t.cashAfter)]);
    });
    return Util.toCsv(rows);
  };

  Portfolio.SCHEMA = SCHEMA;
  global.Portfolio = Portfolio;
})(window);
