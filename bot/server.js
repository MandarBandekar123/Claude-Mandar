import 'dotenv/config';
import express       from 'express';
import cron          from 'node-cron';
import { config }    from './config.js';
import { Bybit }     from './bybit.js';
import { Tracker }   from './tracker.js';
import { Telegram }  from './telegram.js';
import { startMonitor }      from './monitor.js';
import { startSignalEngine } from './signal-engine.js';

const app = express();
app.use(express.json());

// ── Parse webhook payload into a normalised signal object ───────────────────
function parseSignal(body) {
  const raw    = typeof body === 'string' ? JSON.parse(body) : body;
  const type   = (raw.signal ?? raw.side ?? raw.type ?? raw.action ?? '').toLowerCase();
  const price  = parseFloat(raw.price ?? raw.close ?? 0) || 0;
  const symbol = raw.symbol ?? config.symbol;
  const effCash = raw.effCash ? parseFloat(raw.effCash) : null;

  let side = null;
  if (type === 'buy'  || (type.includes('long')  && !type.includes('exit'))) side = 'Buy';
  if (type === 'sell' || (type.includes('short') && !type.includes('exit'))) side = 'Sell';
  if (type === 'exit_long')  side = 'exit_long';
  if (type === 'exit_short') side = 'exit_short';
  if (type === 'exit_all')   side = 'exit_all';

  return { side, price, symbol, effCash, raw };
}

// ── Core signal processor — called by webhook and signal engine ──────────────
async function processSignal(signal) {
  const { side } = signal;
  const symbol   = signal.symbol ?? config.symbol;

  // ── Exit signals ───────────────────────────────────────────────────────────
  if (side === 'exit_all') {
    const open = Tracker.getOpen();
    if (!open.length) { console.log('exit_all: no open trades'); return; }
    for (const t of open) {
      try { await Bybit.closePosition({ symbol: t.symbol, side: t.side, qty: t.qty }); }
      catch (e) { console.error('exit_all error:', e.message); }
    }
    return;
  }

  if (side === 'exit_long' || side === 'exit_short') {
    const targetSide = side === 'exit_long' ? 'Buy' : 'Sell';
    const trades = Tracker.getOpen().filter(t => t.side === targetSide);
    if (!trades.length) { console.log(`${side}: no matching open trade`); return; }
    for (const t of trades) {
      try { await Bybit.closePosition({ symbol: t.symbol, side: t.side, qty: t.qty }); }
      catch (e) { console.error(`${side} error:`, e.message); }
    }
    return;
  }

  if (!side) { console.log('Unrecognised signal:', JSON.stringify(signal)); return; }

  // ── Close opposite position (flip) ────────────────────────────────────────
  for (const t of Tracker.getOpen()) {
    if ((t.side === 'Buy' && side === 'Sell') || (t.side === 'Sell' && side === 'Buy')) {
      try { await Bybit.closePosition({ symbol: t.symbol, side: t.side, qty: t.qty }); }
      catch (e) { console.error('Flip-close error:', e.message); }
    }
  }

  // ── Resolve entry price ────────────────────────────────────────────────────
  let entryPrice = signal.price;
  if (!entryPrice) {
    try { entryPrice = await Bybit.getPrice(symbol); }
    catch (e) { console.error('Price fetch failed:', e.message); return; }
  }

  // ── Sizing — effCash from signal engine (volMult×signalMult×streakMult) ───
  const notional    = signal.effCash ?? config.baseCash;
  const qty         = parseFloat((notional / entryPrice).toFixed(3));
  const margin      = notional / config.leverage;
  const tpPrice     = side === 'Buy'
    ? entryPrice * (1 + config.tpPct / 100)
    : entryPrice * (1 - config.tpPct / 100);
  const slPrice     = side === 'Buy'
    ? entryPrice * (1 - config.slPct / 100)
    : entryPrice * (1 + config.slPct / 100);
  const entryFee    = notional * config.takerFee;
  const tpNotional  = notional * (1 + (side === 'Buy' ? config.tpPct : -config.tpPct) / 100);
  const slNotional  = notional * (1 - (side === 'Buy' ? config.slPct : -config.slPct) / 100);
  const netIfTp     = notional * config.tpPct / 100 - entryFee - tpNotional * config.makerFee;
  const netIfSl     = -(notional * config.slPct / 100 + entryFee + slNotional * config.takerFee);

  // ── Telegram: signal alert ─────────────────────────────────────────────────
  await Telegram.send(Telegram.signalAlert({
    side, symbol, entryPrice, qty, notional,
    tpPrice, slPrice, leverage: config.leverage,
    margin, entryFee, netIfTp, netIfSl,
  }));

  // ── Place Bybit order ──────────────────────────────────────────────────────
  let orderId;
  try {
    orderId = await Bybit.placeOrder({ side, symbol, qty, tpPrice, slPrice });
    await Telegram.send(Telegram.orderPlaced({ side, symbol, orderId }));
  } catch (e) {
    console.error('Bybit order error:', e.message);
    await Telegram.send(`⚠️ Bybit order FAILED: ${e.message}`);
    return;
  }

  // ── Log trade ──────────────────────────────────────────────────────────────
  Tracker.open({
    side, symbol, entryPrice, qty, notional,
    tpPrice, slPrice,
    leverage:     config.leverage,
    margin,
    entryFee,
    bybitOrderId: orderId,
    openedAt:     new Date().toISOString(),
    signalRaw:    JSON.stringify(signal.raw ?? signal),
  });

  console.log(`Trade opened: ${side} ${qty} ${symbol} @ $${entryPrice} | TP $${tpPrice.toFixed(2)} | SL $${slPrice.toFixed(2)} | notional $${notional.toFixed(0)}`);
}

// ── Webhook endpoint (external signals / manual override) ───────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  console.log('Webhook received:', JSON.stringify(req.body));
  let signal;
  try   { signal = parseSignal(req.body); }
  catch (e) { console.error('Parse error:', e.message); return; }
  await processSignal(signal);
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const open = Tracker.getOpen();
  res.json({ status: 'ok', openTrades: open.length, open });
});

// ── Weekly report: every Monday 08:00 UTC ────────────────────────────────────
cron.schedule('0 8 * * 1', async () => {
  const since    = new Date(Date.now() - 7 * 86400000).toISOString();
  const stats    = Tracker.stats(since);
  const allStats = Tracker.stats();
  const balance  = 10000 + parseFloat(allStats?.netPnl ?? 0);
  await Telegram.send(Telegram.weeklyReport(stats, balance));
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  try {
    await Bybit.setLeverage(config.symbol, config.leverage);
    console.log(`Bybit ${config.bybitTestnet ? 'TESTNET' : 'LIVE'} ready | ${config.leverage}x leverage on ${config.symbol}`);
  } catch (e) { console.error('Bybit init error:', e.message); }

  startMonitor();

  // Native signal engine — fetches OHLCV from Bybit, runs full strategy logic
  startSignalEngine(async (sig) => {
    console.log(`Signal engine → ${sig.side} @ $${sig.price}`);
    await processSignal(sig);
  }).catch(e => console.error('Signal engine startup error:', e.message));

  app.listen(config.port, async () => {
    console.log(`Bot server running on port ${config.port}`);
    try {
      const ip = (await import('os')).default.hostname();
      await Telegram.startupMsg(ip);
    } catch (e) { /* ignore */ }
  });
}

start();
