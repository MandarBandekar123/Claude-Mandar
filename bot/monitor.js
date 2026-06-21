import { Exchange }      from './exchange.js';
import { Tracker }       from './tracker.js';
import { Telegram }      from './telegram.js';
import { config }        from './config.js';
import { updateStreak }  from './signal-engine.js';

// Poll every 60s for position closes (TP/SL hit or flip signal)
export async function startMonitor() {
  console.log('Position monitor started (60s interval)');
  setInterval(checkPositions, 60_000);
}

async function checkPositions() {
  const open = Tracker.getOpen();
  if (!open.length) return;

  for (const trade of open) {
    try {
      const pos = await Exchange.getPosition(trade.symbol);

      // Position closed on Bybit (TP/SL hit)
      if (!pos) {
        await handleClose(trade);
      }
    } catch (e) {
      console.error(`Monitor error for trade ${trade.id}:`, e.message);
    }
  }
}

async function handleClose(trade) {
  // Get actual exit from Bybit closed P&L
  const fill = await Exchange.getLastFill(trade.symbol);
  const exitPrice  = fill ? parseFloat(fill.avgExitPrice) : 0;
  const closedPnl  = fill ? parseFloat(fill.closedPnl)    : 0;

  const side       = trade.side;
  const notional   = trade.notional;
  const exitFee    = notional * config.takerFee;           // conservative: assume market exit
  const grossPnl   = side === 'Buy'
    ? (exitPrice - trade.entryPrice) * trade.qty
    : (trade.entryPrice - exitPrice) * trade.qty;
  const netPnl     = grossPnl - trade.entryFee - exitFee;

  // Label by proximity to TP/SL price — works for both long and short.
  // (Old logic assumed long-only: for a short, TP is below entry and SL above,
  //  so the >= / <= comparisons mislabeled short SL hits as 'TP'.)
  const nearTp = Math.abs(exitPrice - trade.tpPrice) <= trade.tpPrice * 0.003;
  const nearSl = Math.abs(exitPrice - trade.slPrice) <= trade.slPrice * 0.003;
  const closeReason = nearTp ? 'TP ✅'
                    : nearSl ? 'SL 🛑'
                    : (netPnl >= 0 ? 'Exit +✅' : 'Exit -🛑');

  const closedAt = new Date().toISOString();
  Tracker.close({
    id: trade.id,
    exitPrice, exitFee,
    grossPnl, netPnl,
    closeReason, closedAt,
  });

  // Running totals
  const allStats = Tracker.stats();
  const totalNetPnl = parseFloat(allStats?.netPnl ?? 0);
  const totalTrades = allStats?.total ?? 1;
  const totalWins   = allStats?.wins  ?? 0;

  const msg = Telegram.tradeClosed({
    side, symbol: trade.symbol,
    entryPrice: trade.entryPrice, exitPrice,
    qty: trade.qty, notional,
    grossPnl, entryFee: trade.entryFee, exitFee, netPnl,
    closeReason,
    openedAt: trade.openedAt, closedAt,
    totalNetPnl, totalTrades, totalWins,
  });
  await Telegram.send(msg);
  console.log(`Trade ${trade.id} closed: ${closeReason} | Net P&L: $${netPnl.toFixed(2)}`);
  updateStreak(netPnl);
}
