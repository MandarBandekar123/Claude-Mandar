// missed-trades.js — replays recent ETHUSDT 1H signals to find missed trades
// Run: node missed-trades.js
// Fetches 5000 bars, warms up indicators, then scans from a start date.

import { createRequire } from 'module';

// ── Strategy params (must match signal-engine.js) ───────────────────────────
const P = {
  adxLen: 14, adxThresh: 20,
  slPct: 2.0, tpPct: 5.0,
  expansionZ: 1.0, minVelZ: 0.5,
  detrendLen: 50, envSmoothLen: 10, envSlopeLen: 10, envBaseLen: 150,
  priceVelLen: 5, volSMALen: 200, htfEMALen: 4800, warmup: 250,
  amMultCap: 3.0, maxRiskPct: 150.0,
  leverage: 25, tpFee: 0.0006, slFee: 0.0006,
};

// ── Indicators ───────────────────────────────────────────────────────────────
function rmaFull(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) s += arr[i];
  out[n - 1] = s / n;
  for (let i = n; i < arr.length; i++) out[i] = (out[i-1] * (n-1) + arr[i]) / n;
  return out;
}
function emaFull(arr, n) {
  const a = 2 / (n + 1), out = new Array(arr.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < n; i++) s += arr[i];
  out[n - 1] = s / n;
  for (let i = n; i < arr.length; i++) out[i] = out[i-1] * (1-a) + arr[i] * a;
  return out;
}
function smaFull(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i];
    if (i >= n) s -= arr[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function stdevFull(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  let s = 0, s2 = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i]; s2 += arr[i] ** 2;
    if (i >= n) { s -= arr[i-n]; s2 -= arr[i-n] ** 2; }
    if (i >= n - 1) {
      const m = s / n;
      out[i] = Math.sqrt(Math.max(0, s2 / n - m * m));
    }
  }
  return out;
}

function compute(candles) {
  const close = candles.map(c => c.close);
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = close[i-1];
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
  const plusDM  = candles.map((c, i) => { if (!i) return 0; const u=c.high-candles[i-1].high, d=candles[i-1].low-c.low; return u>d&&u>0?u:0; });
  const minusDM = candles.map((c, i) => { if (!i) return 0; const u=c.high-candles[i-1].high, d=candles[i-1].low-c.low; return d>u&&d>0?d:0; });
  const sTR=rmaFull(tr,P.adxLen), sPDM=rmaFull(plusDM,P.adxLen), sMDM=rmaFull(minusDM,P.adxLen);
  const pdi=sPDM.map((v,i)=>100*v/(sTR[i]+1e-10)), mdi=sMDM.map((v,i)=>100*v/(sTR[i]+1e-10));
  const dx=pdi.map((v,i)=>100*Math.abs(v-mdi[i])/(v+mdi[i]+1e-10));
  const adx=rmaFull(dx,P.adxLen);
  const htfEMA=emaFull(close,P.htfEMALen);
  const atr14=rmaFull(tr,14), normATR=atr14.map((v,i)=>v/(close[i]+1e-10)), refATR=smaFull(normATR,P.volSMALen);
  const trend=smaFull(close,P.detrendLen), osc=close.map((c,i)=>isNaN(trend[i])?0:c-trend[i]);
  const quad=osc.map((_,i)=>{const g=k=>i-k>=0?osc[i-k]:0; return 0.0962*g(0)+0.5769*g(2)-0.5769*g(4)-0.0962*g(6);});
  const envInst=osc.map((v,i)=>Math.sqrt(v*v+quad[i]*quad[i])), env=emaFull(envInst,P.envSmoothLen);
  const envSlope=env.map((v,i)=>i<P.envSlopeLen||isNaN(v)||isNaN(env[i-P.envSlopeLen])?NaN:v-env[i-P.envSlopeLen]);
  const envSlopeNz=envSlope.map(v=>isNaN(v)?0:v);
  const envSlopeMean=smaFull(envSlopeNz,P.envBaseLen), envSlopeStd=stdevFull(envSlopeNz,P.envBaseLen);
  const envExpZ=envSlope.map((v,i)=>isNaN(v)||isNaN(envSlopeMean[i])||envSlopeStd[i]<1e-10?0:(v-envSlopeMean[i])/envSlopeStd[i]);
  const priceVel=close.map((c,i)=>i<P.priceVelLen?0:c-close[i-P.priceVelLen]);
  const pvMean=smaFull(priceVel,P.envBaseLen), pvStd=stdevFull(priceVel,P.envBaseLen);
  const priceVelZ=priceVel.map((v,i)=>isNaN(pvMean[i])||pvStd[i]<1e-10?0:(v-pvMean[i])/pvStd[i]);
  return { adx, htfEMA, normATR, refATR, envExpZ, priceVel, priceVelZ };
}

// ── Fetch klines from Bybit ──────────────────────────────────────────────────
async function fetchKlines(totalBars) {
  const bars = [];
  let endTime;
  while (bars.length < totalBars) {
    const p = new URLSearchParams({ category:'linear', symbol:'ETHUSDT', interval:'60', limit:'200', ...(endTime?{end:String(endTime)}:{}) });
    const res  = await fetch(`https://api.bybit.com/v5/market/kline?${p}`);
    const json = await res.json();
    if (json.retCode !== 0 || !json.result?.list?.length) break;
    const batch = json.result.list.map(r => ({ time:parseInt(r[0]), open:parseFloat(r[1]), high:parseFloat(r[2]), low:parseFloat(r[3]), close:parseFloat(r[4]) }));
    bars.push(...batch);
    if (batch.length < 200) break;
    endTime = batch[batch.length-1].time - 1;
    await new Promise(r => setTimeout(r, 150));
  }
  bars.sort((a,b) => a.time - b.time);
  return bars.slice(-totalBars);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const BOT_START = new Date('2026-05-26T00:00:00Z').getTime(); // bot deployed

console.log('Fetching 5000 ETHUSDT 1H bars...');
const candles = await fetchKlines(5000);
console.log(`Loaded ${candles.length} bars. Latest: ${new Date(candles[candles.length-1].time).toISOString()}`);

const ind = compute(candles);
const n   = candles.length;

let openTrade = null;
let trades    = [];
let equity    = 10000;
let peakEq    = 10000;
let streakMult = 1.0;

for (let i = P.warmup + 1; i < n; i++) {
  const c    = candles[i];
  const ip   = i - 1;

  // ── Check open trade outcome ───────────────────────────────────────────────
  if (openTrade) {
    const { side, entry, tp, sl, effCash, notional, openTime } = openTrade;
    let result = null;

    if (side === 'Buy') {
      if (c.high >= tp) result = 'TP';
      else if (c.low <= sl) result = 'SL';
    } else {
      if (c.low <= tp) result = 'TP';
      else if (c.high >= sl) result = 'SL';
    }

    if (result) {
      const pnl = result === 'TP'
        ? notional * P.tpPct / 100 - notional * P.tpFee * 2
        : -(notional * P.slPct / 100 + notional * P.tpFee * 2);
      equity += pnl;
      if (equity > peakEq) peakEq = equity;
      streakMult = pnl > 0
        ? Math.min(P.amMultCap, streakMult * 2.0)
        : Math.max(1.0, streakMult * 0.9);
      const ddPct = (peakEq - equity) / peakEq * 100;
      if (ddPct > 5) { streakMult = 1.0; peakEq = equity; }

      trades.push({ ...openTrade, closeTime: new Date(c.time).toISOString(), result, pnl: +pnl.toFixed(2), equity: +equity.toFixed(2) });
      openTrade = null;
    }
  }

  // ── Only look for new signals from bot-start date ─────────────────────────
  if (c.time < BOT_START) continue;
  if (openTrade) continue; // already in a trade

  const adxVal     = ind.adx[i];
  const htfVal     = ind.htfEMA[i];
  const regimeBull = !isNaN(htfVal) && c.close > htfVal;
  const sideways   = !isNaN(adxVal) && adxVal < P.adxThresh;
  const envExpZcur = ind.envExpZ[i];
  const envExpZprv = ind.envExpZ[ip];
  const expansionEdge = envExpZprv <= P.expansionZ && envExpZcur > P.expansionZ;

  if (!expansionEdge || sideways) continue;

  const priceVelZ = ind.priceVelZ[i];
  const priceVel  = ind.priceVel[i];
  const absPVZ    = Math.abs(priceVelZ);
  if (absPVZ <= P.minVelZ) continue;

  const normATR = ind.normATR[i], refATR = ind.refATR[i];
  const volRatio = (!isNaN(refATR) && refATR > 1e-10) ? normATR / refATR : 1;
  const volMult  = Math.max(1.0, Math.min(1.5, volRatio));
  const signalMult = Math.max(1.0, Math.min(3.0, absPVZ));
  const maxCash = equity * P.maxRiskPct / 100;
  const effCash = Math.min(equity * volMult * signalMult * streakMult, maxCash);
  const notional = effCash;

  if (priceVel > 0 && regimeBull) {
    const tp = c.close * (1 + P.tpPct / 100);
    const sl = c.close * (1 - P.slPct / 100);
    openTrade = { side:'Buy', entry:c.close, tp, sl, effCash, notional, openTime:new Date(c.time).toISOString(), volMult:+volMult.toFixed(2), signalMult:+signalMult.toFixed(2), streakMult:+streakMult.toFixed(2) };
  } else if (priceVel < 0) {
    const tp = c.close * (1 - P.tpPct / 100);
    const sl = c.close * (1 + P.slPct / 100);
    openTrade = { side:'Sell', entry:c.close, tp, sl, effCash, notional, openTime:new Date(c.time).toISOString(), volMult:+volMult.toFixed(2), signalMult:+signalMult.toFixed(2), streakMult:+streakMult.toFixed(2) };
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════');
console.log(`  MISSED TRADES (since ${new Date(BOT_START).toDateString()})`);
console.log('════════════════════════════════════════════\n');

if (!trades.length && !openTrade) {
  console.log('No signals fired in this period — strategy conditions not met.');
} else {
  let totalPnl = 0;
  trades.forEach((t, idx) => {
    totalPnl += t.pnl;
    const icon = t.result === 'TP' ? '✅' : '❌';
    console.log(`#${idx+1} ${icon} ${t.side.padEnd(4)} | Open: ${t.openTime.slice(0,16)} @ $${t.entry.toFixed(2)}`);
    console.log(`       Close: ${t.closeTime.slice(0,16)} | ${t.result} | PnL: $${t.pnl >= 0 ? '+' : ''}${t.pnl} | Notional: $${t.notional.toFixed(0)} | Equity: $${t.equity}`);
    console.log(`       volMult=${t.volMult} signalMult=${t.signalMult} streakMult=${t.streakMult}\n`);
  });

  if (openTrade) {
    const cur = candles[candles.length-1];
    const unrealPnl = openTrade.side === 'Buy'
      ? (cur.close - openTrade.entry) * (openTrade.notional / openTrade.entry)
      : (openTrade.entry - cur.close) * (openTrade.notional / openTrade.entry);
    console.log(`OPEN: ${openTrade.side} @ $${openTrade.entry.toFixed(2)} since ${openTrade.openTime.slice(0,16)}`);
    console.log(`      TP $${openTrade.tp.toFixed(2)} | SL $${openTrade.sl.toFixed(2)} | Unrealised PnL: $${unrealPnl >= 0 ? '+' : ''}${unrealPnl.toFixed(2)}\n`);
  }

  console.log('────────────────────────────────────────────');
  console.log(`Trades: ${trades.length} | W: ${trades.filter(t=>t.result==='TP').length} L: ${trades.filter(t=>t.result==='SL').length}`);
  console.log(`Total missed PnL: $${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`);
  console.log(`Equity if running: $${equity.toFixed(2)} (started $10,000)`);
  console.log('════════════════════════════════════════════\n');
}
