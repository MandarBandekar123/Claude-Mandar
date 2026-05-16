/**
 * SMA Crossover Backtest — BTCUSDT 1H
 *
 * Strategy: Buy on golden cross (SMA20 > SMA50), sell on death cross (SMA20 < SMA50)
 *
 * Data: Simulated via geometric Brownian motion calibrated to BTC 1H params.
 *       Replace generateCandles() with a real fetch (Binance, Kraken, etc.)
 *       when running locally.
 */

const FAST = 20;
const SLOW = 50;
const INITIAL_CAPITAL = 10_000;
const NUM_CANDLES = 500; // ~20 days of 1H bars

// ── Data generation ──────────────────────────────────────────────────────────

function generateCandles(n, startPrice = 65000) {
  // BTC 1H annualised vol ~80% → hourly σ ≈ 0.80 / √8760
  const mu = 0.0 / 8760;          // drift per hour (neutral)
  const sigma = 0.80 / Math.sqrt(8760);
  const startMs = Date.now() - n * 3600_000;

  let price = startPrice;
  const candles = [];

  // Simple deterministic PRNG (mulberry32) for reproducibility
  let seed = 42;
  const rand = () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const randn = () => {
    const u = rand(), v = rand();
    return Math.sqrt(-2 * Math.log(u + 1e-10)) * Math.cos(2 * Math.PI * v);
  };

  for (let i = 0; i < n; i++) {
    const ret = mu + sigma * randn();
    price = price * Math.exp(ret);

    const noise = price * 0.003;
    const high = price + Math.abs(randn()) * noise;
    const low = price - Math.abs(randn()) * noise;
    const open = price + randn() * noise * 0.5;

    candles.push({
      time: startMs + i * 3600_000,
      open: Math.max(open, 1),
      high: Math.max(high, price),
      low: Math.min(low, price),
      close: price,
      volume: 100 + rand() * 900,
    });
  }
  return candles;
}

// ── Indicators ────────────────────────────────────────────────────────────────

function sma(candles, period) {
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    return sum / period;
  });
}

// ── Backtest engine ───────────────────────────────────────────────────────────

function backtest(candles) {
  const fastSMA = sma(candles, FAST);
  const slowSMA = sma(candles, SLOW);

  let capital = INITIAL_CAPITAL;
  let position = null;
  const trades = [];
  let peak = INITIAL_CAPITAL;
  let maxDrawdown = 0;

  for (let i = 1; i < candles.length; i++) {
    const pf = fastSMA[i - 1], ps = slowSMA[i - 1];
    const cf = fastSMA[i],     cs = slowSMA[i];
    if (pf === null || ps === null || cf === null || cs === null) continue;

    const price = candles[i].close;
    const ts = new Date(candles[i].time).toISOString().replace('T', ' ').slice(0, 16) + 'Z';

    // Golden cross → long entry
    if (!position && pf <= ps && cf > cs) {
      position = { entryPrice: price, shares: capital / price, entryTime: ts };
      console.log(`  BUY  @ $${price.toFixed(2)}  [${ts}]`);
    }

    // Death cross → exit
    if (position && pf >= ps && cf < cs) {
      const value = position.shares * price;
      const pnl = value - capital;
      const pct = (pnl / capital) * 100;
      trades.push({ ...position, exitPrice: price, exitTime: ts, pnl, pct });
      console.log(`  SELL @ $${price.toFixed(2)}  [${ts}]  PnL: $${pnl.toFixed(2)} (${pct.toFixed(2)}%)`);
      capital = value;
      position = null;
    }

    // Track drawdown on running equity
    const equity = position ? position.shares * price : capital;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Mark-to-market any open position
  if (position) {
    const last = candles[candles.length - 1];
    const ts = new Date(last.time).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
    const value = position.shares * last.close;
    const pnl = value - capital;
    const pct = (pnl / capital) * 100;
    trades.push({ ...position, exitPrice: last.close, exitTime: ts + ' [open]', pnl, pct });
    console.log(`  HOLD @ $${last.close.toFixed(2)}  [${ts}]  PnL: $${pnl.toFixed(2)} (${pct.toFixed(2)}%) [open]`);
    capital = value;
  }

  return { trades, finalCapital: capital, maxDrawdown };
}

// ── Reporting ─────────────────────────────────────────────────────────────────

function report(trades, finalCapital, maxDrawdown, candles) {
  const ret = (finalCapital - INITIAL_CAPITAL) / INITIAL_CAPITAL * 100;
  const bh  = (candles[candles.length - 1].close - candles[0].close) / candles[0].close * 100;
  const won = trades.filter(t => t.pnl > 0);
  const lost = trades.filter(t => t.pnl <= 0);
  const avgW = won.length  ? won.reduce((s, t)  => s + t.pct, 0) / won.length  : 0;
  const avgL = lost.length ? lost.reduce((s, t) => s + t.pct, 0) / lost.length : 0;
  const best  = trades.length ? Math.max(...trades.map(t => t.pct)) : 0;
  const worst = trades.length ? Math.min(...trades.map(t => t.pct)) : 0;

  const start = new Date(candles[0].time).toISOString().slice(0, 10);
  const end   = new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║    SMA Crossover Backtest  —  BTCUSDT  1H        ║');
  console.log(`║    Fast SMA ${FAST}  |  Slow SMA ${SLOW}  |  ${start} → ${end}  ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Initial Capital    $${INITIAL_CAPITAL.toLocaleString().padStart(10)}                   ║`);
  console.log(`║  Final Capital      $${finalCapital.toFixed(2).padStart(10)}                   ║`);
  console.log(`║  Strategy Return    ${(ret >= 0 ? '+' : '') + ret.toFixed(2).padStart(8)}%                   ║`);
  console.log(`║  Buy & Hold         ${(bh  >= 0 ? '+' : '') + bh.toFixed(2).padStart(8)}%                   ║`);
  console.log(`║  Max Drawdown       ${('-' + maxDrawdown.toFixed(2)).padStart(9)}%                   ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Total Trades       ${String(trades.length).padStart(10)}                   ║`);
  console.log(`║  Win Rate           ${(won.length / (trades.length || 1) * 100).toFixed(1).padStart(9)}%  (${won.length}W / ${lost.length}L)           ║`);
  console.log(`║  Avg Win            ${('+' + avgW.toFixed(2)).padStart(9)}%                   ║`);
  console.log(`║  Avg Loss           ${avgL.toFixed(2).padStart(9)}%                   ║`);
  console.log(`║  Best Trade         ${('+' + best.toFixed(2)).padStart(9)}%                   ║`);
  console.log(`║  Worst Trade        ${worst.toFixed(2).padStart(9)}%                   ║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('\n[NOTE] Data is simulated (GBM, σ=80% annualised). Run locally');
  console.log('       with a real Binance/Kraken fetch for live results.\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\nGenerating ${NUM_CANDLES} synthetic BTC 1H candles…`);
const candles = generateCandles(NUM_CANDLES);
const start = new Date(candles[0].time).toISOString().replace('T', ' ').slice(0, 16);
const end   = new Date(candles[candles.length - 1].time).toISOString().replace('T', ' ').slice(0, 16);
console.log(`Period: ${start}Z → ${end}Z\n`);
console.log('Trades:');

const { trades, finalCapital, maxDrawdown } = backtest(candles);
report(trades, finalCapital, maxDrawdown, candles);
