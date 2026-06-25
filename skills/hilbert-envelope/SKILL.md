---
name: hilbert-envelope
description: Run the Hilbert Envelope Oscillator signal check on ETHUSDT 1H candles fetched live from Bybit public API. Fires Buy (long) or Sell (short) signals using envelope expansion Z-score crossover, price velocity Z-score, ADX trend filter, and 200-day EMA regime filter. Use when asked "will the bot signal?", "check current indicators", "how far are we from a signal?", "what's the envExpZ right now?". No API key required.
---

# hilbert-envelope

Checks the F40d-C104 strategy indicators in real time on 1H ETHUSDT data
from Bybit's public market API. Tells you exactly how far from a signal you
are and why none has fired.

## Strategy logic (mirror of signal-engine.js)

**Signal fires when ALL conditions met:**
| Condition | Threshold |
|---|---|
| Envelope expansion Z-score crossover | prev ≤ 1.0, curr > 1.0 |
| Price velocity Z-score | abs(PVZ) > 0.5 |
| ADX (14) | > 20 (trending, not sideways) |
| Regime (long only) | close > EMA(4800) on 1H |

**Direction:**
- Buy:  PVZ > 0 + regime bull + not sideways
- Sell: PVZ < 0 + not sideways (shorts allowed in bear regime)

**Exits:**
- Bear regime exit: closes long when close falls below EMA(4800)
- Sideways exit: closes all when ADX < 20

## When to use
- "Is the bot close to signaling?"
- "What's envExpZ right now?"
- "Would a signal have fired at [time]?"
- "Check ETHUSDT indicators"

## How to run
```
python hilbert-envelope/check.py \
  [--symbol ETHUSDT] \
  [--bars 5000]      # warmup needs ~250, more = more accurate EMA(4800)
  [--json]
```

No environment variables needed — uses Bybit public endpoint only.

## Output
- `envExpZ_cur` / `envExpZ_prev` — current and previous bar values
- `expansion_edge` — True if crossover fired
- `priceVelZ` — price velocity Z-score
- `adx` — current ADX(14)
- `regime_bull` — True if close > EMA(4800)
- `sideways` — True if ADX < 20
- `signal` — 'Buy', 'Sell', or None
- `no_signal_reasons` — list of why no signal fired
- `bar_time` — timestamp of latest closed bar

## Indicator parameters
| Param | Value | Description |
|---|---|---|
| adxLen | 14 | Wilder's ADX period |
| adxThresh | 20 | Sideways filter cutoff |
| htfEMALen | 4800 | 200-day EMA on 1H bars |
| detrendLen | 50 | SMA detrend for oscillator |
| envSmoothLen | 10 | EMA smooth of Hilbert amplitude |
| envSlopeLen | 10 | Slope lookback |
| envBaseLen | 150 | Z-score normalisation window |
| priceVelLen | 5 | Price change over N bars |
| volSMALen | 200 | Normalised ATR baseline |
| warmup | 250 | Minimum bars before valid signal |

## Exit codes
- 0 success (signal or no-signal printed)
- 1 fetch error / insufficient bars
