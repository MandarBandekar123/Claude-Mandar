// signal-engine.js — native implementation of strategy_v2_fixed3k.pine
// Fetches 1H OHLCV from Bybit public API, runs all indicators, fires signals.
// No trader.dev dependency; runs entirely on EC2.

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join }   from 'path';
import { fileURLToPath }   from 'url';
import { Tracker }         from './tracker.js';
import { config }          from './config.js';

const __dir      = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dir, 'signal-state.json');

// ── Strategy parameters — exact mirror of strategy_v2_fixed3k.pine ───────────
const P = {
  adxLen:      14,
  adxThresh:   20,    // sideways filter
  slPct:       2.0,
  tpPct:       5.0,
  growthRate:  2.0,   // streak win multiplier
  decayRate:   0.9,   // streak loss decay
  expansionZ:  1.0,   // envelope edge threshold
  minVelZ:     0.5,   // minimum price velocity Z-score
  detrendLen:  50,    // SMA detrend length
  ddResetPct:  5.0,   // streak reset drawdown %
  baseCash:    3000.0,
  amMultCap:   3.0,
  maxRiskPct:  30.0,   // effCash never exceeds 30% of current equity   // max streak multiplier
  htfEMALen:   4800,  // 200-day EMA proxy on 1H bars
  envSmoothLen: 10,
  envSlopeLen:  10,
  envBaseLen:   150,
  priceVelLen:  5,
  volSMALen:    200,
  warmup:       250,  // detrendLen + envBaseLen + 50
};

// ── Indicator helpers ────────────────────────────────────────────────────────

// Wilder's smoothing (Pine's ta.rma)
function rmaFull(arr, period) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += arr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < arr.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + arr[i]) / period;
  }
  return out;
}

function emaFull(arr, period) {
  const alpha = 2 / (period + 1);
  const out   = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += arr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < arr.length; i++) {
    out[i] = out[i - 1] * (1 - alpha) + arr[i] * alpha;
  }
  return out;
}

function smaFull(arr, period) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Population stdev (matches Pine's ta.stdev)
function stdevFull(arr, period) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    sum += v; sumSq += v * v;
    if (i >= period) { sum -= arr[i - period]; sumSq -= arr[i - period] ** 2; }
    if (i >= period - 1) {
      const mean = sum / period;
      out[i] = Math.sqrt(Math.max(0, sumSq / period - mean * mean));
    }
  }
  return out;
}

// ── Full indicator computation (all series over candle array) ────────────────
function compute(candles) {
  const close = candles.map(c => c.close);
  const high  = candles.map(c => c.high);
  const low   = candles.map(c => c.low);

  // True Range
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = close[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });

  // Directional Movement
  const plusDM  = candles.map((c, i) => {
    if (i === 0) return 0;
    const up = c.high - candles[i-1].high, dn = candles[i-1].low - c.low;
    return (up > dn && up > 0) ? up : 0;
  });
  const minusDM = candles.map((c, i) => {
    if (i === 0) return 0;
    const up = c.high - candles[i-1].high, dn = candles[i-1].low - c.low;
    return (dn > up && dn > 0) ? dn : 0;
  });

  const sTR  = rmaFull(tr, P.adxLen);
  const sPDM = rmaFull(plusDM,  P.adxLen);
  const sMDM = rmaFull(minusDM, P.adxLen);
  const pdi  = sPDM.map((v, i) => 100 * v / (sTR[i] + 1e-10));
  const mdi  = sMDM.map((v, i) => 100 * v / (sTR[i] + 1e-10));
  const dx   = pdi.map((v, i) => 100 * Math.abs(v - mdi[i]) / (v + mdi[i] + 1e-10));
  const adx  = rmaFull(dx, P.adxLen);

  // 200-day EMA proxy — EMA(close, 4800) on 1H data
  const htfEMA = emaFull(close, P.htfEMALen);

  // ATR14 → normalised ATR → vol multiplier
  const atr14   = rmaFull(tr, 14);
  const normATR = atr14.map((v, i) => v / (close[i] + 1e-10));
  const refATR  = smaFull(normATR, P.volSMALen);

  // Hilbert envelope oscillator (Pine's Ehlers approximation)
  const trend  = smaFull(close, P.detrendLen);
  const osc    = close.map((c, i) => isNaN(trend[i]) ? 0 : c - trend[i]);
  const quad   = osc.map((_, i) => {
    const g = k => (i - k >= 0 ? osc[i - k] : 0);
    return 0.0962 * g(0) + 0.5769 * g(2) - 0.5769 * g(4) - 0.0962 * g(6);
  });
  const envInst = osc.map((v, i) => Math.sqrt(v * v + quad[i] * quad[i]));
  const env     = emaFull(envInst, P.envSmoothLen);

  const envSlope = env.map((v, i) =>
    (i < P.envSlopeLen || isNaN(v) || isNaN(env[i - P.envSlopeLen]))
      ? NaN : v - env[i - P.envSlopeLen]
  );
  const envSlopeNz   = envSlope.map(v => isNaN(v) ? 0 : v);
  const envSlopeMean = smaFull(envSlopeNz, P.envBaseLen);
  const envSlopeStd  = stdevFull(envSlopeNz, P.envBaseLen);
  const envExpZ = envSlope.map((v, i) => {
    if (isNaN(v) || isNaN(envSlopeMean[i]) || envSlopeStd[i] < 1e-10) return 0;
    return (v - envSlopeMean[i]) / envSlopeStd[i];
  });

  // Price velocity Z-score
  const priceVel  = close.map((c, i) => (i < P.priceVelLen ? 0 : c - close[i - P.priceVelLen]));
  const pvMean    = smaFull(priceVel, P.envBaseLen);
  const pvStd     = stdevFull(priceVel, P.envBaseLen);
  const priceVelZ = priceVel.map((v, i) => {
    if (isNaN(pvMean[i]) || pvStd[i] < 1e-10) return 0;
    return (v - pvMean[i]) / pvStd[i];
  });

  return { adx, htfEMA, normATR, refATR, envExpZ, priceVel, priceVelZ };
}

// ── Streak state (persisted to signal-state.json) ────────────────────────────
function loadState() {
  if (!existsSync(STATE_FILE)) return { streakMult: 1.0, peakEquity: 10000 };
  try   { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { streakMult: 1.0, peakEquity: 10000 }; }
}

function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// Called by monitor.js after each trade closes
export function updateStreak(netPnl) {
  const s      = loadState();
  const total  = parseFloat(Tracker.stats()?.netPnl ?? 0);
  const equity = 10000 + total;

  if (equity > s.peakEquity) s.peakEquity = equity;
  const ddPct = (s.peakEquity - equity) / s.peakEquity * 100;

  if (ddPct > P.ddResetPct) {
    s.streakMult = 1.0;
    s.peakEquity = equity;
  } else {
    s.streakMult = netPnl > 0
      ? Math.min(P.amMultCap, s.streakMult * P.growthRate)
      : Math.max(1.0,         s.streakMult * P.decayRate);
  }

  saveState(s);
  console.log(`Streak: ${s.streakMult.toFixed(2)}x | equity $${equity.toFixed(0)} | DD ${ddPct.toFixed(1)}%`);
  return s.streakMult;
}

// ── Bybit public kline fetch (no auth required) ───────────────────────────────
async function fetchKlines(symbol, totalBars) {
  const bars = [];
  let endTime;

  while (bars.length < totalBars) {
    const p = new URLSearchParams({
      category: 'linear', symbol, interval: '60', limit: '200',
      ...(endTime ? { end: String(endTime) } : {}),
    });
    const res  = await fetch(`https://api.bybit.com/v5/market/kline?${p}`);
    const json = await res.json();
    if (json.retCode !== 0 || !json.result?.list?.length) break;

    // [startTimeMs, open, high, low, close, volume, turnover], newest first
    const batch = json.result.list.map(r => ({
      time:  parseInt(r[0]),
      open:  parseFloat(r[1]),
      high:  parseFloat(r[2]),
      low:   parseFloat(r[3]),
      close: parseFloat(r[4]),
    }));

    bars.push(...batch);
    if (batch.length < 200) break;
    endTime = batch[batch.length - 1].time - 1;
    await new Promise(r => setTimeout(r, 120)); // ~8 req/s, well within limits
  }

  bars.sort((a, b) => a.time - b.time);
  return bars.slice(-totalBars);
}

// ── Signal check ─────────────────────────────────────────────────────────────
let cache = [];

async function refresh(symbol) {
  if (!cache.length) {
    cache = await fetchKlines(symbol, 5000);
    console.log(`Signal engine: ${cache.length} candles loaded`);
    return;
  }
  const fresh   = await fetchKlines(symbol, 10);
  const lastTs  = cache[cache.length - 1].time;
  const newBars = fresh.filter(c => c.time > lastTs);
  if (newBars.length) {
    cache.push(...newBars);
    if (cache.length > 5500) cache = cache.slice(-5000);
    console.log(`Signal engine: +${newBars.length} new bar(s)`);
  }
}

export async function runSignalCheck(onSignal) {
  await refresh(config.symbol);

  // Use only fully closed bars (exclude the current forming bar)
  const curHourMs = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const closed    = cache.filter(c => c.time < curHourMs);
  const n         = closed.length;

  if (n < P.warmup + 2) {
    console.log(`Signal engine: only ${n} closed bars, need ${P.warmup + 2}`);
    return;
  }

  const ind = compute(closed);
  const i   = n - 1;   // latest closed bar
  const ip  = i - 1;   // bar before it

  const adxVal     = ind.adx[i];
  const htfVal     = ind.htfEMA[i];
  const regimeBull = !isNaN(htfVal) && closed[i].close > htfVal;
  const sideways   = !isNaN(adxVal) && adxVal < P.adxThresh;

  const normATR  = ind.normATR[i];
  const refATR   = ind.refATR[i];
  const volRatio = (!isNaN(refATR) && refATR > 1e-10) ? normATR / refATR : 1;
  const volMult  = Math.max(1.0, Math.min(1.5, volRatio));

  const envExpZcur = ind.envExpZ[i];
  const envExpZprv = ind.envExpZ[ip];
  // Pine ta.crossover: prev <= threshold, curr > threshold
  const expansionEdge = envExpZprv <= P.expansionZ && envExpZcur > P.expansionZ;

  const priceVel  = ind.priceVel[i];
  const priceVelZ = ind.priceVelZ[i];
  const closePrice = closed[i].close;
  const barTime    = new Date(closed[i].time).toISOString();

  const open = Tracker.getOpen();

  // ── Regime / sideways exits (checked every bar) ───────────────────────────
  if (!regimeBull && open.some(t => t.side === 'Buy')) {
    console.log(`[${barTime}] Bear regime — closing long`);
    await onSignal({ side: 'exit_long', price: closePrice, reason: 'bear-exit' });
  }
  if (sideways && open.length) {
    console.log(`[${barTime}] Sideways (ADX ${adxVal?.toFixed(1)}) — closing all`);
    await onSignal({ side: 'exit_all', price: closePrice, reason: 'sideways-exit' });
    return;
  }

  if (!expansionEdge) return; // no new signal this bar

  const absPVZ     = Math.abs(priceVelZ);
  const signalMult = Math.max(1.0, Math.min(3.0, absPVZ));
  const { streakMult } = loadState();
  const totalPnl   = parseFloat(Tracker.stats()?.netPnl ?? 0);
  const equity     = 10000 + totalPnl;
  const maxCash    = equity * P.maxRiskPct / 100;
  const effCash    = Math.min(P.baseCash * volMult * signalMult * streakMult, maxCash);

  const meta = {
    effCash,
    volMult:    +volMult.toFixed(3),
    signalMult: +signalMult.toFixed(3),
    streakMult: +streakMult.toFixed(3),
    adx:        +adxVal?.toFixed(2),
    envExpZ:    +envExpZcur?.toFixed(3),
    priceVelZ:  +priceVelZ?.toFixed(3),
    barTime,
  };

  console.log(`[${barTime}] Expansion edge | PVZ=${priceVelZ.toFixed(2)} regime=${regimeBull} sideways=${sideways}`);

  if (priceVel > 0 && absPVZ > P.minVelZ && regimeBull && !sideways) {
    if (open.some(t => t.side === 'Sell'))
      await onSignal({ side: 'exit_short', price: closePrice, reason: 'flip-long' });
    await onSignal({ side: 'Buy',  price: closePrice, ...meta });

  } else if (priceVel < 0 && absPVZ > P.minVelZ && !sideways) {
    if (open.some(t => t.side === 'Buy'))
      await onSignal({ side: 'exit_long', price: closePrice, reason: 'flip-short' });
    await onSignal({ side: 'Sell', price: closePrice, ...meta });
  }
}

// ── Scheduler: fire at :01 past each hour ────────────────────────────────────
export async function startSignalEngine(onSignal) {
  console.log('Signal engine: pre-loading 5000 1H candles from Bybit...');
  cache = await fetchKlines(config.symbol, 5000);
  console.log(`Signal engine: ${cache.length} candles ready — engine armed`);

  function scheduleNext() {
    const now        = Date.now();
    const nextHourMs = (Math.floor(now / 3_600_000) + 1) * 3_600_000;
    const delay      = nextHourMs - now + 65_000; // 65s past the hour for bar to settle
    console.log(`Signal engine: next check in ${Math.round(delay / 60000)} min`);

    setTimeout(async () => {
      try   { await runSignalCheck(onSignal); }
      catch (e) { console.error('Signal engine error:', e.message); }
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}
