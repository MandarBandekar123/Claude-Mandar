#!/usr/bin/env python3
"""
equity-antimartingale — compute anti-martingale equity-based position size.

Formula:
    effCash = min(equity × volMult × signalMult × streakMult, equity × 1.5)

Streak rules:
    win  → streakMult = min(3.0, prev × 2.0)
    loss → streakMult = max(1.0, prev × 0.9)
    DD > 5% from peak → reset to 1.0
"""

import os, sys, argparse, json
from pathlib import Path

STATE_DIR  = Path.home() / '.claude' / 'skills' / 'equity-antimartingale'
STATE_FILE = STATE_DIR / 'state.json'

GROWTH_RATE  = 2.0
DECAY_RATE   = 0.9
STREAK_CAP   = 3.0
STREAK_FLOOR = 1.0
MAX_RISK_PCT = 1.5   # effCash cap = equity × 1.5
DD_RESET_PCT = 5.0   # reset streak if DD > 5%

def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {'streakMult': 1.0, 'peakEquity': None}

def save_state(s):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(s, indent=2))

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--equity',      type=float, required=True)
    p.add_argument('--vol-mult',    type=float, default=1.0)
    p.add_argument('--signal-mult', type=float, default=1.0)
    p.add_argument('--streak-mult', type=float, default=None,
                   help='Override from state file')
    p.add_argument('--peak-equity', type=float, default=None)
    p.add_argument('--win',  action='store_true', help='Record a win, update streak')
    p.add_argument('--loss', action='store_true', help='Record a loss, update streak')
    p.add_argument('--init', action='store_true', help='Reset state to fresh session')
    p.add_argument('--json', action='store_true')
    return p.parse_args()

def compute(equity, vol_mult, signal_mult, streak_mult):
    max_cash = equity * MAX_RISK_PCT
    eff_cash = min(equity * vol_mult * signal_mult * streak_mult, max_cash)
    return eff_cash, max_cash

def update_streak(state, equity, win: bool):
    if state['peakEquity'] is None:
        state['peakEquity'] = equity

    if equity > state['peakEquity']:
        state['peakEquity'] = equity

    dd_pct = (state['peakEquity'] - equity) / state['peakEquity'] * 100
    reset  = False

    if dd_pct > DD_RESET_PCT:
        state['streakMult'] = STREAK_FLOOR
        state['peakEquity'] = equity
        reset = True
    elif win:
        state['streakMult'] = min(STREAK_CAP, state['streakMult'] * GROWTH_RATE)
    else:
        state['streakMult'] = max(STREAK_FLOOR, state['streakMult'] * DECAY_RATE)

    return dd_pct, reset

def main():
    args = parse_args()

    if args.equity <= 0:
        print('ERROR: --equity must be > 0', file=sys.stderr)
        sys.exit(1)

    state = load_state()

    if args.init:
        state = {'streakMult': 1.0, 'peakEquity': args.equity}
        save_state(state)
        print(f"State reset. equity=${args.equity:.0f}, streakMult=1.0")
        sys.exit(0)

    # Override from CLI if provided
    if args.streak_mult is not None:
        state['streakMult'] = args.streak_mult
    if args.peak_equity is not None:
        state['peakEquity'] = args.peak_equity
    if state['peakEquity'] is None:
        state['peakEquity'] = args.equity

    dd_pct = (state['peakEquity'] - args.equity) / state['peakEquity'] * 100
    reset  = False

    if args.win or args.loss:
        dd_pct, reset = update_streak(state, args.equity, win=args.win)
        save_state(state)

    streak_mult = state['streakMult']
    eff_cash, max_cash = compute(args.equity, args.vol_mult, args.signal_mult, streak_mult)

    result = {
        'equity':      round(args.equity, 2),
        'vol_mult':    args.vol_mult,
        'signal_mult': args.signal_mult,
        'streak_mult': round(streak_mult, 3),
        'eff_cash':    round(eff_cash, 2),
        'max_cash':    round(max_cash, 2),
        'peak_equity': round(state['peakEquity'], 2),
        'dd_pct':      round(dd_pct, 2),
        'streak_reset': reset,
    }

    if args.json:
        print(json.dumps(result))
        return

    capped = abs(eff_cash - max_cash) < 0.01
    print(f"effCash:    ${eff_cash:,.2f}{' (capped at 1.5×)' if capped else ''}")
    print(f"streakMult: {streak_mult:.2f}× {'⚠️  RESET from DD' if reset else ''}")
    print(f"dd:         {dd_pct:.1f}% from peak ${state['peakEquity']:,.0f}")
    print(f"volMult={args.vol_mult}  signalMult={args.signal_mult}  streakMult={streak_mult:.2f}")

if __name__ == '__main__':
    main()
