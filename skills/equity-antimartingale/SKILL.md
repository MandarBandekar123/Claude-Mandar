---
name: equity-antimartingale
description: Compute anti-martingale equity-based position sizing with streak multiplier and drawdown reset. Use whenever asked "how much should I trade?", "calculate my position size", "what's my effCash?", or when sizing a futures trade on a growing account. Pure math, no network, no API keys. Handles win-streak compounding, loss decay, 5% DD kill-switch, and hard cap at 150% of equity.
---

# equity-antimartingale

Implements the anti-martingale sizing formula used in the F40d-C104 trading bot:

```
effCash = min(equity × volMult × signalMult × streakMult, equity × 1.5)
```

On wins the streak multiplier doubles (up to 3×); on losses it decays 10%
(floor 1×). If the account drawdown exceeds 5% from peak equity, the streak
resets to 1× to protect capital.

## When to use
- "Size my next trade" / "what's my effCash?"
- "I just had a win / loss — update my streak"
- "Reset my streak — I'm in drawdown"
- "What's the max I can trade with $10,000 equity?"
- Backtesting position sizing with known trade history

## How to run
```
python equity-antimartingale/size.py \
  --equity 10328 \
  --streak-mult 2.0 \
  --peak-equity 10500 \
  [--vol-mult 1.0] \
  [--signal-mult 2.55] \
  [--win]   # record a win and update streak
  [--loss]  # record a loss and update streak
  [--json]

# Or just calculate without updating state:
python equity-antimartingale/size.py --equity 10000 --vol-mult 1.2 --signal-mult 2.0
```

State is persisted to `~/.claude/skills/equity-antimartingale/state.json`.
Run with `--init --equity 10000` to start a fresh session.

## Output
- `effCash` — dollar notional to trade
- `streakMult` — current multiplier
- `maxCash` — hard cap (equity × 1.5)
- `dd_pct` — current drawdown from peak
- warning if streak was reset due to DD

## Formula breakdown
| Multiplier | Range | Description |
|---|---|---|
| volMult | 1.0 – 1.5 | normATR / refATR — expand size in high-vol |
| signalMult | 1.0 – 3.0 | abs(priceVelZ) — stronger signal = more size |
| streakMult | 1.0 – 3.0 | anti-martingale — compound wins, cut losses |
| hard cap | × 1.5 equity | Never risk more than 150% of equity notional |

## Anti-martingale rules
- Win:  `streakMult = min(3.0, streakMult × 2.0)`
- Loss: `streakMult = max(1.0, streakMult × 0.9)`
- DD > 5% from peak: `streakMult = 1.0`, `peakEquity = equity`

## Example (10K account, 25× leverage)
```
Equity $10,328 | streakMult 1.0 | volMult 1.0 | signalMult 1.0
→ effCash $10,328 (1× equity)
→ TP at 5% = +$516 | SL at 2% = -$207

After win: streakMult 2.0
→ effCash $15,492 (capped at 1.5×)
→ TP at 5% = +$774 | SL at 2% = -$310
```

## Exit codes
- 0 success
- 1 input error (equity ≤ 0, bad multiplier range)
