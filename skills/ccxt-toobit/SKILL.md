---
name: ccxt-toobit
description: Set up and test a Toobit exchange connection via CCXT for USDT-margined perpetual futures. Use when integrating Toobit into a trading bot, placing your first Toobit futures order, checking available balance, or comparing Toobit vs Bybit as a venue for small accounts ($100–$500 with 25× leverage). Requires TOOBIT_API_KEY and TOOBIT_API_SECRET env vars.
---

# ccxt-toobit

Toobit is a derivatives exchange added to CCXT in November 2025.
Use this skill to verify connectivity, check balance, and place test orders
before wiring it into an automated bot.

## When to use
- "Set up Toobit API in my bot"
- "Test my Toobit API keys"
- "Place a test order on Toobit"
- "Check Toobit ETHUSDT balance"
- Migrating from Bybit demo to real-money Toobit account

## Key CCXT config for Toobit

```python
import ccxt
ex = ccxt.toobit({
    'apiKey': os.environ['TOOBIT_API_KEY'],
    'secret': os.environ['TOOBIT_API_SECRET'],
    'options': {'defaultType': 'swap'},   # perpetual futures
})
```

Symbol format: `'ETH/USDT:USDT'` (CCXT unified, not `ETHUSDT`)

## How to run
```
python ccxt-toobit/check.py \
  [--symbol ETH/USDT:USDT] \
  [--test-order]    # place a minimal qty test order (then cancel)
  [--leverage 25]
```

Environment variables required:
- `TOOBIT_API_KEY`
- `TOOBIT_API_SECRET`

## Output
- Account USDT balance (free / used / total)
- Current ETHUSDT price
- Current leverage setting
- Open positions (if any)
- If --test-order: orderId and immediate cancel confirmation

## Node.js equivalent (for existing bot codebase)

```javascript
import ccxt from 'ccxt';

const ex = new ccxt.toobit({
  apiKey: process.env.TOOBIT_API_KEY,
  secret: process.env.TOOBIT_API_SECRET,
  options: { defaultType: 'swap' },
});

// Place order
const order = await ex.createOrder(
  'ETH/USDT:USDT', 'market', 'sell', qty, undefined,
  { stopLossPrice: slPrice, takeProfitPrice: tpPrice }
);

// Get position
const positions = await ex.fetchPositions(['ETH/USDT:USDT']);

// Close position
await ex.createOrder('ETH/USDT:USDT', 'market', 'buy', qty, undefined,
  { reduceOnly: true }
);
```

## Account setup checklist
1. Create Toobit account at toobit.com
2. Enable Futures trading in account settings
3. Create API key — enable Futures, disable withdrawals
4. Deposit USDT to Futures wallet (not Spot)
5. Set `TOOBIT_API_KEY` and `TOOBIT_API_SECRET` in your `.env` file

## Sizing for $300 account at 25× leverage
- Base notional = $300 (1× equity)
- Max notional = $450 (1.5× equity cap)
- TP at 5%: +$15 → +$22.50
- SL at 2%: −$6 → −$9
- Liquidation at ~4% (well beyond 2% SL)

## Exit codes
- 0 connectivity OK
- 1 API error (wrong keys, IP restriction, futures not enabled)
