#!/usr/bin/env python3
"""
hilbert-envelope/check.py — live Hilbert Envelope Oscillator signal check.

Fetches 1H ETHUSDT candles from Bybit public API (no auth needed),
runs the full indicator stack, and reports whether a signal would fire
and how far away we are from one.
"""

import sys, argparse, json, math, urllib.request, urllib.parse

# ── Strategy parameters (must match signal-engine.js) ───────────────────────
P = dict(
    adxLen=14, adxThresh=20,
    htfEMALen=4800, detrendLen=50,
    envSmoothLen=10, envSlopeLen=10, envBaseLen=150,
    priceVelLen=5, volSMALen=200, warmup=250,
    expansionZ=1.0, minVelZ=0.5,
)

# ── Indicator helpers ────────────────────────────────────────────────────────

def rma(arr, n):
    out = [float('nan')] * len(arr)
    s = sum(arr[:n])
    out[n-1] = s / n
    for i in range(n, len(arr)):
        out[i] = (out[i-1] * (n-1) + arr[i]) / n
    return out

def ema(arr, n):
    a   = 2 / (n + 1)
    out = [float('nan')] * len(arr)
    s   = sum(arr[:n])
    out[n-1] = s / n
    for i in range(n, len(arr)):
        out[i] = out[i-1] * (1 - a) + arr[i] * a
    return out

def sma(arr, n):
    out = [float('nan')] * len(arr)
    s = 0
    for i in range(len(arr)):
        s += arr[i]
        if i >= n: s -= arr[i-n]
        if i >= n-1: out[i] = s / n
    return out

def stdev(arr, n):
    out = [float('nan')] * len(arr)
    s = s2 = 0
    for i in range(len(arr)):
        s += arr[i]; s2 += arr[i]**2
        if i >= n: s -= arr[i-n]; s2 -= arr[i-n]**2
        if i >= n-1:
            m = s / n
            out[i] = math.sqrt(max(0, s2/n - m*m))
    return out

# ── Fetch klines (Bybit public, no auth) ─────────────────────────────────────

def fetch_klines(symbol, total):
    bars, end_time = [], None
    while len(bars) < total:
        params = {'category':'linear','symbol':symbol,'interval':'60','limit':'200'}
        if end_time: params['end'] = str(end_time)
        url = 'https://api.bybit.com/v5/market/kline?' + urllib.parse.urlencode(params)
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read())
        if data['retCode'] != 0 or not data['result'].get('list'):
            break
        batch = [{'time':int(x[0]),'open':float(x[1]),'high':float(x[2]),
                  'low':float(x[3]),'close':float(x[4])} for x in data['result']['list']]
        bars.extend(batch)
        if len(batch) < 200: break
        end_time = batch[-1]['time'] - 1
    bars.sort(key=lambda x: x['time'])
    return bars[-total:]

# ── Full indicator computation ────────────────────────────────────────────────

def compute(candles):
    close = [c['close'] for c in candles]
    high  = [c['high']  for c in candles]
    low   = [c['low']   for c in candles]
    n     = len(candles)

    tr = [candles[i]['high'] - candles[i]['low'] if i == 0
          else max(high[i]-low[i], abs(high[i]-close[i-1]), abs(low[i]-close[i-1]))
          for i in range(n)]
    pdm = [0 if i==0 else (high[i]-high[i-1] if high[i]-high[i-1]>low[i-1]-low[i] and high[i]-high[i-1]>0 else 0) for i in range(n)]
    mdm = [0 if i==0 else (low[i-1]-low[i] if low[i-1]-low[i]>high[i]-high[i-1] and low[i-1]-low[i]>0 else 0) for i in range(n)]

    sTR = rma(tr, P['adxLen']); sPDM = rma(pdm, P['adxLen']); sMDM = rma(mdm, P['adxLen'])
    pdi = [100*sPDM[i]/(sTR[i]+1e-10) for i in range(n)]
    mdi = [100*sMDM[i]/(sTR[i]+1e-10) for i in range(n)]
    dx  = [100*abs(pdi[i]-mdi[i])/(pdi[i]+mdi[i]+1e-10) for i in range(n)]
    adx = rma(dx, P['adxLen'])

    htfEMA = ema(close, P['htfEMALen'])
    atr14  = rma(tr, 14)
    normATR = [atr14[i]/(close[i]+1e-10) for i in range(n)]
    refATR  = sma(normATR, P['volSMALen'])

    trend  = sma(close, P['detrendLen'])
    osc    = [0 if math.isnan(trend[i]) else close[i]-trend[i] for i in range(n)]
    quad   = [0.0962*osc[i] + 0.5769*(osc[i-2] if i>=2 else 0)
              - 0.5769*(osc[i-4] if i>=4 else 0) - 0.0962*(osc[i-6] if i>=6 else 0)
              for i in range(n)]
    envInst = [math.sqrt(osc[i]**2 + quad[i]**2) for i in range(n)]
    env_s   = ema(envInst, P['envSmoothLen'])

    env_slope = [float('nan') if i<P['envSlopeLen'] or math.isnan(env_s[i]) or math.isnan(env_s[i-P['envSlopeLen']])
                 else env_s[i]-env_s[i-P['envSlopeLen']] for i in range(n)]
    env_nz    = [0 if math.isnan(v) else v for v in env_slope]
    esp_mean  = sma(env_nz, P['envBaseLen'])
    esp_std   = stdev(env_nz, P['envBaseLen'])
    envExpZ   = [0 if math.isnan(env_slope[i]) or math.isnan(esp_mean[i]) or esp_std[i]<1e-10
                 else (env_slope[i]-esp_mean[i])/esp_std[i] for i in range(n)]

    pvel   = [0 if i<P['priceVelLen'] else close[i]-close[i-P['priceVelLen']] for i in range(n)]
    pv_mean = sma(pvel, P['envBaseLen'])
    pv_std  = stdev(pvel, P['envBaseLen'])
    priceVelZ = [0 if math.isnan(pv_mean[i]) or pv_std[i]<1e-10
                 else (pvel[i]-pv_mean[i])/pv_std[i] for i in range(n)]

    return adx, htfEMA, normATR, refATR, envExpZ, pvel, priceVelZ

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--symbol', default='ETHUSDT')
    ap.add_argument('--bars',   type=int, default=5000)
    ap.add_argument('--json',   action='store_true')
    args = ap.parse_args()

    import time as _time
    print(f"Fetching {args.bars} 1H bars for {args.symbol}...", file=sys.stderr)
    candles = fetch_klines(args.symbol, args.bars)
    if len(candles) < P['warmup'] + 2:
        print(f"ERROR: only {len(candles)} bars loaded", file=sys.stderr); sys.exit(1)

    # Exclude current forming bar
    cur_hour_ms = int(_time.time() / 3600) * 3_600_000
    closed = [c for c in candles if c['time'] < cur_hour_ms]
    n = len(closed)

    adx, htfEMA, normATR, refATR, envExpZ, pvel, priceVelZ = compute(closed)
    i, ip = n-1, n-2

    bar_time   = closed[i]['time']
    from datetime import datetime, timezone
    bar_iso    = datetime.fromtimestamp(bar_time/1000, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    adx_val    = adx[i]
    htf_val    = htfEMA[i]
    regime     = not math.isnan(htf_val) and closed[i]['close'] > htf_val
    sideways   = not math.isnan(adx_val) and adx_val < P['adxThresh']
    ezc, ezp   = envExpZ[i], envExpZ[ip]
    edge       = ezp <= P['expansionZ'] and ezc > P['expansionZ']
    pvz        = priceVelZ[i]
    pv         = pvel[i]
    abs_pvz    = abs(pvz)

    nr = P['normATR'][i] if False else normATR[i]  # just normATR[i]
    rr = refATR[i]
    vol_ratio  = normATR[i] / (refATR[i]+1e-10) if not math.isnan(refATR[i]) else 1.0
    vol_mult   = max(1.0, min(1.5, vol_ratio))

    signal = None
    reasons = []
    if edge:
        if pv > 0 and abs_pvz > P['minVelZ'] and regime and not sideways:
            signal = 'Buy'
        elif pv < 0 and abs_pvz > P['minVelZ'] and not sideways:
            signal = 'Sell'

    if not edge:
        reasons.append(f"envExpZ={ezc:.2f} (prev={ezp:.2f}; need crossover {P['expansionZ']})")
    if abs_pvz <= P['minVelZ']:
        reasons.append(f"PVZ={pvz:.2f} (need >{P['minVelZ']})")
    if sideways:
        reasons.append(f"ADX={adx_val:.1f} (sideways, need >{P['adxThresh']})")
    if not regime and (signal != 'Sell'):
        reasons.append("bear regime (short ok, long blocked)")

    out = {
        'bar_time':       bar_iso,
        'signal':         signal,
        'envExpZ_cur':    round(ezc, 3),
        'envExpZ_prev':   round(ezp, 3),
        'expansion_edge': edge,
        'priceVelZ':      round(pvz, 3),
        'adx':            round(adx_val, 2) if not math.isnan(adx_val) else None,
        'regime_bull':    regime,
        'sideways':       sideways,
        'vol_mult':       round(vol_mult, 3),
        'no_signal_reasons': reasons,
    }

    if args.json:
        print(json.dumps(out))
        return

    icon = '🟢' if signal else '🔴'
    print(f"\n{icon} [{bar_iso}] signal={signal or 'None'}")
    print(f"   envExpZ: {ezc:.3f} (prev={ezp:.3f}) edge={'YES' if edge else 'no'}")
    print(f"   PVZ:     {pvz:.3f}  |  ADX: {adx_val:.1f}  |  regime={'bull' if regime else 'BEAR'}")
    print(f"   volMult: {vol_mult:.2f}")
    if reasons:
        print(f"   No signal: {'; '.join(reasons)}")
    else:
        print(f"   ✅ All conditions met → {signal}")

if __name__ == '__main__':
    main()
