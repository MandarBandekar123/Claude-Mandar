#!/usr/bin/env python3
"""
backtest_native.py — F40d C104 strategy backtest on Binance 1H data.

Implements strategy_v2_fixed3k.pine exactly in Python:
  ADX(14) filter, EMA(4800) regime, Hilbert envelope oscillator,
  price velocity Z-score, volMult × signalMult × streakMult sizing.

Usage:
  # Fetch from Binance (run locally on Mac — cloud IPs are blocked by exchanges):
  pip install requests pandas numpy pyarrow
  python runner/backtest_native.py

  # Use TradingView CSV export instead:
  python runner/backtest_native.py path/to/ETHUSDT_1h.csv

  TradingView export: chart → right-click → Download history data
  Data cached to backtest_results/ethusdt_1h_binance.parquet on first Binance run.
"""

import sys, time, json
from pathlib import Path
import requests
import numpy as np
import pandas as pd

ROOT    = Path(__file__).parent.parent
CACHE   = ROOT / 'backtest_results' / 'ethusdt_1h_binance.parquet'
OUT_CSV = ROOT / 'backtest_results' / 'native_backtest_trades.csv'

# ── Parameters — exact mirror of strategy_v2_fixed3k.pine ────────────────────
P = dict(
    adx_len       = 14,
    adx_thresh    = 20,
    sl_pct        = 2.0,
    tp_pct        = 5.0,
    growth_rate   = 2.0,     # streak win multiplier
    decay_rate    = 0.9,     # streak loss decay
    expansion_z   = 1.0,     # envelope edge Z threshold
    min_vel_z     = 0.5,     # min price velocity Z-score to enter
    detrend_len   = 50,
    dd_reset_pct  = 5.0,     # streak resets when equity drops 5% from peak
    base_cash     = 3000.0,
    am_mult_cap   = 3.0,     # max streak multiplier
    htf_ema_len   = 4800,    # 200-day EMA proxy on 1H bars
    env_smooth    = 10,
    env_slope_len = 10,
    env_base_len  = 150,
    price_vel_len = 5,
    vol_sma_len   = 200,
    warmup        = 250,     # bar_index > detrendLen + envBaseLen + 50
    commission    = 0.0004,  # 0.04% per side — matches Pine commission_value=0.04
    init_capital  = 10_000.0,
)

# ── Indicator helpers — match Pine's exact algorithms ────────────────────────

def rma(s: pd.Series, n: int) -> pd.Series:
    """Wilder's smoothing — Pine ta.rma.  Seed = SMA(n), then ewm alpha=1/n."""
    v = s.to_numpy(dtype=float, copy=True)
    o = np.full(len(v), np.nan)
    if len(v) < n:
        return pd.Series(o, index=s.index)
    o[n - 1] = v[:n].mean()
    a = 1.0 / n
    for i in range(n, len(v)):
        o[i] = o[i - 1] * (1 - a) + v[i] * a
    return pd.Series(o, index=s.index)


def ema(s: pd.Series, n: int) -> pd.Series:
    """EMA — Pine ta.ema.  Seed = SMA(n), then ewm alpha=2/(n+1)."""
    v = s.to_numpy(dtype=float, copy=True)
    o = np.full(len(v), np.nan)
    if len(v) < n:
        return pd.Series(o, index=s.index)
    o[n - 1] = v[:n].mean()
    a = 2.0 / (n + 1)
    for i in range(n, len(v)):
        o[i] = o[i - 1] * (1 - a) + v[i] * a
    return pd.Series(o, index=s.index)


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n).mean()


def stdev(s: pd.Series, n: int) -> pd.Series:
    """Population stdev — matches Pine ta.stdev (ddof=0)."""
    return s.rolling(n).std(ddof=0)


# ── Fetch ETHUSDT 1H from Binance public API ──────────────────────────────────

def fetch_binance(symbol='ETHUSDT', interval='1h', years=4.5) -> pd.DataFrame:
    if CACHE.exists():
        print(f'Loading cached data from {CACHE.name}...')
        df = pd.read_parquet(CACHE)
        print(f'  {len(df):,} bars  ({df["datetime"].iloc[0].date()} → {df["datetime"].iloc[-1].date()})')
        return df

    print(f'Fetching {symbol} {interval} from Binance ({years:.0f} years)...')
    url      = 'https://api.binance.com/api/v3/klines'
    start_ms = int((time.time() - years * 365.25 * 86400) * 1000)
    rows     = []

    while True:
        resp = requests.get(url, params={
            'symbol': symbol, 'interval': interval,
            'startTime': start_ms, 'limit': 1000,
        }, timeout=20)
        resp.raise_for_status()
        data = resp.json()
        if not data:
            break
        rows.extend(data)
        sys.stdout.write(f'\r  {len(rows):,} bars...')
        sys.stdout.flush()
        if len(data) < 1000:
            break
        start_ms = int(data[-1][0]) + 1
        time.sleep(0.08)

    print(f'\r  {len(rows):,} bars fetched')

    df = pd.DataFrame(
        [[int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4])] for r in rows],
        columns=['time', 'open', 'high', 'low', 'close'],
    ).drop_duplicates('time').reset_index(drop=True)
    df['datetime'] = pd.to_datetime(df['time'], unit='ms', utc=True)

    CACHE.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(CACHE, index=False)
    print(f'  Cached to {CACHE.name}')
    return df


# ── Compute all indicator series ──────────────────────────────────────────────

def compute_indicators(df: pd.DataFrame) -> pd.DataFrame:
    c  = df['close']
    h  = df['high']
    l  = df['low']
    pc = c.shift(1)

    # True Range
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    tr.iloc[0] = h.iloc[0] - l.iloc[0]

    # +DM / -DM
    up   = h.diff().clip(lower=0)
    down = (-l.diff()).clip(lower=0)
    pdm  = np.where((h.diff() > (-l.diff())) & (h.diff() > 0), h.diff(), 0.0)
    mdm  = np.where((-l.diff() > h.diff()) & (-l.diff() > 0), -l.diff(), 0.0)
    pdm  = pd.Series(pdm, index=df.index).fillna(0)
    mdm  = pd.Series(mdm, index=df.index).fillna(0)

    n    = P['adx_len']
    str_ = rma(tr, n)
    pdi  = 100 * rma(pdm, n) / (str_ + 1e-10)
    mdi  = 100 * rma(mdm, n) / (str_ + 1e-10)
    dx   = 100 * (pdi - mdi).abs() / (pdi + mdi + 1e-10)
    adx  = rma(dx, n)

    # 200-day EMA proxy — EMA(close, 4800) on 1H
    # NOTE: needs 4800 bars to seed; first valid value at bar 4799
    htf  = ema(c, P['htf_ema_len'])

    # ATR14 → normalised volatility → vol multiplier
    atr14   = rma(tr, 14)
    norm    = atr14 / (c + 1e-10)
    ref_atr = sma(norm, P['vol_sma_len'])
    vol_r   = (norm / (ref_atr + 1e-10)).clip(1.0, 1.5)

    # Hilbert envelope oscillator (Pine's Ehlers approximation)
    trend    = sma(c, P['detrend_len'])
    osc      = (c - trend).fillna(0)
    ov       = osc.to_numpy()
    qv       = np.zeros(len(ov))
    for i in range(6, len(ov)):
        qv[i] = 0.0962*ov[i] + 0.5769*ov[i-2] - 0.5769*ov[i-4] - 0.0962*ov[i-6]
    quad     = pd.Series(qv, index=df.index)
    env_inst = (osc**2 + quad**2).pow(0.5)
    env_s    = ema(env_inst, P['env_smooth'])

    sl_n     = P['env_slope_len']
    env_slp  = (env_s - env_s.shift(sl_n)).fillna(0)
    slp_mean = sma(env_slp, P['env_base_len'])
    slp_std  = stdev(env_slp, P['env_base_len'])
    env_expz = ((env_slp - slp_mean) / (slp_std + 1e-10)).fillna(0)

    # Price velocity Z-score
    pvel   = c.diff(P['price_vel_len']).fillna(0)
    pv_m   = sma(pvel, P['env_base_len'])
    pv_s   = stdev(pvel, P['env_base_len'])
    pvelz  = ((pvel - pv_m) / (pv_s + 1e-10)).fillna(0)

    return pd.DataFrame({
        'adx':      adx,
        'htf_ema':  htf,
        'vol_mult': vol_r,
        'env_expz': env_expz,
        'pvel':     pvel,
        'pvelz':    pvelz,
    }, index=df.index)


# ── Trade helpers ─────────────────────────────────────────────────────────────

def _record_close(pos, exit_px, reason, trades):
    notional  = pos['notional']
    entry_fee = notional * P['commission']
    exit_val  = exit_px * pos['qty']
    exit_fee  = exit_val * P['commission']
    if pos['side'] == 'long':
        gross = (exit_px - pos['entry']) * pos['qty']
    else:
        gross = (pos['entry'] - exit_px) * pos['qty']
    net = gross - entry_fee - exit_fee
    trades.append(dict(
        side        = pos['side'],
        entry       = pos['entry'],
        exit        = exit_px,
        notional    = notional,
        qty         = pos['qty'],
        gross_pnl   = round(gross, 4),
        entry_fee   = round(entry_fee, 4),
        exit_fee    = round(exit_fee, 4),
        net_pnl     = round(net, 4),
        reason      = reason,
        dt_open     = pos['dt_open'],
        vol_mult    = round(pos['vol_mult'], 4),
        sig_mult    = round(pos['sig_mult'], 4),
        streak_in   = round(pos['streak'], 4),
        eff_cash    = round(notional, 2),
    ))
    return net


def _next_streak(streak, net_pnl, equity, peak_eq):
    dd = (peak_eq - equity) / peak_eq * 100 if peak_eq > 0 else 0
    if dd > P['dd_reset_pct']:
        return 1.0
    return (min(P['am_mult_cap'], streak * P['growth_rate']) if net_pnl > 0
            else max(1.0, streak * P['decay_rate']))


# ── Main backtest loop ────────────────────────────────────────────────────────

def run_backtest(df: pd.DataFrame, ind: pd.DataFrame):
    trades   = []
    equity   = P['init_capital']
    peak_eq  = equity
    streak   = 1.0
    position = None   # dict when in trade, None when flat

    c_arr   = df['close'].to_numpy()
    h_arr   = df['high'].to_numpy()
    l_arr   = df['low'].to_numpy()
    dt_arr  = df['datetime'].to_numpy() if 'datetime' in df.columns else np.arange(len(df))

    adx_arr  = ind['adx'].to_numpy()
    htf_arr  = ind['htf_ema'].to_numpy()
    vm_arr   = ind['vol_mult'].to_numpy()
    ez_arr   = ind['env_expz'].to_numpy()
    pv_arr   = ind['pvel'].to_numpy()
    pvz_arr  = ind['pvelz'].to_numpy()

    for i in range(1, len(df)):
        close = c_arr[i]
        high  = h_arr[i]
        low   = l_arr[i]

        adx_v  = adx_arr[i]
        htf_v  = htf_arr[i]
        vm_v   = vm_arr[i]
        ez_cur = ez_arr[i]
        ez_prv = ez_arr[i - 1]
        pv     = pv_arr[i]
        pvz    = pvz_arr[i]

        regime_bull  = (not np.isnan(htf_v)) and close > htf_v
        sideways     = (not np.isnan(adx_v)) and adx_v < P['adx_thresh']
        # Pine ta.crossover: prev <= thresh AND curr > thresh
        exp_edge     = ez_prv <= P['expansion_z'] and ez_cur > P['expansion_z']
        abspvz       = abs(pvz)

        go_long  = exp_edge and pv > 0 and abspvz > P['min_vel_z'] and regime_bull and not sideways
        go_short = exp_edge and pv < 0 and abspvz > P['min_vel_z'] and not sideways
        ready    = i > P['warmup']

        # ── Step 1: Check TP / SL intrabar ───────────────────────────────────
        if position is not None:
            p  = position
            cl = None; ep = None

            if p['side'] == 'long':
                if low <= p['sl']:         ep = p['sl'];  cl = 'SL'
                elif high >= p['tp']:      ep = p['tp'];  cl = 'TP'
            else:
                if high >= p['sl']:        ep = p['sl'];  cl = 'SL'
                elif low <= p['tp']:       ep = p['tp'];  cl = 'TP'

            if cl:
                net = _record_close(p, ep, cl, trades)
                equity += net
                if equity > peak_eq: peak_eq = equity
                streak   = _next_streak(streak, net, equity, peak_eq)
                position = None

        # ── Step 2: Bar-close exits (regime / sideways / flip) ───────────────
        if position is not None:
            p      = position
            reason = None
            if not regime_bull and p['side'] == 'long':      reason = 'bear-exit'
            elif sideways:                                    reason = 'sideways-exit'
            elif go_short and p['side'] == 'long':           reason = 'flip-short'
            elif go_long  and p['side'] == 'short':          reason = 'flip-long'

            if reason:
                net = _record_close(p, close, reason, trades)
                equity += net
                if equity > peak_eq: peak_eq = equity
                streak   = _next_streak(streak, net, equity, peak_eq)
                position = None

        # ── Step 3: New entry at bar close ────────────────────────────────────
        if position is None and ready:
            side_in = None
            if go_long:   side_in = 'long'
            elif go_short: side_in = 'short'

            if side_in:
                vm        = float(vm_v) if not np.isnan(vm_v) else 1.0
                sig_m     = max(1.0, min(3.0, abspvz))
                eff_cash  = P['base_cash'] * vm * sig_m * streak
                qty       = eff_cash / close
                tp = close * (1 + P['tp_pct']/100) if side_in == 'long' else close * (1 - P['tp_pct']/100)
                sl = close * (1 - P['sl_pct']/100) if side_in == 'long' else close * (1 + P['sl_pct']/100)
                position = dict(
                    side='long' if side_in == 'long' else 'short',
                    entry=close, qty=qty, notional=eff_cash,
                    tp=tp, sl=sl,
                    dt_open=str(dt_arr[i]),
                    vol_mult=vm, sig_mult=sig_m, streak=streak,
                )

    # Close any position still open at end of data
    if position is not None:
        net = _record_close(position, c_arr[-1], 'end-of-data', trades)
        equity += net

    return trades, equity


# ── Print results ─────────────────────────────────────────────────────────────

def print_results(trades, final_equity, df):
    if not trades:
        print('\nNo trades generated. Check warmup / data length.')
        return None

    t       = pd.DataFrame(trades)
    net_pnl = t['net_pnl'].sum()
    wins    = t[t['net_pnl'] > 0]
    losses  = t[t['net_pnl'] <= 0]
    gross_w = wins['net_pnl'].sum()   if len(wins)   else 0.0
    gross_l = losses['net_pnl'].abs().sum() if len(losses) else 1e-9
    pf      = gross_w / gross_l if gross_l > 0 else float('inf')
    win_r   = len(wins) / len(t) * 100

    # Drawdown on equity curve
    eq_curve = P['init_capital'] + t['net_pnl'].cumsum()
    roll_max = eq_curve.cummax()
    max_dd   = (eq_curve - roll_max).min()
    max_dd_pct = max_dd / P['init_capital'] * 100

    # Annualised Sharpe
    pnls = t['net_pnl'].values
    tpy  = len(t) / 4.5          # trades per year (assumes 4.5 yr window)
    sharpe = (pnls.mean() / pnls.std() * tpy**0.5) if pnls.std() > 0 else 0

    net_pct    = net_pnl / P['init_capital'] * 100
    total_fees = (t['entry_fee'] + t['exit_fee']).sum()

    d0 = pd.to_datetime(df['time'].iloc[P['warmup']], unit='ms').strftime('%Y-%m-%d')
    d1 = pd.to_datetime(df['time'].iloc[-1],          unit='ms').strftime('%Y-%m-%d')

    bar = '=' * 62
    print(f'\n{bar}')
    print(' F40d C104 — Native Python Backtest')
    print(f' ETHUSDT 1H  |  {d0} → {d1}  |  Binance data')
    print(bar)
    print(f'  Net Profit      ${net_pnl:>10,.2f}    ({net_pct:+.2f}%)')
    print(f'  Profit Factor    {pf:.3f}')
    print(f'  Win Rate         {win_r:.1f}%    ({len(wins)}/{len(t)} trades)')
    print(f'  Max Drawdown    ${max_dd:>10,.2f}    ({max_dd_pct:.2f}%)')
    print(f'  Sharpe (ann.)    {sharpe:.3f}')
    print(f'  Total Fees      ${total_fees:,.2f}')
    print(f'  Total Trades     {len(t)}')
    print()
    print(f'  Avg Win         ${wins["net_pnl"].mean():,.2f}')
    print(f'  Avg Loss        ${losses["net_pnl"].mean():,.2f}')
    print(f'  Best Trade      ${t["net_pnl"].max():,.2f}')
    print(f'  Worst Trade     ${t["net_pnl"].min():,.2f}')
    print()
    print(f'  Avg effCash     ${t["eff_cash"].mean():,.0f}   (base $3k × volMult × sigMult × streak)')
    print(f'  Avg volMult      {t["vol_mult"].mean():.3f}')
    print(f'  Avg sigMult      {t["sig_mult"].mean():.3f}')
    print(f'  Avg streakIn     {t["streak_in"].mean():.3f}')
    print()
    print('  ── vs trader.dev backtest ──────────────────────────────')
    print('                      trader.dev      Python/Binance')
    print(f'  Net Profit          +257.91%        {net_pct:+.2f}%')
    print(f'  Profit Factor         1.570         {pf:.3f}')
    print(f'  Max Drawdown         13.76%         {abs(max_dd_pct):.2f}%')
    print(f'  Sharpe                0.999         {sharpe:.3f}')
    print(bar)

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    t.to_csv(OUT_CSV, index=False)
    print(f'\n  Trade log → {OUT_CSV.relative_to(ROOT)}')

    return t


# ── TradingView CSV loader ────────────────────────────────────────────────────

def load_tv_csv(path: str) -> pd.DataFrame:
    """
    Load TradingView exported CSV.  TV exports two formats:
      Format A: time,open,high,low,close,volume  (ISO datetime in 'time')
      Format B: Unix Timestamp,Date,open,high,low,close,volume
    """
    raw = pd.read_csv(path)
    raw.columns = [c.strip().lower().replace(' ', '_') for c in raw.columns]

    # Detect format
    if 'unix_timestamp' in raw.columns:
        raw = raw.rename(columns={'unix_timestamp': 'time'})
        raw['time'] = raw['time'].astype(int) * 1000
    elif 'time' in raw.columns:
        # ISO string or unix ms
        if raw['time'].dtype == object:
            raw['time'] = pd.to_datetime(raw['time'], utc=True).astype('int64') // 1_000_000
        else:
            raw['time'] = raw['time'].astype(int)
            if raw['time'].iloc[0] < 1e12:   # unix seconds
                raw['time'] = raw['time'] * 1000

    df = raw[['time', 'open', 'high', 'low', 'close']].copy()
    df = df.astype({'time': int, 'open': float, 'high': float, 'low': float, 'close': float})
    df = df.drop_duplicates('time').sort_values('time').reset_index(drop=True)
    df['datetime'] = pd.to_datetime(df['time'], unit='ms', utc=True)
    print(f'Loaded {len(df):,} bars from CSV  ({df["datetime"].iloc[0].date()} → {df["datetime"].iloc[-1].date()})')
    return df


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) > 1:
        df = load_tv_csv(sys.argv[1])
    else:
        df = fetch_binance(symbol='ETHUSDT', interval='1h', years=4.5)

    print(f'Computing indicators on {len(df):,} bars...')
    ind = compute_indicators(df)

    # Sanity: how many bars have valid htf_ema (needs 4800 to warm up)
    valid_htf = ind['htf_ema'].notna().sum()
    print(f'  htf_ema valid for {valid_htf:,} bars  (needs ≥4800 to seed)')

    print('Running backtest...')
    t0            = time.time()
    trades, final = run_backtest(df, ind)
    elapsed       = time.time() - t0
    print(f'  Done in {elapsed:.1f}s  →  {len(trades)} trades')

    print_results(trades, final, df)


if __name__ == '__main__':
    main()
