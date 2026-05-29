import 'dotenv/config';
import express       from 'express';
import cron          from 'node-cron';
import { exec }      from 'child_process';
import { config }    from './config.js';
import { Bybit }     from './bybit.js';
import { Tracker }   from './tracker.js';
import { Telegram }  from './telegram.js';
import { startMonitor }                  from './monitor.js';
import { startSignalEngine, getState }  from './signal-engine.js';

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
  const qty         = parseFloat((notional / entryPrice).toFixed(2));
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

// ── Deploy endpoint — git pull then restart via PM2 ───────────────────────────
app.post('/deploy', (req, res) => {
  const secret = req.query.secret || req.headers['x-deploy-secret'];
  if (!config.deploySecret || secret !== config.deploySecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json({ ok: true, message: 'deploying...' });
  exec(
    'cd /home/ec2-user/f40d-bot && git pull origin claude/add-trader-dev-mcp-dJbZq',
    (err, stdout, stderr) => {
      console.log('Deploy pull:', stdout || stderr);
      setTimeout(() => process.exit(0), 300); // PM2 auto-restarts with new code
    }
  );
});

// ── Daily dashboard: every day at 08:00 UTC ──────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  try {
    const open       = Tracker.getOpen();
    const todayTrades = Tracker.today();
    const allStats   = Tracker.stats();
    const { streakMult, peakEquity } = getState();
    const totalPnl   = parseFloat(allStats?.netPnl ?? 0);
    const equity     = 10000 + totalPnl;
    const ddPct      = peakEquity > equity ? (peakEquity - equity) / peakEquity * 100 : 0;

    let currentPrice = null;
    let unrealisedPnl = 0;
    if (open.length) {
      try { currentPrice = await Bybit.getPrice(config.symbol); } catch {}
      if (currentPrice) {
        const t = open[0];
        unrealisedPnl = t.side === 'Buy'
          ? (currentPrice - t.entryPrice) * t.qty
          : (t.entryPrice - currentPrice) * t.qty;
      }
    }

    // Minutes until next hour-close signal check
    const now = new Date();
    const nextHourIn = 60 - now.getUTCMinutes();

    await Telegram.send(Telegram.dailyDashboard({
      date: now,
      openTrade:     open[0] || null,
      currentPrice,
      unrealisedPnl,
      todayTrades,
      allStats,
      streakMult,
      peakEquity:    peakEquity || equity,
      equity,
      ddPct,
      nextHourIn,
    }));
  } catch (e) { console.error('Daily dashboard error:', e.message); }
});

// ── Weekly report: every Monday 08:00 UTC ────────────────────────────────────
// (Kept for deeper weekly analysis alongside the daily)
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
    console.log(`Bybit ${config.bybitDemo ? 'DEMO' : 'LIVE'} ready | ${config.leverage}x leverage on ${config.symbol}`);
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
