---
name: bybit-live-order
description: Place a Bybit V5 linear-perp bracket order (market entry + attached TP + SL) using a live price fetched at submit time — not a stale bar-close price. Use whenever a Bybit futures bot throws "StopLoss should be greater than base_price" or you need to place a correctly-sized bracket order on Bybit demo or live. Covers leverage setup, qty rounding, fee estimation.
---

# bybit-live-order

Places a market bracket order on Bybit V5 linear perpetuals.
**Critical lesson**: always fetch the live mid-price at order time.
Using a bar-close price (which can be 60+ seconds stale) causes the
exchange to reject the order with "StopLoss should be greater than
base_price" because the market has moved past the stale SL.

## When to use
- "Place a long/short on ETHUSDT"
- "Bot keeps getting SL rejection errors"
- "Submit order with TP and SL attached"
- Setting up Bybit demo trading for the first time

## How to run
```
python bybit-live-order/order.py \
  --side Buy \
  --symbol ETHUSDT \
  --notional 10000 \
  --leverage 25 \
  [--tp-pct 5.0] [--sl-pct 2.0] \
  [--demo]          # uses api-demo.bybit.com (default)
  [--live]          # BYBIT_ENV=live required to unlock
  [--dry-run]       # print order params without submitting
```

Environment variables required:
- `BYBIT_API_KEY`
- `BYBIT_API_SECRET`
- Set `BYBIT_DEMO=false` only when trading live

## Output
- orderId, entry price (live-fetched), qty, TP price, SL price
- Net P&L estimate if TP hit / if SL hit (after taker fees)

## Key rules enforced
1. Price is **always fetched live** via `/v5/market/tickers` at submit time
2. qty is floored to 2 decimal places (ETHUSDT lot step = 0.01)
3. Leverage is set before the order (idempotent — safe to call every time)
4. Demo unless `--live` AND `BYBIT_ENV=live` are both present
5. Checks for existing open position in same symbol before placing

## Fee model
- Taker entry: 0.06% of notional
- Maker TP fill: 0.01% of TP notional
- Taker SL fill: 0.06% of SL notional
- Net if TP = notional × tpPct/100 − entryFee − tpFee
- Net if SL = −(notional × slPct/100 + entryFee + slFee)

## Exit codes
- 0 success, orderId printed
- 2 config/risk veto (no live flag, position already open)
- 1 API error

## Notes
- Uses `pybit` (pip install pybit) for V5 REST
- Equivalent Node.js: `bybit-api` npm, `RestClientV5`
- Demo endpoint: `https://api-demo.bybit.com`
- Live endpoint: `https://api.bybit.com`
