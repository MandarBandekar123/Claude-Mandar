#!/usr/bin/env python3
"""
ccxt-toobit/check.py — verify Toobit API connectivity, balance, and optionally
place+cancel a minimal test order on ETHUSDT perp via CCXT.
"""

import os, sys, argparse, json

try:
    import ccxt
except ImportError:
    print("ERROR: pip install ccxt", file=sys.stderr)
    sys.exit(1)

CCXT_SYMBOL = 'ETH/USDT:USDT'

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--symbol',     default=CCXT_SYMBOL)
    p.add_argument('--leverage',   type=int, default=25)
    p.add_argument('--test-order', action='store_true',
                   help='Place minimal qty order then cancel immediately')
    p.add_argument('--json',       action='store_true')
    return p.parse_args()

def make_exchange():
    key    = os.environ.get('TOOBIT_API_KEY')
    secret = os.environ.get('TOOBIT_API_SECRET')
    if not key or not secret:
        print("ERROR: TOOBIT_API_KEY and TOOBIT_API_SECRET must be set", file=sys.stderr)
        sys.exit(1)
    return ccxt.toobit({
        'apiKey': key,
        'secret': secret,
        'options': {'defaultType': 'swap'},
    })

def main():
    args = parse_args()
    ex   = make_exchange()

    # ── Balance ───────────────────────────────────────────────────────────────
    try:
        bal = ex.fetch_balance({'type': 'swap'})
        usdt = bal.get('USDT', {})
    except Exception as e:
        print(f"ERROR fetching balance: {e}", file=sys.stderr)
        sys.exit(1)

    # ── Ticker ────────────────────────────────────────────────────────────────
    try:
        ticker = ex.fetch_ticker(args.symbol)
        price  = ticker['last']
    except Exception as e:
        print(f"ERROR fetching ticker: {e}", file=sys.stderr)
        sys.exit(1)

    # ── Leverage ──────────────────────────────────────────────────────────────
    try:
        ex.set_leverage(args.leverage, args.symbol)
        lev_ok = True
    except Exception as e:
        lev_ok = f"WARNING: {e}"

    # ── Open positions ────────────────────────────────────────────────────────
    try:
        positions = [p for p in ex.fetch_positions([args.symbol]) if p['contracts'] and p['contracts'] > 0]
    except Exception as e:
        positions = []

    result = {
        'balance_usdt': {
            'free':  usdt.get('free'),
            'used':  usdt.get('used'),
            'total': usdt.get('total'),
        },
        'eth_price':  price,
        'leverage_set': args.leverage if lev_ok is True else lev_ok,
        'open_positions': len(positions),
        'positions': [{'side': p['side'], 'contracts': p['contracts'], 'entryPrice': p['entryPrice']}
                      for p in positions],
    }

    # ── Optional test order ───────────────────────────────────────────────────
    if args.test_order:
        try:
            min_qty = 0.01  # ETHUSDT min lot
            order = ex.create_order(args.symbol, 'market', 'buy', min_qty)
            order_id = order.get('id')
            result['test_order_id'] = order_id
            # Cancel immediately
            ex.cancel_order(order_id, args.symbol)
            result['test_order_cancelled'] = True
        except Exception as e:
            result['test_order_error'] = str(e)

    if args.json:
        print(json.dumps(result, default=str))
        return

    print(f"\n✅ Toobit connected")
    print(f"   Balance: ${usdt.get('free', 0):.2f} free / ${usdt.get('total', 0):.2f} total USDT")
    print(f"   ETH/USDT: ${price:,.2f}")
    print(f"   Leverage: {args.leverage}× {'✅' if lev_ok is True else lev_ok}")
    if positions:
        for p in positions:
            print(f"   Open {p['side']} {p['contracts']} ETH @ ${p['entryPrice']}")
    else:
        print("   No open positions")
    if 'test_order_id' in result:
        print(f"   Test order: {result['test_order_id']} → cancelled ✅")
    if 'test_order_error' in result:
        print(f"   Test order ERROR: {result['test_order_error']}")

if __name__ == '__main__':
    main()
