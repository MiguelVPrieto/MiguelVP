/* Blotter — application controller. */
(function (global) {
  'use strict';

  var $ = Util.$;

  var state = {
    book: null,
    symbol: null,
    quotes: {},          // SYM -> quote
    vols: {},            // SYM -> annualised vol
    volPending: {},
    range: '1D',
    bars: [],
    val: null,           // last valuation
    chart: null,
    timer: null,
    asset: 'stock',
    action: 'buy',
    searchIdx: 0,
    searchRows: [],
    busy: false
  };

  var settings = {
    provider: 'twelvedata',
    apiKey: '',
    refreshSec: 60,
    nasdaqOnly: true,
    rfr: 4.3,
    commStock: 0,
    commOpt: 0.65
  };

  // ══ settings ═══════════════════════════════════════════════════
  function loadSettings() {
    var raw = Util.ls.get('settings');
    if (raw) { try { Object.assign(settings, JSON.parse(raw)); } catch (e) { /* ignore */ } }
    Market.providerId = settings.provider;
    Market.apiKey = settings.apiKey;
    Market.nasdaqOnly = settings.nasdaqOnly;
  }
  function saveSettings() {
    Util.ls.set('settings', JSON.stringify(settings));
    Market.providerId = settings.provider;
    Market.apiKey = settings.apiKey;
    Market.nasdaqOnly = settings.nasdaqOnly;
  }
  function rate() { return (Number(settings.rfr) || 0) / 100; }

  // ══ gate ═══════════════════════════════════════════════════════
  function initGate() {
    var drop = $('drop'), input = $('fileInput');

    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]);
    });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) openFile(input.files[0]);
    });

    $('createBtn').addEventListener('click', function () {
      var name = $('newName').value.trim() || 'My paper account';
      var cash = Math.max(1000, Math.round(Number($('newCash').value) || 100000));
      var book = Portfolio.create(name, cash);
      book.d.settings.commissionStock = settings.commStock;
      book.d.settings.commissionOption = settings.commOpt;
      book.d.settings.riskFreeRate = rate();
      openBook(book);
    });

    var saved = Util.ls.get('book');
    if (saved) {
      try {
        var p = Portfolio.parse(saved);
        $('restoreNote').textContent = 'This browser has an autosaved copy of "' + p.d.name + '" from ' + Util.stamp(p.d.updatedAt) + '.';
        $('restoreNote').hidden = false;
        var btn = $('restoreLast');
        btn.hidden = false;
        btn.addEventListener('click', function () { openBook(Portfolio.parse(saved)); });
      } catch (e) { Util.ls.del('book'); }
    }
  }

  function openFile(file) {
    Util.readFile(file).then(function (text) {
      openBook(Portfolio.parse(text));
      Util.toast('Book opened.', 'good');
    }).catch(function (err) {
      Util.toast(err.message, 'bad');
    });
  }

  // ══ boot the app ═══════════════════════════════════════════════
  function openBook(book) {
    state.book = book;
    settings.commStock = book.d.settings.commissionStock;
    settings.commOpt = book.d.settings.commissionOption;
    settings.rfr = (book.d.settings.riskFreeRate || 0.043) * 100;
    saveSettings();

    $('gate').hidden = true;
    $('app').hidden = false;
    $('acctName').textContent = book.d.name + ' \u00b7 opened ' + Util.shortDate(book.d.createdAt);

    state.chart = new PriceChart($('priceChart'), { onHover: onChartHover });
    fillSettingsForm();
    updateFeedPill();
    renderAll();
    autosave();

    var first = book.symbols()[0] || 'AAPL';
    selectSymbol(first, { quiet: true });
    scheduleRefresh();
    refresh({ force: true });

    if (!Market.ready()) {
      banner('No market-data key yet. Open Settings to paste a free key, or switch to the demo feed to look around.');
    }
  }

  // ══ refresh cycle ══════════════════════════════════════════════
  function scheduleRefresh() {
    if (state.timer) clearInterval(state.timer);
    var sec = Number(settings.refreshSec) || 0;
    if (sec > 0) {
      state.timer = setInterval(function () {
        if (!document.hidden) refresh({});
      }, Math.max(15, sec) * 1000);
    }
  }

  function neededSymbols() {
    var list = state.book ? state.book.symbols() : [];
    if (state.symbol && list.indexOf(state.symbol) === -1) list.push(state.symbol);
    return list;
  }

  function refresh(opts) {
    opts = opts || {};
    if (!state.book) return Promise.resolve();
    var syms = neededSymbols();
    if (!syms.length) { revalue(); return Promise.resolve(); }
    if (!Market.ready()) { revalue(); return Promise.resolve(); }

    setBusy(true);
    return Market.quotes(syms, { force: opts.force })
      .then(function (map) {
        Object.assign(state.quotes, map);
        clearBanner();
        return ensureVols(state.book.d.options.map(function (o) { return o.symbol; }));
      })
      .then(function () {
        var settled = state.book.settleExpired(currentMarks());
        settled.forEach(function (s) {
          Util.toast(s.label + ' expired ' + (s.intrinsic > 0 ? 'in the money (' + Util.money(s.amount) + ')' : 'worthless') + '.',
            s.intrinsic > 0 ? 'good' : null);
        });
        revalue();
        renderQuoteHeader();
        autosave();
      })
      .catch(function (err) {
        banner(err.message);
        revalue();
      })
      .then(function () { setBusy(false); });
  }

  function ensureVols(symbols) {
    var todo = symbols.filter(function (s) {
      return state.vols[s] == null && !state.volPending[s];
    }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (!todo.length) return Promise.resolve();
    return Promise.all(todo.map(function (s) {
      state.volPending[s] = true;
      return Market.dailyCloses(s).then(function (closes) {
        state.vols[s] = Options.realisedVol(closes) || 0.32;
      }).catch(function () {
        state.vols[s] = 0.32;
      }).then(function () { delete state.volPending[s]; });
    }));
  }

  function currentMarks() {
    var marks = state.val ? { stock: Object.assign({}, state.val.marks.stock), option: Object.assign({}, state.val.marks.option) }
      : { stock: {}, option: {} };
    Object.keys(state.quotes).forEach(function (s) {
      if (isFinite(state.quotes[s].last)) marks.stock[s] = state.quotes[s].last;
    });
    return marks;
  }

  function revalue() {
    if (!state.book) return;
    state.val = state.book.value({ quotes: state.quotes, vols: state.vols, rate: rate() });
    state.book.mark(state.val.total);
    renderAll();
  }

  function setBusy(on) {
    state.busy = on;
    var b = $('refreshBtn');
    if (b) { b.disabled = on; b.textContent = on ? 'Refreshing…' : 'Refresh'; }
  }

  function autosave() {
    if (!state.book) return;
    Util.ls.set('book', state.book.toJson());
  }

  function banner(msg) {
    $('bannerText').textContent = msg;
    $('banner').hidden = false;
  }
  function clearBanner() {
    if (state.val && state.val.marginCall) {
      banner('Margin call: your obligations exceed your cash. Close some short exposure.');
      return;
    }
    $('banner').hidden = true;
  }

  // ══ symbol selection ═══════════════════════════════════════════
  function selectSymbol(symbol, opts) {
    opts = opts || {};
    symbol = String(symbol || '').toUpperCase().trim();
    if (!symbol) return;
    state.symbol = symbol;
    $('tSymbol').value = symbol;
    Util.setText('qSym', symbol);
    Util.setText('qName', 'Loading…');
    renderTicket();

    if (!Market.ready()) {
      Util.setText('qName', 'Set a market-data key in Settings to load prices.');
      return;
    }
    Market.quote(symbol).then(function (q) {
      state.quotes[symbol] = q;
      renderQuoteHeader();
      clearBanner();
      return ensureVols([symbol]);
    }).then(function () {
      renderTicket();
      revalue();
    }).catch(function (err) {
      Util.setText('qName', err.message);
      if (!opts.quiet) Util.toast(err.message, 'bad');
    });
    loadSeries();
  }

  function loadSeries() {
    var sym = state.symbol;
    if (!sym || !Market.ready()) return;
    $('chartEmpty').textContent = 'Loading ' + sym + '…';
    $('chartEmpty').hidden = false;
    Market.series(sym, state.range).then(function (s) {
      if (state.symbol !== sym) return;
      state.bars = s.bars;
      if (!s.bars.length) {
        $('chartEmpty').textContent = 'This feed returned no history for ' + sym + '.';
        $('chartEmpty').hidden = false;
        state.chart.setData([], {});
        return;
      }
      $('chartEmpty').hidden = true;
      var q = state.quotes[sym];
      state.chart.setData(s.bars, {
        prevClose: state.range === '1D' && q ? q.prevClose : undefined,
        intraday: /min|h$/.test(s.interval)
      });
    }).catch(function (err) {
      if (state.symbol !== sym) return;
      state.chart.setData([], {});
      $('chartEmpty').textContent = err.message;
      $('chartEmpty').hidden = false;
    });
  }

  function onChartHover(bar) {
    if (!bar) { $('chartReadout').textContent = ''; return; }
    var d = new Date(bar.t);
    $('chartReadout').textContent =
      d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) +
      '   O ' + Util.px(bar.o) + '  H ' + Util.px(bar.h) + '  L ' + Util.px(bar.l) + '  C ' + Util.px(bar.c);
  }

  // ══ rendering ══════════════════════════════════════════════════
  function renderAll() {
    renderDashboard();
    renderStockTable();
    renderOptionTable();
    renderLog();
    renderTicket();
    renderSession();
  }

  function renderSession() {
    var s = Util.marketSession();
    var pill = $('marketPill');
    var text = { open: 'Market open', pre: 'Pre-market', post: 'After hours', closed: 'Market closed', weekend: 'Weekend' }[s];
    pill.textContent = text;
    pill.className = 'pill' + (s === 'open' ? '' : ' pill--closed');
    $('lastTick').textContent = 'Last update ' + Util.clock();
  }

  function updateFeedPill() {
    var info = Market.providerInfo();
    var pill = $('feedPill');
    pill.textContent = Market.isDemo() ? 'Demo data — not real' : info.label;
    pill.className = 'pill pill--quiet' + (Market.isDemo() ? ' pill--warn' : '');
  }

  function renderDashboard() {
    var v = state.val;
    if (!v) return;
    Util.setText('statValue', Util.money(v.total));
    Util.setText('statDay', Util.signedMoney(v.dayChange) + '  (' + Util.signedPct(v.dayChangePct) + ') today', Util.dirClass(v.dayChange));
    Util.setText('statCash', Util.money(v.cash));
    Util.setText('statBuyingPower', 'Buying power ' + Util.money(v.buyingPower));
    Util.setText('statInvested', Util.money(v.invested));
    Util.setText('statPositions', v.stockRows.length + ' stock \u00b7 ' + v.optRows.length + ' option');
    Util.setText('statHigh', Util.money(state.book.d.stats.high));
    Util.setText('statHighAt', Util.stamp(state.book.d.stats.highAt));
    Util.setText('statLow', Util.money(state.book.d.stats.low));
    Util.setText('statLowAt', Util.stamp(state.book.d.stats.lowAt));
    Util.setText('statPnl', Util.signedMoney(v.totalReturn), Util.dirClass(v.totalReturn));
    Util.setText('statPnlPct', Util.signedPct(v.totalReturnPct) + ' since ' + Util.money(state.book.d.startingCash, true));

    var curve = state.book.d.equityCurve.map(function (p) { return p.v; });
    sparkline($('equitySpark'), curve.slice(-160), v.totalReturn >= 0 ? '--long' : '--short');

    if (v.marginCall) clearBanner();
  }

  function renderQuoteHeader() {
    var q = state.quotes[state.symbol];
    if (!q) return;
    Util.setText('qSym', q.symbol);
    Util.setText('qName', (q.name || 'NASDAQ listing') + (q.exchange ? ' \u00b7 ' + q.exchange : '') + (q.demo ? ' \u00b7 simulated' : ''));
    Util.setText('qLast', Util.px(q.last));
    var chg = q.last - q.prevClose;
    var pct = q.prevClose ? (chg / q.prevClose) * 100 : 0;
    Util.setText('qChg', Util.signedMoney(chg) + '  ' + Util.signedPct(pct), Util.dirClass(chg));
    Util.setText('qOpen', Util.px(q.open));
    Util.setText('qHigh', Util.px(q.high));
    Util.setText('qLow', Util.px(q.low));
    Util.setText('qPrev', Util.px(q.prevClose));
    Util.setText('qVol', Util.volume(q.volume));
    var vol = state.vols[q.symbol];
    Util.setText('qIv', vol ? (vol * 100).toFixed(1) + '%' : '—');
  }

  function cell(text, cls) {
    var td = Util.el('td', cls || null);
    td.textContent = text;
    return td;
  }
  function numCell(text, cls) {
    var td = Util.el('td', 'num mono' + (cls ? ' ' + cls : ''));
    td.textContent = text;
    return td;
  }

  function renderStockTable() {
    var body = $('stockRows');
    body.innerHTML = '';
    var rows = state.val ? state.val.stockRows : [];
    $('stockEmpty').hidden = rows.length > 0;
    var totalDay = 0, totalVal = 0;
    rows.forEach(function (r) {
      totalDay += r.dayChange; totalVal += r.value;
      var tr = Util.el('tr');

      var symTd = Util.el('td');
      var sym = Util.el('span', 'sym sym--link', r.symbol);
      sym.addEventListener('click', function () { selectSymbol(r.symbol); });
      symTd.appendChild(sym);
      tr.appendChild(symTd);

      var posTd = Util.el('td');
      posTd.appendChild(Util.el('span', 'tag tag--' + r.side, r.side));
      tr.appendChild(posTd);

      tr.appendChild(numCell(Util.num(r.qty)));
      tr.appendChild(numCell(Util.px(r.avgPrice)));
      tr.appendChild(numCell(Util.px(r.last) + (r.stale ? ' *' : '')));
      tr.appendChild(numCell(Util.money(r.value)));
      tr.appendChild(numCell(Util.signedMoney(r.dayChange) + '  ' + Util.signedPct(r.dayChangePct), Util.dirClass(r.dayChange)));
      tr.appendChild(numCell(Util.signedMoney(r.openPL) + '  ' + Util.signedPct(r.openPLPct), Util.dirClass(r.openPL)));

      var actTd = Util.el('td', 'num');
      var close = Util.el('button', 'btn btn--ghost btn--sm', r.side === 'long' ? 'Sell' : 'Cover');
      close.addEventListener('click', function () {
        selectSymbol(r.symbol);
        setAsset('stock');
        setAction(r.side === 'long' ? 'sell' : 'cover');
        $('tQty').value = r.qty;
        renderTicket();
        $('ticket').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      actTd.appendChild(close);
      tr.appendChild(actTd);
      body.appendChild(tr);
    });
    $('stockTotals').textContent = rows.length
      ? Util.money(totalVal) + '  \u00b7  ' + Util.signedMoney(totalDay) + ' today' : '';
  }

  function renderOptionTable() {
    var body = $('optRows');
    body.innerHTML = '';
    var rows = state.val ? state.val.optRows : [];
    $('optEmpty').hidden = rows.length > 0;
    var totalDay = 0, totalVal = 0;
    rows.forEach(function (r) {
      totalDay += r.dayChange; totalVal += r.value;
      var tr = Util.el('tr');

      var cTd = Util.el('td');
      var lbl = Util.el('span', 'sym sym--link', r.label);
      lbl.addEventListener('click', function () { selectSymbol(r.symbol); });
      cTd.appendChild(lbl);
      var sub = Util.el('div');
      sub.style.cssText = 'font-size:11px;color:var(--ink-3);margin-top:2px';
      sub.textContent = r.days + 'd to expiry \u00b7 IV ' + (r.iv ? (r.iv * 100).toFixed(1) + '%' : '—') +
        ' \u00b7 \u0394 ' + (r.delta != null ? r.delta.toFixed(2) : '—');
      cTd.appendChild(sub);
      tr.appendChild(cTd);

      var posTd = Util.el('td');
      posTd.appendChild(Util.el('span', 'tag tag--' + r.side, r.side === 'long' ? 'long' : 'short'));
      tr.appendChild(posTd);

      tr.appendChild(numCell(Util.num(r.contracts)));
      tr.appendChild(numCell(Util.px(r.premium)));
      tr.appendChild(numCell(Util.px(r.model)));
      tr.appendChild(numCell(Util.money(r.value)));
      tr.appendChild(numCell(Util.signedMoney(r.dayChange), Util.dirClass(r.dayChange)));
      tr.appendChild(numCell(Util.signedMoney(r.openPL) + '  ' + Util.signedPct(r.openPLPct), Util.dirClass(r.openPL)));

      var actTd = Util.el('td', 'num');
      var close = Util.el('button', 'btn btn--ghost btn--sm', 'Close');
      close.addEventListener('click', function () {
        selectSymbol(r.symbol);
        setAsset('option');
        setAction(r.side === 'long' ? 'stc' : 'btc');
        pendingContract = { right: r.right, strike: r.strike, expiry: r.expiry, contracts: r.contracts };
        renderTicket();
        $('ticket').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      actTd.appendChild(close);
      tr.appendChild(actTd);
      body.appendChild(tr);
    });
    $('optTotals').textContent = rows.length
      ? Util.money(totalVal) + '  \u00b7  ' + Util.signedMoney(totalDay) + ' today' : '';
  }

  function renderLog() {
    var body = $('logRows');
    body.innerHTML = '';
    var tx = state.book ? state.book.d.transactions.slice().reverse() : [];
    $('logEmpty').hidden = tx.length > 0;
    tx.slice(0, 200).forEach(function (t) {
      var tr = Util.el('tr');
      tr.appendChild(cell(Util.stamp(t.ts), 'mono'));
      tr.appendChild(cell(t.type.toUpperCase(), 'mono'));
      tr.appendChild(cell(t.detail));
      tr.appendChild(numCell(Util.num(t.qty)));
      tr.appendChild(numCell(Util.px(t.price)));
      tr.appendChild(numCell(Util.signedMoney(t.amount), Util.dirClass(t.amount)));
      body.appendChild(tr);
    });
  }

  // ══ order ticket ═══════════════════════════════════════════════
  var STOCK_ACTIONS = [
    { id: 'buy', label: 'Buy', note: 'open / add long', kind: 'buy' },
    { id: 'sell', label: 'Sell', note: 'close long', kind: 'sell' },
    { id: 'short', label: 'Sell short', note: 'open short', kind: 'sell' },
    { id: 'cover', label: 'Buy to cover', note: 'close short', kind: 'buy' }
  ];
  var OPTION_ACTIONS = [
    { id: 'bto', label: 'Buy to open', note: 'long the contract', kind: 'buy' },
    { id: 'stc', label: 'Sell to close', note: 'exit a long', kind: 'sell' },
    { id: 'sto', label: 'Sell to open', note: 'write the contract', kind: 'sell' },
    { id: 'btc', label: 'Buy to close', note: 'exit a short', kind: 'buy' }
  ];
  var pendingContract = null;

  function setAsset(a) {
    state.asset = a;
    Array.prototype.forEach.call(document.querySelectorAll('#assetSeg .seg'), function (b) {
      b.classList.toggle('is-on', b.dataset.asset === a);
    });
    $('optFields').hidden = a !== 'option';
    $('qtyLabel').textContent = a === 'option' ? 'Contracts' : 'Shares';
    if (a === 'option' && ['buy', 'sell', 'short', 'cover'].indexOf(state.action) >= 0) state.action = 'bto';
    if (a === 'stock' && ['bto', 'stc', 'sto', 'btc'].indexOf(state.action) >= 0) state.action = 'buy';
    $('tQty').value = a === 'option' ? 1 : 10;
    buildQuickQty();
  }
  function setAction(id) { state.action = id; }

  function buildActions() {
    var wrap = $('tActions');
    wrap.innerHTML = '';
    var list = state.asset === 'stock' ? STOCK_ACTIONS : OPTION_ACTIONS;
    var book = state.book;
    var sym = state.symbol;
    var spec = optionSpec();

    list.forEach(function (a) {
      var disabled = false;
      if (state.asset === 'stock') {
        if (!sym) disabled = a.id !== 'buy';
        else if (a.id === 'sell') disabled = !book.position(sym, 'long');
        else if (a.id === 'cover') disabled = !book.position(sym, 'short');
      } else if (spec) {
        if (a.id === 'stc') disabled = !book.optionLeg(Object.assign({}, spec, { side: 'long' }));
        if (a.id === 'btc') disabled = !book.optionLeg(Object.assign({}, spec, { side: 'short' }));
      }
      var btn = Util.el('button', 'act act--' + a.kind + (state.action === a.id ? ' is-on' : ''));
      btn.type = 'button';
      btn.disabled = disabled;
      btn.appendChild(Util.el('b', null, a.label));
      btn.appendChild(Util.el('small', null, a.note));
      btn.addEventListener('click', function () { setAction(a.id); renderTicket(); });
      wrap.appendChild(btn);
    });

    if (list.filter(function (a) { return a.id === state.action; }).length === 0) {
      state.action = list[0].id;
    }
    var chosen = list.filter(function (a) { return a.id === state.action; })[0];
    var t = $('ticket');
    t.classList.toggle('is-buy', chosen && chosen.kind === 'buy');
    t.classList.toggle('is-sell', chosen && chosen.kind === 'sell');
  }

  function buildQuickQty() {
    var wrap = $('quickQty');
    wrap.innerHTML = '';
    var vals = state.asset === 'option' ? [1, 2, 5, 10] : [10, 50, 100];
    vals.forEach(function (v) {
      var b = Util.el('button', null, String(v));
      b.type = 'button';
      b.addEventListener('click', function () { $('tQty').value = v; renderTicket(); });
      wrap.appendChild(b);
    });
    if (state.asset === 'stock') {
      var max = Util.el('button', null, 'Max');
      max.type = 'button';
      max.addEventListener('click', function () {
        var px = refPrice();
        if (!px || !state.val) return;
        var bp = state.val.buyingPower - (Number(settings.commStock) || 0);
        var divisor = state.action === 'short' ? px * 0.5 : px;
        $('tQty').value = Math.max(0, Math.floor(bp / divisor));
        renderTicket();
      });
      wrap.appendChild(max);
    }
  }

  function buildOptionSelectors() {
    var q = state.quotes[state.symbol];
    var expSel = $('tExpiry'), strSel = $('tStrike');
    var exps = Options.expiries();
    if (pendingContract && exps.indexOf(pendingContract.expiry) === -1) exps.unshift(pendingContract.expiry);
    var keepExp = pendingContract ? pendingContract.expiry : expSel.value;
    expSel.innerHTML = '';
    exps.forEach(function (e) {
      var o = Util.el('option', null, e + '  (' + Util.daysTo(e) + 'd)');
      o.value = e;
      expSel.appendChild(o);
    });
    if (keepExp && exps.indexOf(keepExp) >= 0) expSel.value = keepExp;

    var S = q && isFinite(q.last) ? q.last : null;
    var keepStrike = pendingContract ? pendingContract.strike : parseFloat(strSel.value);
    strSel.innerHTML = '';
    if (!S) {
      strSel.appendChild(Util.el('option', null, 'Load a quote first'));
      return;
    }
    var strikes = Options.strikes(S, 21);
    if (keepStrike && strikes.indexOf(keepStrike) === -1) strikes.push(keepStrike);
    strikes.sort(function (a, b) { return a - b; });
    strikes.forEach(function (k) {
      var atm = Math.abs(k - S) < Options.strikeStep(S) / 2 ? '   ATM' : '';
      var o = Util.el('option', null, Util.px(k) + atm);
      o.value = k;
      strSel.appendChild(o);
    });
    strSel.value = (keepStrike && strikes.indexOf(keepStrike) >= 0) ? keepStrike
      : strikes[Math.round(strikes.length / 2) - 1];

    if (pendingContract) {
      $('tRight').value = pendingContract.right;
      if (pendingContract.contracts) $('tQty').value = pendingContract.contracts;
      pendingContract = null;
    }
  }

  function optionSpec() {
    if (state.asset !== 'option' || !state.symbol) return null;
    var strike = parseFloat($('tStrike').value);
    var expiry = $('tExpiry').value;
    if (!isFinite(strike) || !expiry) return null;
    return { symbol: state.symbol, right: $('tRight').value, strike: strike, expiry: expiry };
  }

  function refPrice() {
    var q = state.quotes[state.symbol];
    if (!q || !isFinite(q.last)) return null;
    if (state.asset === 'stock') return q.last;
    var spec = optionSpec();
    if (!spec) return null;
    var c = Options.contract(spec, q.last, state.vols[state.symbol], rate());
    return c ? Util.round2(c.value) : null;
  }

  function renderTicket() {
    if (!state.book) return;
    if (state.asset === 'option') buildOptionSelectors();
    buildActions();

    var q = state.quotes[state.symbol];
    var px = refPrice();
    var qty = Math.floor(Number($('tQty').value) || 0);
    var isOption = state.asset === 'option';
    var mult = isOption ? Options.MULT : 1;
    var comm = isOption ? (Number(settings.commOpt) || 0) * qty : (Number(settings.commStock) || 0);
    var principal = px != null ? px * qty * mult : null;
    var isBuySide = ['buy', 'cover', 'bto', 'btc'].indexOf(state.action) >= 0;
    var net = principal == null ? null : (isBuySide ? -(principal + comm) : principal - comm);

    // greeks
    if (isOption) {
      var g = $('greeks');
      g.innerHTML = '';
      var spec = optionSpec();
      var c = (spec && q && isFinite(q.last)) ? Options.contract(spec, q.last, state.vols[state.symbol], rate()) : null;
      [['Delta', c ? c.delta.toFixed(3) : '—'],
       ['Gamma', c ? c.gamma.toFixed(4) : '—'],
       ['Theta', c ? c.theta.toFixed(3) : '—'],
       ['IV', c ? (c.iv * 100).toFixed(1) + '%' : '—']].forEach(function (pair) {
        var d = Util.el('div');
        d.appendChild(Util.el('dt', null, pair[0]));
        d.appendChild(Util.el('dd', null, pair[1]));
        g.appendChild(d);
      });
    }

    Util.setText('sPrice', px == null ? '—' : Util.px(px) + (isOption ? ' \u00d7 100' : ''));
    Util.setText('sPrincipal', principal == null ? '—' : Util.money(principal));
    Util.setText('sComm', Util.money(comm));
    Util.setText('sNetLabel', isBuySide ? 'Cash out' : 'Cash in');
    Util.setText('sNet', net == null ? '—' : Util.signedMoney(net), Util.dirClass(net));

    // dry-run validation
    var warn = $('tWarn');
    var ok = false;
    var bpAfter = null;
    if (px == null) {
      warn.textContent = Market.ready() ? 'Waiting for a price on ' + (state.symbol || 'this symbol') + '.' : 'Set a market-data key in Settings first.';
      warn.hidden = false;
    } else if (!(qty > 0)) {
      warn.textContent = 'Enter a quantity.';
      warn.hidden = false;
    } else {
      try {
        var probe = state.book.probe();
        if (isOption) probe.tradeOption(optionSpec(), state.action, qty, px, currentMarks());
        else probe.tradeStock(state.symbol, state.action, qty, px, currentMarks());
        var pv = probe.value({ quotes: state.quotes, vols: state.vols, rate: rate() });
        bpAfter = pv.buyingPower;
        ok = true;
        warn.hidden = true;
      } catch (err) {
        warn.textContent = err.message;
        warn.hidden = false;
      }
    }
    Util.setText('sBp', bpAfter == null ? (state.val ? Util.money(state.val.buyingPower) : '—') : Util.money(bpAfter));
    $('tSubmit').disabled = !ok;
    $('tSubmit').textContent = ok
      ? (isBuySide ? 'Place buy order' : 'Place sell order')
      : 'Place order';
  }

  function submitTicket(e) {
    e.preventDefault();
    var px = refPrice();
    var qty = Math.floor(Number($('tQty').value) || 0);
    try {
      if (state.asset === 'option') {
        state.book.tradeOption(optionSpec(), state.action, qty, px, currentMarks());
      } else {
        state.book.tradeStock(state.symbol, state.action, qty, px, currentMarks());
      }
      stampTicket();
      Util.toast('Filled: ' + qty + ' ' + (state.asset === 'option' ? 'contract(s)' : 'share(s)') +
        ' of ' + state.symbol + ' at ' + Util.px(px) + '.', 'good');
      revalue();
      autosave();
    } catch (err) {
      Util.toast(err.message, 'bad');
      renderTicket();
    }
  }

  function stampTicket() {
    var t = $('ticket');
    var old = t.querySelector('.stamp');
    if (old) old.remove();
    var s = Util.el('div', 'stamp', 'Filled');
    t.appendChild(s);
    setTimeout(function () { s.remove(); }, 1400);
  }

  // ══ search ═════════════════════════════════════════════════════
  var searchTimer = null;
  function openSearch(prefill) {
    $('searchModal').hidden = false;
    var input = $('searchInput');
    input.value = prefill || '';
    input.focus();
    input.select();
    if (prefill) runSearch();
    else { $('searchResults').innerHTML = ''; $('searchHint').textContent = 'Type a ticker or company name.'; }
  }
  function closeSearch() { $('searchModal').hidden = true; }

  function runSearch() {
    var q = $('searchInput').value.trim();
    if (!q) { $('searchResults').innerHTML = ''; return; }
    $('searchHint').textContent = 'Searching…';
    Market.search(q).then(function (rows) {
      state.searchRows = rows;
      state.searchIdx = 0;
      var ul = $('searchResults');
      ul.innerHTML = '';
      if (!rows.length) {
        $('searchHint').textContent = 'Nothing matched "' + q + '"' + (Market.nasdaqOnly ? ' on NASDAQ. Untick the filter to widen it.' : '.');
        return;
      }
      $('searchHint').textContent = rows.length + ' match(es). Enter opens the highlighted one.';
      rows.forEach(function (r, i) {
        var li = Util.el('li');
        if (i === 0) li.classList.add('is-on');
        li.appendChild(Util.el('span', 'rSym', r.symbol));
        li.appendChild(Util.el('span', 'rName', r.name));
        li.appendChild(Util.el('span', 'rEx', r.exchange || ''));
        li.addEventListener('click', function () { pickSearch(i); });
        ul.appendChild(li);
      });
    }).catch(function (err) {
      $('searchHint').textContent = err.message;
    });
  }

  function pickSearch(i) {
    var r = state.searchRows[i];
    if (!r) return;
    closeSearch();
    selectSymbol(r.symbol);
  }
  function moveSearch(delta) {
    var items = $('searchResults').children;
    if (!items.length) return;
    items[state.searchIdx].classList.remove('is-on');
    state.searchIdx = Util.clamp(state.searchIdx + delta, 0, items.length - 1);
    items[state.searchIdx].classList.add('is-on');
    items[state.searchIdx].scrollIntoView({ block: 'nearest' });
  }

  // ══ settings modal ═════════════════════════════════════════════
  function fillSettingsForm() {
    $('provider').value = settings.provider;
    $('apiKey').value = settings.apiKey;
    $('refreshSec').value = settings.refreshSec;
    $('nasdaqOnly').checked = settings.nasdaqOnly;
    $('rfr').value = settings.rfr;
    $('apiKey').disabled = !Market.providerInfo(settings.provider).needsKey;
    $('commStock').value = settings.commStock;
    $('commOpt').value = settings.commOpt;
    $('providerHelp').textContent = Market.providerInfo($('provider').value).help;
  }

  function applySettings() {
    settings.provider = $('provider').value;
    settings.apiKey = $('apiKey').value.trim();
    settings.refreshSec = Math.max(0, Number($('refreshSec').value) || 0);
    settings.nasdaqOnly = $('nasdaqOnly').checked;
    settings.rfr = Number($('rfr').value) || 0;
    settings.commStock = Math.max(0, Number($('commStock').value) || 0);
    settings.commOpt = Math.max(0, Number($('commOpt').value) || 0);
    saveSettings();
    if (state.book) {
      state.book.d.settings.commissionStock = settings.commStock;
      state.book.d.settings.commissionOption = settings.commOpt;
      state.book.d.settings.riskFreeRate = rate();
    }
    Market.clearCache();
    state.vols = {};
    updateFeedPill();
    scheduleRefresh();
    $('settingsModal').hidden = true;
    refresh({ force: true });
    loadSeries();
    Util.toast('Settings saved.', 'good');
  }

  function testFeed() {
    var p = $('provider').value;
    var keep = { id: Market.providerId, key: Market.apiKey };
    Market.providerId = p;
    Market.apiKey = $('apiKey').value.trim();
    Market.clearCache();
    $('testResult').textContent = 'Testing…';
    Market.quote('AAPL', { force: true }).then(function (q) {
      $('testResult').textContent = 'Working — AAPL came back at ' + Util.px(q.last) + '.';
    }).catch(function (err) {
      $('testResult').textContent = 'Failed: ' + err.message;
    }).then(function () {
      Market.providerId = keep.id;
      Market.apiKey = keep.key;
      Market.clearCache();
    });
  }

  // ══ wiring ═════════════════════════════════════════════════════
  function wire() {
    $('refreshBtn').addEventListener('click', function () {
      Market.clearCache();
      refresh({ force: true });
      loadSeries();
    });
    $('saveBtn').addEventListener('click', function () {
      Util.downloadText(state.book.filename(), state.book.toJson());
      Util.toast('Book downloaded. Keep it safe — it is your account.', 'good');
    });
    $('exportCsvBtn').addEventListener('click', function () {
      Util.downloadText(state.book.filename().replace(/\.json$/, '.csv'), state.book.toCsv(state.val), 'text/csv');
    });
    $('closeBookBtn').addEventListener('click', function () {
      if (!confirm('Close this book? Download it first if you have not — the autosaved copy only lives in this browser.')) return;
      autosave();
      location.reload();
    });
    $('bannerClose').addEventListener('click', function () { $('banner').hidden = true; });

    $('searchTrigger').addEventListener('click', function () { openSearch(''); });
    $('searchClose').addEventListener('click', closeSearch);
    $('searchModal').addEventListener('click', function (e) { if (e.target === $('searchModal')) closeSearch(); });
    $('searchInput').addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 260);
    });
    $('searchInput').addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSearch(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSearch(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); pickSearch(state.searchIdx); }
      else if (e.key === 'Escape') closeSearch();
    });
    $('nasdaqOnly').addEventListener('change', function () {
      settings.nasdaqOnly = $('nasdaqOnly').checked;
      Market.nasdaqOnly = settings.nasdaqOnly;
      saveSettings();
      runSearch();
    });

    $('settingsBtn').addEventListener('click', function () { fillSettingsForm(); $('settingsModal').hidden = false; });
    $('settingsClose').addEventListener('click', function () { $('settingsModal').hidden = true; });
    $('settingsSave').addEventListener('click', applySettings);
    $('provider').addEventListener('change', function () {
      $('providerHelp').textContent = Market.providerInfo($('provider').value).help;
      $('apiKey').disabled = !Market.providerInfo($('provider').value).needsKey;
    });
    $('testFeed').addEventListener('click', testFeed);

    Array.prototype.forEach.call(document.querySelectorAll('#rangeTabs .tab'), function (tab) {
      tab.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('#rangeTabs .tab'), function (t) { t.classList.remove('is-on'); });
        tab.classList.add('is-on');
        state.range = tab.dataset.range;
        loadSeries();
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('#assetSeg .seg'), function (b) {
      b.addEventListener('click', function () { setAsset(b.dataset.asset); renderTicket(); });
    });
    $('tLookup').addEventListener('click', function () { openSearch($('tSymbol').value.trim()); });
    $('tSymbol').addEventListener('change', function () {
      var v = $('tSymbol').value.trim().toUpperCase();
      if (v) selectSymbol(v);
    });
    $('tSymbol').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('tSymbol').blur(); }
    });
    ['tQty', 'tStrike', 'tExpiry', 'tRight'].forEach(function (id) {
      $(id).addEventListener('change', renderTicket);
    });
    $('tQty').addEventListener('input', renderTicket);
    $('ticket').addEventListener('submit', submitTicket);

    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && !/input|select|textarea/i.test(document.activeElement.tagName)) {
        e.preventDefault(); openSearch('');
      }
      if (e.key === 'Escape') { closeSearch(); $('settingsModal').hidden = true; }
    });

    global.addEventListener('beforeunload', function () { if (state.book) autosave(); });
    setInterval(renderSession, 30000);
  }

  // ══ go ═════════════════════════════════════════════════════════
  loadSettings();
  document.addEventListener('DOMContentLoaded', function () {
    initGate();
    wire();
    setAsset('stock');
  });
})(window);
