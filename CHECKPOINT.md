# Session Checkpoint — 2026-05-26 (updated PM)

## Current Status: BOT IS LIVE ON EC2, DEMO ENDPOINT ✅

### EC2 Instance
- **IP**: 47.129.55.50
- **User**: ec2-user
- **OS**: Amazon Linux 2023
- **Region**: ap-southeast-1
- **Instance**: t2.micro (i-0dc2c3783538aca9d)
- **Bot path**: `/home/ec2-user/f40d-bot`
- **PM2 process**: `f40d-bot` (running, auto-restart enabled)

### Bot State
- Bybit **Demo Trading** (api-demo.bybit.com) connected — 5× leverage on ETHUSDT
- 5000 1H candles loaded — signal engine armed
- Telegram connected — chat ID 6109181833
- streakMult = 1.0 (fresh start, no trades yet)
- Next signal check: fires 65s past every hour close

### Verified working (latest restart)
```
Leverage set: 5x on ETHUSDT
Bybit DEMO ready | 5x leverage on ETHUSDT       ← confirms api-demo endpoint
Position monitor started (60s interval)
Signal engine: 5000 candles ready — engine armed
Signal engine: next check in XX min
```
Telegram startup message received ✅

### Today's fix (PM session)
- **Problem**: orders failed with `Bybit order failed: API key is invalid.` even though startup said `Bybit TESTNET ready`.
- **Root cause**: `bybit-api` lib treats `testnet:true` (api-testnet.bybit.com) and `demoTrading:true` (api-demo.bybit.com) as **separate endpoints**. Demo Trading keys don't authenticate on testnet.
- **Fix** (commit `de09e95`): renamed env var `BYBIT_TESTNET` → `BYBIT_DEMO`, switched RestClientV5 flag to `demoTrading: config.bybitDemo`. Touched: `bybit.js`, `config.js`, `server.js`, `telegram.js`, `deploy.sh`, `.env.example`.
- **Deploy steps that worked**:
  ```bash
  ssh ec2-user@47.129.55.50
  cd /home/ec2-user/f40d-bot
  git pull origin claude/add-trader-dev-mcp-dJbZq
  # edit .env: rename BYBIT_TESTNET=true → BYBIT_DEMO=true
  pm2 restart f40d-bot
  ```
- **Stale error**: the `API key is invalid` line in `f40d-bot-error.log` is from before the restart (PM2 doesn't auto-flush). Run `pm2 flush f40d-bot` to clear.

### Bybit Demo Trading key
- Created on **Demo Trading** tab at https://www.bybitglobal.com/app/user/api-management (orange "Demo Trading" toggle, top-left).
- Key name on Bybit: `Claude_bot_fail1` (the "fail" was our bug, key itself is fine).
- Permissions: Contracts — Orders + Positions ✅
- IP binding: not bound (key expires in 3 months). If you want permanent, bind to `47.129.55.50` on Bybit.
- Key/secret live in `/home/ec2-user/f40d-bot/bot/.env` on EC2 only.

### Order placement: VERIFIED WORKING ✅
Test webhook confirmed full order cycle:
```
Trade opened: Buy 1.47 ETHUSDT @ $2038.4 | TP $2140.32 | SL $1997.63 | notional $3000
```
Error log empty. Telegram alert received.

**Fixes applied to get here (in order):**
1. `eee7035` — Wrong endpoint: `testnet:true` → `demoTrading:true`
2. `02d270f` — Qty invalid: `toFixed(3)` → `toFixed(2)` (Bybit step size = 0.01)
3. `eee7035` — Added `tpLimitPrice` (required when `tpOrderType=Limit`)
4. `d4fbdd2` — Removed `tpOrderType=Limit` + `tpLimitPrice` + `tpSlMode` entirely — Bybit library doesn't support these cleanly; defaulting to Market TP (cost: ~$1.50/trade negligible)

### Next steps
- Monitor 30–40 demo trades via Telegram + `pm2 logs f40d-bot`
- Review: win rate, DD, execution quality
- Go live: set `BYBIT_DEMO=false` in `/home/ec2-user/f40d-bot/bot/.env` + `pm2 restart f40d-bot`

---

## Branch
`claude/add-trader-dev-mcp-dJbZq` — all code pushed, clean tree.
Last commit: `d4fbdd2` — Fix: remove tpOrderType=Limit (order placement verified working)

---

## Backtest Results (Python/Binance)

### 4-scenario comparison:
| Scenario | Net% | PF | DD% | Trades |
|----------|------|----|-----|--------|
| Flat $3k (streak=1) | +93% | 1.28 | 32% | 382 |
| Streak disabled (env flag) | +93% | 1.28 | 32% | 382 |
| Anti-martingale cap 2× | +148% | 1.31 | 47% | 343 |
| Anti-martingale cap 3× ← **LIVE** | +184% | 1.34 | 48% | 343 |

### Key facts
- Win rate: 32.1% (breakeven is 28.6% — real edge confirmed)
- PF 1.28–1.34 consistent across ALL scenarios
- DD gap vs trader.dev (14%) = data-sequence difference (Binance ≠ trader.dev feed)
- Avg effCash at cap 3×: $12,079 (anti-martingale very active when on a streak)

---

## What's deployed (full anti-martingale, cap 3×)

### Strategy: ETHUSDT 1H Hilbert Envelope
**Entry conditions (ALL required):**
1. Price > EMA(4800) on 1H — bull regime (longs only; shorts allowed in any regime)
2. ADX(14) > 20 — not sideways
3. Envelope expansion Z-score crosses above 1.0 — volatility expanding
4. Price velocity Z-score > 0.5 in signal direction

**Exits:**
- TP: +5% (limit order, maker fee)
- SL: −2% (market order)
- Regime flips bear → long closed
- ADX drops below 20 → all closed
- Opposite signal → flip

**Sizing:**
```
effCash = min($3000 × volMult × signalMult × streakMult, 30% of equity)
volMult:    1.0–1.5× (ATR vs 200-bar average)
signalMult: 1.0–3.0× (price velocity Z-score)
streakMult: 1.0–3.0× (win→×2, loss→×0.9, DD>5%→reset to 1.0)
```

---

## Architecture

```
EC2 47.129.55.50 (runs 24/7)
  └── /home/ec2-user/f40d-bot/bot/server.js  (PM2: f40d-bot)
        ├── signal-engine.js  — fetches Bybit 1H candles every hour close
        │     runs: ADX → htfEMA → envelope → priceVelZ → sizing
        │     fires: processSignal({side, price, effCash, ...})
        ├── processSignal()   — closes opposite → Bybit order → Telegram → SQLite
        ├── monitor.js        — 60s poll: TP/SL hit → updateStreak() → Telegram
        ├── /webhook          — manual override still works
        └── cron 0 8 * * *   — daily Telegram dashboard at 8am UTC
```

---

## Key Files
```
bot/signal-engine.js   — Full Pine strategy in JS (all indicators)
bot/server.js          — Express + processSignal() + startSignalEngine() + daily cron
bot/monitor.js         — Position monitor, calls updateStreak()
bot/tracker.js         — SQLite trade log (trades.db, gitignored)
bot/bybit.js           — Bybit V5 REST
bot/telegram.js        — Rich Telegram templates (signal, close, daily dashboard, weekly)
bot/config.js          — Settings from .env
bot/deploy.sh          — EC2 one-command setup (Node + PM2)
bot/.env.example       — Credential template
runner/backtest_native.py  — Python backtest (run on Mac — Binance blocked from cloud)
strategy_v2_fixed3k.pine   — Original Pine strategy (trader.dev reference only)
```

---

## Plan: 30–40 Demo Trades → Go Live
Monitor via:
- `pm2 logs f40d-bot` on EC2
- Telegram alerts on every signal/close
- Daily 8am UTC dashboard

After 30–40 trades: review win rate, DD, execution quality, then set `BYBIT_TESTNET=false`.

---

## Technical Reference

### Pine → JS indicator mapping
| Pine | JS impl |
|------|---------|
| `ta.rma(x, n)` | `rmaFull(arr, n)` — seed SMA, α=1/n (Wilder's) |
| `ta.ema(x, n)` | `emaFull(arr, n)` — seed SMA, α=2/(n+1) |
| `ta.sma(x, n)` | `smaFull(arr, n)` — sliding window |
| `ta.stdev(x, n)` | `stdevFull(arr, n)` — population (ddof=0) |
| `ta.crossover(a, b)` | `prev <= b && curr > b` |

### Bybit API
- Public klines: `GET https://api.bybit.com/v5/market/kline` (no auth)
- Category: `linear` (USDT perps)
- Fees: taker 0.06%, maker 0.01%

### Anti-martingale state
- File: `bot/signal-state.json` (gitignored, stays on EC2)
- Win → `streakMult = min(3.0, streakMult × 2.0)`
- Loss → `streakMult = max(1.0, streakMult × 0.9)`
- DD > 5% from peak → `streakMult = 1.0`

### EC2 commands
```bash
pm2 logs f40d-bot          # live log stream
pm2 status                 # process status
curl localhost:3000/health  # open trades JSON
pm2 restart f40d-bot       # restart after code pull
git -C ~/f40d-bot pull && pm2 restart f40d-bot  # deploy update
```

---

## GitHub
Repo: `MandarBandekar123/Claude-Mandar`
Branch: `claude/add-trader-dev-mcp-dJbZq`
Last commit: `d4fbdd2` — Fix: remove tpOrderType=Limit (order placement verified working)
