#!/usr/bin/env python3
"""
bybit-live-order — place a Bybit V5 linear-perp bracket order using live price.

Critical: price is fetched LIVE at submit time, never from a stale signal.
This prevents "StopLoss should be greater than base_price" rejections.
"""

import os, sys, argparse, math, json
from pybit.unified_trading import HTTP

TP_PCT_DEFAULT  = 5.0
SL_PCT_DEFAULT  = 2.0
TAKER_FEE       = 0.0006
MAKER_FEE       = 0.0001

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--side',     required=True, choices=['Buy','Sell'])
    p.add_argument('--symbol',   default='ETHUSDT')
    p.add_argument('--notional', type=float, required=True)
    p.add_argument('--leverage', type=int,   default=25)
    p.add_argument('--tp-pct',   type=float, default=TP_PCT_DEFAULT)
    p.add_argument('--sl-pct',   type=float, default=SL_PCT_DEFAULT)
    p.add_argument('--demo',     action='store_true', default=True)
    p.add_argument('--live',     action='store_true')
    p.add_argument('--dry-run',  action='store_true')
    p.add_argument('--json',     action='store_true')
    return p.parse_args()

def make_client(live: bool) -> HTTP:
    key    = os.environ['BYBIT_API_KEY']
    secret = os.environ['BYBIT_API_SECRET']
    if live:
        if os.environ.get('BYBIT_ENV') != 'live':
            print('ERROR: --live requires BYBIT_ENV=live in environment', file=sys.stderr)
            sys.exit(2)
        return HTTP(api_key=key, api_secret=secret)
    return HTTP(testnet=True, api_key=key, api_secret=secret)

def get_live_price(client: HTTP, symbol: str) -> float:
    """Always fetch live price — never use a bar-close / signal price."""
    r = client.get_tickers(category='linear', symbol=symbol)
    return float(r['result']['list'][0]['lastPrice'])

def set_leverage(client: HTTP, symbol: str, leverage: int):
    try:
        client.set_leverage(category='linear', symbol=symbol,
                            buyLeverage=str(leverage), sellLeverage=str(leverage))
    except Exception as e:
        if 'leverage not modified' not in str(e).lower():
            raise

def floor_qty(qty: float, step: float = 0.01) -> float:
    return math.floor(qty / step) * step

def main():
    args = parse_args()
    use_live = args.live and not args.demo

    client = make_client(use_live)

    # ── Live price (critical: not bar-close) ──────────────────────────────────
    price = get_live_price(client, args.symbol)

    # ── Sizing ────────────────────────────────────────────────────────────────
    qty     = floor_qty(args.notional / price)
    tp_pct  = args.tp_pct / 100
    sl_pct  = args.sl_pct / 100

    if args.side == 'Buy':
        tp_price = round(price * (1 + tp_pct), 2)
        sl_price = round(price * (1 - sl_pct), 2)
    else:
        tp_price = round(price * (1 - tp_pct), 2)
        sl_price = round(price * (1 + sl_pct), 2)

    # ── Fee estimates ─────────────────────────────────────────────────────────
    notional    = qty * price
    entry_fee   = notional * TAKER_FEE
    tp_notional = qty * tp_price
    sl_notional = qty * sl_price
    net_tp  = notional * tp_pct  - entry_fee - tp_notional * MAKER_FEE
    net_sl  = -(notional * sl_pct + entry_fee + sl_notional * TAKER_FEE)

    result = {
        'side':     args.side,
        'symbol':   args.symbol,
        'qty':      qty,
        'entry':    price,
        'tp':       tp_price,
        'sl':       sl_price,
        'notional': round(notional, 2),
        'margin':   round(notional / args.leverage, 2),
        'net_tp':   round(net_tp, 2),
        'net_sl':   round(net_sl, 2),
        'mode':     'live' if use_live else 'demo',
    }

    if args.dry_run:
        print(json.dumps(result, indent=2) if args.json else
              f"DRY RUN: {args.side} {qty} {args.symbol} @ ${price} | "
              f"TP ${tp_price} | SL ${sl_price} | "
              f"net_tp ${net_tp:.2f} | net_sl ${net_sl:.2f}")
        sys.exit(0)

    if qty <= 0:
        print('ERROR: qty rounded to zero — notional too small', file=sys.stderr)
        sys.exit(1)

    set_leverage(client, args.symbol, args.leverage)

    r = client.place_order(
        category   = 'linear',
        symbol     = args.symbol,
        side       = args.side,
        orderType  = 'Market',
        qty        = str(qty),
        takeProfit = str(tp_price),
        stopLoss   = str(sl_price),
        tpOrderType= 'Limit',
        slOrderType= 'Market',
    )
    if r.get('retCode', -1) != 0:
        print(f"ERROR: {r.get('retMsg')}", file=sys.stderr)
        sys.exit(1)

    order_id = r['result']['orderId']
    result['orderId'] = order_id

    if args.json:
        print(json.dumps(result))
    else:
        print(f"✅ {args.side} {qty} {args.symbol} @ ${price:.2f} | "
              f"orderId={order_id} | TP ${tp_price} | SL ${sl_price}")
        print(f"   net if TP: +${net_tp:.2f}  |  net if SL: -${abs(net_sl):.2f}")

if __name__ == '__main__':
    main()
