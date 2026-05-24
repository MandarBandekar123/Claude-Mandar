# Session Checkpoint — 2026-05-24

## Branch
`claude/add-trader-dev-mcp-dJbZq` — all code pushed, clean tree.

---

## What Was Built

### Full AI Hedge Fund System — ETHUSDT 1H, $3k fixed base, 5x leverage

**Backtest result (trader.dev, 4-year):**
- Net Profit: **+257.91%** ($25,791 on $10k)
- Profit Factor: **1.57**
- Max Drawdown: **13.76%**
- Sharpe: **0.999**
- Win Rate: **~40%** (322 trades)

**Strategy:** `strategy_v2_fixed3k.pine` (live on trader.dev as `01KSDS5BCKYSXRET62Z32X17TN`)
- EMA(4800) on 1H as 200-day regime proxy
- ADX(14) sideways filter (threshold 20)
- Hilbert envelope oscillator → expansion edge signal
- Price velocity Z-score for direction + magnitude
- Anti-martingale sizing: `baseCash($3k) × volMult(1–1.5x) × signalMult(1–3x) × streakMult(1–3x)`
- TP 5% / SL 2% / 5x leverage on Bybit

---

## File Structure

```
bot/
  server.js          — Express webhook + processSignal() + startSignalEngine()
  signal-engine.js   — FULL Pine strategy in JS: fetches Bybit 1H OHLCV,
                       runs all indicators, fires signals every hour close
  monitor.js         — 60s poll: detects TP/SL hit, calls updateStreak()
  tracker.js         — SQLite trade log (trades.db)
  bybit.js           — Bybit V5 REST: placeOrder, closePosition, getPrice, getLastFill
  telegram.js        — Rich message templates (signal alert, close, weekly report)
  config.js          — All settings from .env
  deploy.sh          — EC2 one-command setup (Node 22 + PM2)
  .env.example       — Template: TELEGRAM_TOKEN, BYBIT_API_KEY, BYBIT_TESTNET=true

runner/
  backtest_native.py — Python backtest: fetches Binance 1H OHLCV or reads TV CSV,
                       ports ALL Pine indicators, outputs vs trader.dev comparison
  poll-signals.js    — Mac-side bridge (DEPRECATED — signal-engine.js replaced this)
  deploy-live.js     — Deploys/validates strategy on trader.dev MCP

strategy_v2_fixed3k.pine  — The live strategy (deployed on trader.dev)
```

---

## Architecture (final)

```
EC2 (single box, runs 24/7)
  └── server.js (PM2)
        ├── signal-engine.js  — fetches Bybit 1H candles every hour close
        │     runs: ADX → htfEMA → envelope → priceVelZ → sizing
        │     fires: processSignal({side, price, effCash, ...})
        ├── processSignal()   — closes opposite pos → Bybit order → Telegram → SQLite
        ├── monitor.js        — 60s poll: TP/SL hit → updateStreak() → Telegram
        └── /webhook endpoint — manual override / external signals still work
```

No Mac dependency. No trader.dev dependency for live trading.
trader.dev is kept for backtesting new strategies only.

---

## Pending Tasks (do these tomorrow)

### 1. Run the Python backtest (PRIORITY — validates signal-engine.js)
```bash
# On your Mac:
cd Claude-Mandar
pip install requests pandas numpy pyarrow
python runner/backtest_native.py
# Target: +257.91%, PF 1.57, DD 13.76%, Sharpe 0.999
```
OR: Download TradingView CSV → `python runner/backtest_native.py ETHUSDT_60.csv`
(TV: ETHUSDT 1H chart → right-click → Download history data, 4+ years)

### 2. Deploy the EC2 bot
```bash
# On your EC2:
git clone https://github.com/MandarBandekar123/Claude-Mandar.git
cd Claude-Mandar/bot
cp .env.example .env
nano .env     # fill in credentials below
bash deploy.sh
```

**.env credentials needed:**
```
TELEGRAM_TOKEN=<from @BotFather — /newbot>
TELEGRAM_CHAT_ID=<from @userinfobot>
BYBIT_API_KEY=<from demo-bybit.com → API Management>
BYBIT_API_SECRET=<same>
BYBIT_TESTNET=true    # change to false for live
PORT=3000
```

### 3. Verify bot is live
```bash
# On EC2:
pm2 logs f40d-bot          # watch startup + first candle fetch
curl localhost:3000/health  # should return {"status":"ok","openTrades":0}
```
First signal check fires at :65 past next full hour (65s buffer for bar to settle).

---

## Key Technical Facts (don't lose these)

### trader.dev MCP
- SSE endpoint: `https://mcp.trader.dev/sse`
- IP-whitelisted to Mac only (cloud gets 403)
- Correct tool params: `from`/`to` (not fromDate/toDate), `pineSource` (not pine_script)
- `quick_backtest` returns `netProfitPct` already in % form — never multiply by 100
- Deployed strategy ID: `01KSDS5BCKYSXRET62Z32X17TN`
- API key stored as GitHub secret `TRADER_DEV_API_KEY` only — never committed

### Pine → JS indicator mapping (signal-engine.js)
| Pine | JS |
|------|----|
| `ta.rma(x, n)` | `rmaFull(arr, n)` — seed SMA, then α=1/n |
| `ta.ema(x, n)` | `emaFull(arr, n)` — seed SMA, then α=2/(n+1) |
| `ta.sma(x, n)` | `smaFull(arr, n)` — sliding window |
| `ta.stdev(x, n)` | `stdevFull(arr, n)` — population (ddof=0) |
| `ta.crossover(a, b)` | `prev <= b && curr > b` |
| `ta.atr(14)` | `rmaFull(tr, 14)` |

### Bybit V5 API
- Category: `linear` for USDT perps
- Market kline: `GET /v5/market/kline` — public, no auth (but blocked from cloud)
- Place order: `POST /v5/order/create` — requires auth
- Taker fee: 0.06% / Maker fee: 0.01%
- Leverage: set to 5x via `POST /v5/position/set-leverage`

### Anti-martingale state
- Persisted to `bot/signal-state.json` (gitignored)
- `monitor.js` calls `updateStreak(netPnl)` on every trade close
- Win → `streakMult = min(3.0, streakMult × 2.0)`
- Loss → `streakMult = max(1.0, streakMult × 0.9)`
- DD > 5% from peak → `streakMult = 1.0`

### ETH edge is ETH-specific
- BTC/SOL tested: PF ~1.1, Sharpe ~0.31 (no edge)
- ETHUSDT 1H: PF 1.57, Sharpe 0.999 (strong edge)
- Don't deploy this strategy on other pairs without re-testing

---

## What Was Discussed / Decided

1. **trader.dev for BT only** — signal delivery via its own platform is broken (no webhook UI, IP-whitelisted MCP). Replaced with native signal engine on EC2.
2. **Python > JS for quant** — acknowledged, but bot is already in JS. If adding more strategies, migrate to Python at that point.
3. **$3k fixed base chosen** over equity-scaled — cleaner risk per trade, easier to reason about, PF 1.57 vs 1.49 for equity-scaled.
4. **backtest_native.py** — full Pine port in Python. Run to validate JS signal engine produces same signals. If numbers match ±5%, signal engine is correct.
5. **Bybit Demo first** — `BYBIT_TESTNET=true` in .env until you've watched a few trades execute correctly, then flip to live.

---

## GitHub
Repo: `MandarBandekar123/Claude-Mandar`
Branch: `claude/add-trader-dev-mcp-dJbZq`
Last commit: `d444d84` — 2026-05-24
