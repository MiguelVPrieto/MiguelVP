# Blotter — a NASDAQ paper-trading simulator

A static website. No server, no build step, no bundler, no CDN. Everything runs
in the browser from this folder; the only traffic that leaves your machine is the
call to whichever market-data API you point it at.

```
index.html
css/styles.css
js/util.js         formatting, dates, file read/write
js/market.js       the only outbound network code — quotes, charts, search
js/options.js      Black-Scholes pricing, greeks, synthetic contract chain
js/portfolio.js    positions, cash, margin, valuation, JSON/CSV import & export
js/chart.js        canvas price chart and equity sparkline
js/app.js          UI controller
sample-portfolio.json   a filled-in book you can drop on the opening screen
```

---

## 1. Run it

Double-clicking `index.html` works in most browsers. Serving it locally is more
reliable, because some browsers block `fetch` from `file://` origins:

```bash
cd blotter
python3 -m http.server 8080
# then open http://localhost:8080
```

## 2. Get a free API key

Open **Settings** and pick a feed.

| Feed | Free tier | Quotes | Charts | Search |
|---|---|---|---|---|
| **Twelve Data** *(recommended)* | 800 credits/day, 8 requests/min | yes | yes | yes |
| Finnhub | 60 calls/min | yes | historical candles are a paid endpoint, so charts may fail | yes |
| Demo | — | simulated | simulated | built-in list |

Sign up at `twelvedata.com` or `finnhub.io`, paste the key into Settings, and hit
**Test the feed**. The key is kept in this browser's local storage and is never
written into your portfolio file.

Twelve Data's 8-requests-per-minute ceiling is the tight constraint, so the app
batches every symbol you hold into one quote request, caches responses for 30
seconds, and queues calls behind a rate limiter. Auto-refresh defaults to 60
seconds; set it to `0` to refresh only by hand.

The free plans are delayed or lightly rate-limited rather than institutional
real-time — which matches the 10 min–1 h tolerance you asked for.

## 3. The opening screen

You either drop a `.json` file on the left or create a new book on the right.
Inside the app, **Download book** writes the file back out; **Export CSV** writes
a flat holdings-and-transactions sheet for spreadsheets.

**Why JSON and not CSV or TXT:** the book is a nested structure — positions,
option legs with four identifying fields each, a transaction log, an equity
curve. CSV would need several sheets glued together and would lose types on the
round trip. JSON round-trips exactly, is human-readable and diffable, and the
parser can reject a malformed file cleanly. CSV is still offered one-way, as an
export, because that is the format spreadsheets want.

A copy is also autosaved to browser local storage after each trade, so a
refreshed tab offers to reopen the last session. Treat that as a convenience —
**the file you download is the account.**

### File shape

```jsonc
{
  "schema": "blotter.portfolio",
  "version": 1,
  "name": "My paper account",
  "createdAt": 1786300000000,
  "updatedAt": 1786311858240,
  "startingCash": 100000,
  "cash": 74858.70,
  "realized": 0,
  "settings": { "commissionStock": 0, "commissionOption": 0.65, "riskFreeRate": 0.043 },
  "stats": { "high": 100000, "highAt": 0, "low": 100000, "lowAt": 0 },
  "positions": [
    { "id": "…", "symbol": "AAPL", "side": "long",  "qty": 60,  "avgPrice": 225, "openedAt": 0 },
    { "id": "…", "symbol": "INTC", "side": "short", "qty": 300, "avgPrice": 22,  "openedAt": 0 }
  ],
  "options": [
    { "id": "…", "symbol": "AAPL", "right": "call", "side": "long",
      "contracts": 2, "strike": 240, "expiry": "2026-10-16", "premium": 6.20, "openedAt": 0 }
  ],
  "transactions": [ /* every fill, with cash effect and realised P/L */ ],
  "equityCurve":  [ { "t": 0, "v": 100000 } ]
}
```

`stats.high` / `stats.low` are the running high- and low-water marks of total
portfolio value, so they survive across sessions.

## 4. How the accounting works

**Stock.** Four actions: buy, sell (closes a long), sell short, buy to cover.
You cannot be long and short the same symbol at once — close one side first.
Average cost is weighted on each add; realised P/L is booked on each close.

**Shorting.** A short sale credits the proceeds to cash, and the position then
carries an obligation of 150% of its market value: 100% to buy it back, plus 50%
Reg-T style initial margin. So shorting $20,000 of stock raises cash by $20,000
and reduces buying power by $10,000. Covering releases the obligation.

**Buying power** = cash − obligations. Any order that would push it below zero is
rejected before it fills, with the shortfall named. If prices move against a
short far enough that buying power goes negative, a margin-call banner appears —
the simulator warns rather than liquidating.

**Options.** Buy to open, sell to close, sell to open (writing), buy to close.
100 shares per contract. A written contract reserves 20% of the underlying
notional plus the cost of buying it back. Contracts that pass their expiry are
cash-settled at intrinsic value on the next refresh and logged.

**Day change** is computed per position against each symbol's previous close, so
it is correct the moment you open the app rather than only after it has been
running all day. The holdings' day changes sum exactly to the portfolio's.

## 5. The honest caveat about options

No free data plan publishes a live option chain. Contracts here are **generated
locally and priced with Black-Scholes** on the live underlying:

- volatility = 60-day realised volatility of daily closes, with a plain equity
  skew applied by moneyness (out-of-the-money puts richer, out-of-the-money calls
  cheaper), plus a small short-dated kicker
- rate = the risk-free rate in Settings; dividends ignored
- expiries = the next five Fridays plus monthly third Fridays
- strikes = 21 strikes bracketing spot, at a step scaled to the price

Every leg is opened, marked and settled with the same model, so P/L is
internally consistent and the greeks are real greeks. But these are **model
values, not quotes you could trade on**: there is no bid-ask spread, no real
implied-vol surface, no early exercise, and no assignment risk on short legs.
Stock prices are live; option prices are modelled. The interface says so where
it matters.

If you later get a data plan with an option chain, `js/options.js` is the only
file that needs to change — `Options.contract()` is the seam.

## 6. Other simplifications

- Fills are instant at the last traded price. No spread, slippage, partial fills,
  or order types beyond market.
- Whole shares only. No dividends, splits, or corporate actions.
- Cash earns no interest and margin costs no interest.
- Market-session detection uses regular US hours and ignores exchange holidays.
- The NASDAQ-only filter in search reads the exchange field the feed returns;
  untick it to search all US listings.

## 7. Keyboard

`/` opens search · `↑` `↓` move through results · `Enter` selects · `Esc` closes.

---

Blotter is a simulator. Nothing in it is an order, a quote, or investment advice.
