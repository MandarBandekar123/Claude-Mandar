---
name: futures-close-reason
description: Correctly label why a futures position closed (TP hit vs SL hit vs manual exit) for both long and short trades. Use when a trading bot mislabels close reasons, when short SL hits appear as TP wins in trade logs, or when building a trade monitor that detects fills. Covers the proximity-based detection pattern (±0.3%) that works correctly for both directions.
---

# futures-close-reason

## The bug this fixes

Naive close-reason detection using directional comparison fails for shorts:

```python
# WRONG — mislabels short SL hits as TP wins
if exit_price >= tp_price:
    reason = 'TP'   # ✅ correct for longs, ❌ wrong for shorts
elif exit_price <= sl_price:
    reason = 'SL'   # ✅ correct for longs, ❌ wrong for shorts
```

For a **short** trade: TP is *below* entry, SL is *above* entry.
When the price spikes up and hits the SL, `exit_price >= tp_price` can be
true (because TP is low and exit is high) — causing the SL to be logged as a TP win.

## The fix — proximity-based detection

```python
near_tp = abs(exit_price - tp_price) <= tp_price * 0.003   # within 0.3%
near_sl = abs(exit_price - sl_price) <= sl_price * 0.003   # within 0.3%

if near_tp:
    reason = 'TP ✅'
elif near_sl:
    reason = 'SL 🛑'
elif net_pnl >= 0:
    reason = 'Exit +✅'   # manual exit with profit
else:
    reason = 'Exit -🛑'  # manual exit at loss
```

This works identically for longs and shorts because it measures *distance*
to each price level, not direction.

## When to use
- "My bot is marking short SL hits as TP wins"
- "Trade log shows wrong close reason"
- "Build a position monitor that labels fills correctly"
- Auditing any trade history where close reasons look suspicious

## How to run
```
python futures-close-reason/label.py \
  --side Sell \
  --entry 1574.60 \
  --tp    1495.87 \
  --sl    1606.09 \
  --exit  1606.20   # price where position actually closed
  [--pct 0.3]       # proximity threshold (default 0.3%)
  [--pnl -280.00]   # if provided, used for fallback labeling
```

## Output
- `reason` — 'TP', 'SL', 'Exit+', or 'Exit-'
- `near_tp` / `near_sl` — boolean proximity flags
- `dist_tp_pct` / `dist_sl_pct` — % distance from each level

## Notes
- 0.3% tolerance handles slippage on market SL fills
- Widen to 0.5% on volatile assets or high-latency monitors
- For ETHUSDT at $1,574, 0.3% = ~$4.7 — safe margin for exchange fills
