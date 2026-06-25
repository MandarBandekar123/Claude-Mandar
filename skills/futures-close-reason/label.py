#!/usr/bin/env python3
"""
futures-close-reason/label.py — correctly label TP/SL/exit for longs AND shorts.

Bug fixed: naive directional comparison (exit >= tp) mislabels short SL hits.
Fix: proximity-based detection (within 0.3% of the TP or SL price level).
"""

import sys, argparse, json

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--side',  required=True, choices=['Buy','Sell','Long','Short'],
                   help='Trade direction')
    p.add_argument('--entry', type=float, required=True)
    p.add_argument('--tp',    type=float, required=True,  help='Take-profit price')
    p.add_argument('--sl',    type=float, required=True,  help='Stop-loss price')
    p.add_argument('--exit',  type=float, required=True,  help='Actual exit price')
    p.add_argument('--pnl',   type=float, default=None,   help='Net PnL (optional)')
    p.add_argument('--pct',   type=float, default=0.3,    help='Proximity %% threshold (default 0.3)')
    p.add_argument('--json',  action='store_true')
    return p.parse_args()

def label(entry, tp, sl, exit_price, pnl, pct_threshold):
    tol_tp = tp * (pct_threshold / 100)
    tol_sl = sl * (pct_threshold / 100)

    near_tp = abs(exit_price - tp) <= tol_tp
    near_sl = abs(exit_price - sl) <= tol_sl

    dist_tp_pct = abs(exit_price - tp) / tp * 100
    dist_sl_pct = abs(exit_price - sl) / sl * 100

    if near_tp:
        reason = 'TP'
        icon   = '✅'
    elif near_sl:
        reason = 'SL'
        icon   = '🛑'
    elif pnl is not None:
        reason = 'Exit+' if pnl >= 0 else 'Exit-'
        icon   = '✅' if pnl >= 0 else '🛑'
    else:
        reason = 'Exit+' if exit_price > entry else 'Exit-'
        icon   = '✅' if exit_price > entry else '🛑'

    return {
        'reason':       reason,
        'icon':         icon,
        'near_tp':      near_tp,
        'near_sl':      near_sl,
        'dist_tp_pct':  round(dist_tp_pct, 3),
        'dist_sl_pct':  round(dist_sl_pct, 3),
    }

def main():
    args = parse_args()

    r = label(
        entry      = args.entry,
        tp         = args.tp,
        sl         = args.sl,
        exit_price = args.exit,
        pnl        = args.pnl,
        pct_threshold = args.pct,
    )

    if args.json:
        print(json.dumps(r))
        return

    side = args.side.capitalize()
    print(f"\nTrade:  {side} | entry=${args.entry} | TP=${args.tp} | SL=${args.sl}")
    print(f"Exit:   ${args.exit}")
    print(f"Result: {r['reason']} {r['icon']}")
    print(f"  dist to TP: {r['dist_tp_pct']:.3f}%  (near_tp={r['near_tp']})")
    print(f"  dist to SL: {r['dist_sl_pct']:.3f}%  (near_sl={r['near_sl']})")

    if not r['near_tp'] and not r['near_sl']:
        print("\n  ⚠️  Neither TP nor SL proximity — manual/liquidation exit.")
        print("     Widen --pct if you expect exchange slippage > 0.3%.")

if __name__ == '__main__':
    main()
