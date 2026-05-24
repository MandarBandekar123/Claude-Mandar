import 'dotenv/config';
import express       from 'express';
import cron          from 'node-cron';
import { config }    from './config.js';
import { Bybit }     from './bybit.js';
import { Tracker }   from './tracker.js';
import { Telegram }  from './telegram.js';
import { startMonitor } from './monitor.js';

const app = express();
app.use(express.json());

// ── Parse trader-dev signal payload ─────────────────────────────────────────
function parseSignal(body) {
  // trader-dev sends JSON with signal type and price
  const raw    = typeof body === 'string' ? JSON.parse(body) : body;
  const type   = (raw.signal ?? raw.type ?? raw.action ?? '').toLowerCase();
  const price  = parseFloat(raw.price ?? raw.close ?? 0);
  const symbol = raw.symbol ?? config.symbol;

  let side = null;
  if (type.includes('long')  && !type.includes('exit')) side = 'Buy';
  if (type.includes('short') && !type.includes('exit')) side = 'Sell';
  if (type.includes('exit_long'))                        side = 'exit_long';
  if (type.includes('exit_short'))                       side = 'exit_short';
  if (type === 'buy')                                    side = 'Buy';
  if (type === 'sell')                                   side = 'Sell';

  return { side, price, symbol, raw };
}

// ── Webhook endpoint ─────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ACK immediately so trader-dev doesn't retry
  console.log('Webhook received:', JSON.stringify(req.body));

  let signal;
  try { signal = parseSignal(req.body); }
  catch (e) { console.error('Parse error:', e.message); return; }

  const { side, symbol } = signal;

  // ── Exit signal: close open position ──────────────────────────────────────
  if (side === 'exit_long' || side === 'exit_short') {
    const open = Tracker.getOpen();
    if (!open.length) { console.log('Exit signal but no open trade'); return; }
    const trade = open[0];
    try {
      await Bybit.closePosition({ symbol: trade.symbol, side: trade.side, qty: trade.qty });
      console.log(`Closed position for trade ${trade.id}`);
    } catch (e) { console.error('Close error:', e.message); }
    return;
  }

  if (!side) { console.log('Unrecognised signal type:', signal); return; }

  // ── Close any opposite open position first ───────────────────────────────
  const openTrades = Tracker.getOpen();
  for (const t of openTrades) {
    if ((t.side === 'Buy' && side === 'Sell') || (t.side === 'Sell' && side === 'Buy')) {
      try { await Bybit.closePosition({ symbol: t.symbol, side: t.side, qty: t.qty }); }
      catch (e) { console.error('Flip-close error:', e.message); }
    }
  }

  // ── Get live price if not in signal ─────────────────────────────────────
  let entryPrice = signal.price;
  if (!entryPrice) {
    try { entryPrice = await Bybit.getPrice(symbol); }
    catch (e) { console.error('Price fetch failed:', e.message); return; }
  }

  // ── Calculate sizing (fixed $3k base) ────────────────────────────────────
  const notional = config.baseCash;
  const qty      = parseFloat((notional / entryPrice).toFixed(3));
  const margin   = notional / config.leverage;
  const tpPrice  = side === 'Buy'
    ? entryPrice * (1 + config.tpPct / 100)
    : entryPrice * (1 - config.tpPct / 100);
  const slPrice  = side === 'Buy'
    ? entryPrice * (1 - config.slPct / 100)
    : entryPrice * (1 + config.slPct / 100);
  const entryFee = notional * config.takerFee;
  const exitFeeIfTp = notional * (1 + (side === 'Buy' ? config.tpPct : -config.tpPct) / 100) * config.makerFee;
  const exitFeeIfSl = notional * (1 - (side === 'Buy' ? config.slPct : -config.slPct) / 100) * config.takerFee;
  const grossIfTp  = notional * config.tpPct / 100;
  const grossIfSl  = notional * config.slPct / 100;
  const netIfTp    = grossIfTp  - entryFee - exitFeeIfTp;
  const netIfSl    = -(grossIfSl + entryFee + exitFeeIfSl);

  // ── Send Telegram alert ──────────────────────────────────────────────────
  await Telegram.send(Telegram.signalAlert({
    side, symbol, entryPrice, qty, notional,
    tpPrice, slPrice, leverage: config.leverage,
    margin, entryFee, netIfTp, netIfSl,
  }));

  // ── Place Bybit order ────────────────────────────────────────────────────
  let orderId;
  try {
    orderId = await Bybit.placeOrder({ side, symbol, qty, tpPrice, slPrice });
    await Telegram.send(Telegram.orderPlaced({ side, symbol, orderId }));
  } catch (e) {
    console.error('Bybit order error:', e.message);
    await Telegram.send(`⚠️ Bybit order FAILED: ${e.message}`);
    return;
  }

  // ── Log trade ────────────────────────────────────────────────────────────
  Tracker.open({
    side, symbol, entryPrice, qty, notional,
    tpPrice, slPrice,
    leverage:    config.leverage,
    margin,
    entryFee,
    bybitOrderId: orderId,
    openedAt:    new Date().toISOString(),
    signalRaw:   JSON.stringify(signal.raw),
  });

  console.log(`Trade opened: ${side} ${qty} ${symbol} @ $${entryPrice} | TP $${tpPrice.toFixed(2)} | SL $${slPrice.toFixed(2)}`);
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const open = Tracker.getOpen();
  res.json({ status: 'ok', openTrades: open.length, open });
});

// ── Weekly report: every Monday 08:00 UTC ────────────────────────────────────
cron.schedule('0 8 * * 1', async () => {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const stats  = Tracker.stats(since);
  const allStats = Tracker.stats();
  const totalPnl = parseFloat(allStats?.netPnl ?? 0);
  const balance  = 10000 + totalPnl;
  await Telegram.send(Telegram.weeklyReport(stats, balance));
});

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  try {
    await Bybit.setLeverage(config.symbol, config.leverage);
    console.log(`Bybit ${config.bybitTestnet ? 'TESTNET' : 'LIVE'} ready | ${config.leverage}x leverage on ${config.symbol}`);
  } catch (e) { console.error('Bybit init error:', e.message); }

  startMonitor();

  app.listen(config.port, async () => {
    console.log(`Bot server running on port ${config.port}`);
    try {
      const ip = (await import('os')).default.hostname();
      await Telegram.startupMsg(ip);
    } catch (e) { /* ignore */ }
  });
}

start();
