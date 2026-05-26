import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';

const bot = new TelegramBot(config.telegramToken, { polling: false });
const chat = config.telegramChatId;

const fmt = (n, d = 2) => Number(n).toFixed(d);
const sign = n => n >= 0 ? '+' : '';

export const Telegram = {
  async send(msg) {
    try { await bot.sendMessage(chat, msg, { parse_mode: 'HTML' }); }
    catch (e) { console.error('Telegram error:', e.message); }
  },

  // Signal received — about to place order
  signalAlert({ side, symbol, entryPrice, qty, notional, tpPrice, slPrice,
                leverage, margin, entryFee, netIfTp, netIfSl }) {
    const emoji = side === 'Buy' ? '🟢 LONG' : '🔴 SHORT';
    const tpDist = side === 'Buy' ? config.tpPct : config.tpPct;
    const slDist = side === 'Buy' ? config.slPct : config.slPct;
    return `${emoji} SIGNAL — ${symbol}
━━━━━━━━━━━━━━━━━━━━━━
<b>Entry</b>:   Market @ ~$${fmt(entryPrice)}
<b>Size</b>:    ${fmt(qty, 4)} ETH  ($${fmt(notional, 0)} notional)
<b>TP</b>:      $${fmt(tpPrice)}  (${tpDist}%) → <b>+$${fmt(Math.abs(netIfTp))}</b>
<b>SL</b>:      $${fmt(slPrice)}  (${slDist}%) → <b>-$${fmt(Math.abs(netIfSl))}</b>
━━━━━━━━━━━━━━━━━━━━━━
<b>Leverage</b>: ${leverage}x (Bybit Demo)
<b>Margin</b>:   $${fmt(margin, 0)}
<b>Entry fee</b>: $${fmt(entryFee, 3)}  (${(config.takerFee * 100).toFixed(3)}% taker)
<b>TP fee</b>:    $${fmt(notional * config.tpPct / 100 * config.makerFee * (side === 'Buy' ? 1 + config.tpPct / 100 : 1 - config.tpPct / 100), 3)}  (${(config.makerFee * 100).toFixed(3)}% maker)
━━━━━━━━━━━━━━━━━━━━━━
<i>Placing order on Bybit Demo...</i>`;
  },

  // Order confirmed
  orderPlaced({ side, symbol, orderId }) {
    const emoji = side === 'Buy' ? '🟢' : '🔴';
    return `${emoji} <b>ORDER PLACED</b> — ${symbol}
Bybit Demo Order ID: <code>${orderId}</code>
Monitoring position...`;
  },

  // Trade closed
  tradeClosed({ side, symbol, entryPrice, exitPrice, qty, notional,
                grossPnl, entryFee, exitFee, netPnl, closeReason,
                openedAt, closedAt, totalNetPnl, totalTrades, totalWins }) {
    const emoji = netPnl >= 0 ? '✅' : '❌';
    const sideLabel = side === 'Buy' ? 'LONG' : 'SHORT';
    const held = Math.round((new Date(closedAt) - new Date(openedAt)) / 60000);
    const heldStr = held >= 60 ? `${Math.floor(held/60)}h ${held%60}m` : `${held}m`;
    const wr = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(0) : 0;

    return `${emoji} ${sideLabel} CLOSED — ${symbol}
━━━━━━━━━━━━━━━━━━━━━━
<b>Entry</b>:  $${fmt(entryPrice)}
<b>Exit</b>:   $${fmt(exitPrice)}  (${closeReason})
<b>Held</b>:   ${heldStr}
━━━━━━━━━━━━━━━━━━━━━━
<b>Gross P&L</b>:  ${sign(grossPnl)}$${fmt(Math.abs(grossPnl))}
<b>Entry fee</b>:  -$${fmt(entryFee, 3)}
<b>Exit fee</b>:   -$${fmt(exitFee, 3)}
<b>Net P&L</b>:    <b>${sign(netPnl)}$${fmt(Math.abs(netPnl))}</b>
━━━━━━━━━━━━━━━━━━━━━━
<b>All-time P&L</b>: ${sign(totalNetPnl)}$${fmt(Math.abs(totalNetPnl))}
<b>Record</b>: ${totalWins}W / ${totalTrades - totalWins}L  (${wr}% WR)`;
  },

  // Weekly report
  weeklyReport(s, accountBalance) {
    if (!s) return `📊 <b>WEEKLY REPORT</b>\nNo closed trades this week.`;
    const now = new Date();
    const weekStart = new Date(now - 7 * 86400000);
    return `📊 <b>WEEKLY REPORT — F40d C104 $3k</b>
━━━━━━━━━━━━━━━━━━━━━━
<b>Period</b>: ${weekStart.toLocaleDateString()} → ${now.toLocaleDateString()}
<b>Trades</b>: ${s.total}  (${s.wins}W / ${s.losses}L  |  ${s.winRate}% WR)
━━━━━━━━━━━━━━━━━━━━━━
<b>Net P&L</b>:    ${sign(s.netPnl)}$${s.netPnl}
<b>Total fees</b>: -$${s.totalFees}
<b>Max DD</b>:     -$${s.maxDD}
<b>Best trade</b>: +$${s.bestTrade}
<b>Worst trade</b>: -$${Math.abs(s.worstTrade)}
━━━━━━━━━━━━━━━━━━━━━━
<b>Account</b>: $${fmt(accountBalance)}`;
  },

  dailyDashboard({ date, openTrade, currentPrice, unrealisedPnl,
                   todayTrades, allStats, streakMult, peakEquity,
                   equity, ddPct, nextHourIn }) {
    const dow   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getUTCDay()];
    const dstr  = `${dow} ${date.toISOString().slice(0,10)}`;
    const mode  = config.bybitDemo ? 'DEMO — Bybit' : 'LIVE — Bybit';
    const sep   = '━━━━━━━━━━━━━━━━━━━━━━';

    // ── Open position block ───────────────────────────────────────────────────
    let posBlock = `📍 <b>OPEN POSITION</b>\nNone — flat`;
    if (openTrade && currentPrice) {
      const t       = openTrade;
      const side    = t.side === 'Buy' ? '🟢 LONG' : '🔴 SHORT';
      const movePct = ((currentPrice - t.entryPrice) / t.entryPrice * 100 * (t.side === 'Buy' ? 1 : -1));
      const heldMin = Math.round((Date.now() - new Date(t.openedAt)) / 60000);
      const heldStr = heldMin >= 60 ? `${Math.floor(heldMin/60)}h ${heldMin%60}m` : `${heldMin}m`;
      const distToTp = Math.abs((t.tpPrice - currentPrice) / currentPrice * 100).toFixed(1);
      const distToSl = Math.abs((t.slPrice - currentPrice) / currentPrice * 100).toFixed(1);
      posBlock =
`📍 <b>OPEN POSITION</b>
${side} ETHUSDT
  Entry:      $${fmt(t.entryPrice)}
  Now:        $${fmt(currentPrice)}  (${sign(movePct)}${fmt(movePct, 2)}%)
  Size:       ${fmt(t.qty, 3)} ETH  ($${fmt(t.notional, 0)} notional)
  TP:         $${fmt(t.tpPrice)}  (${distToTp}% away)
  SL:         $${fmt(t.slPrice)}  (${distToSl}% away)
  Unrealised: <b>${sign(unrealisedPnl)}$${fmt(Math.abs(unrealisedPnl))}</b>
  Open:       ${heldStr} ago`;
    }

    // ── Today's trades block ──────────────────────────────────────────────────
    const todayClosed = (todayTrades || []).filter(t => t.status === 'closed');
    const todayOpen   = (todayTrades || []).filter(t => t.status === 'open');
    let todayNet = todayClosed.reduce((s, t) => s + (t.netPnl || 0), 0);
    let todayBlock = `📅 <b>TODAY</b>  (no trades)`;
    if (todayClosed.length || todayOpen.length) {
      const lines = todayClosed.map(t => {
        const e = t.netPnl >= 0 ? '✅' : '❌';
        const s = t.side === 'Buy' ? 'LONG' : 'SHORT';
        return `  ${e} ${s}: ${sign(t.netPnl)}$${fmt(Math.abs(t.netPnl))} (${t.closeReason || '?'})`;
      });
      if (todayOpen.length) lines.push(`  🕐 ${todayOpen.length} position open`);
      todayBlock =
`📅 <b>TODAY</b>  (${todayClosed.length} closed)
${lines.join('\n')}
  Net today:  <b>${sign(todayNet)}$${fmt(Math.abs(todayNet))}</b>`;
    }

    // ── All-time stats block ──────────────────────────────────────────────────
    let statsBlock = `📈 <b>ALL-TIME</b>\nNo closed trades yet`;
    if (allStats) {
      const livePF = parseFloat(allStats.netPnl) >= 0 && allStats.total > 0
        ? (parseFloat(allStats.netPnl) > 0 ? '>' : '') + '1.0' : '<1.0';
      const gross_w = allStats.wins > 0 ? '+' : '';
      statsBlock =
`📈 <b>ALL-TIME</b>  (${allStats.total} trades)
  Win / Loss: ${allStats.wins}W / ${allStats.losses}L  (${allStats.winRate}% WR)
  Net P&amp;L:    <b>${sign(parseFloat(allStats.netPnl))}$${Math.abs(parseFloat(allStats.netPnl)).toFixed(2)}</b>
  Fees paid:  -$${allStats.totalFees}
  Best trade: +$${allStats.bestTrade}
  Worst:      -$${Math.abs(allStats.worstTrade)}
  Max DD:     -$${allStats.maxDD}`;
    }

    // ── Sizing state block ────────────────────────────────────────────────────
    const nextEff = fmt(3000 * 1.2 * 2.0 * streakMult, 0); // approx next trade size
    const sizingBlock =
`⚙️ <b>SIZING STATE</b>
  Streak mult:  ${fmt(streakMult, 2)}×
  Est. effCash: ~$${nextEff}  (base × vol × sig × streak)
  Account eq.:  ~$${fmt(equity, 0)}
  DD from peak: ${fmt(ddPct, 1)}%  (peak $${fmt(peakEquity, 0)})`;

    // ── Strategy health ───────────────────────────────────────────────────────
    const livePF = allStats
      ? (() => {
          const s = allStats;
          const wins = parseFloat(s.bestTrade) > 0 && s.wins > 0;
          // approximate PF from tracker stats
          return s.total > 0 ? fmt(Math.max(0,
            (s.wins * parseFloat(s.bestTrade || 0)) /
            Math.max(1, s.losses * Math.abs(parseFloat(s.worstTrade || 1)))
          ), 2) : 'n/a';
        })()
      : 'n/a';
    const onTrack = allStats && parseFloat(allStats.netPnl) > 0 ? '✅ Positive P&L' : '⏳ Building sample';
    const nextCheck = nextHourIn ? `${nextHourIn}m` : 'next hour close';
    const healthBlock =
`📊 <b>STRATEGY vs BACKTEST</b>
  Win Rate:   ${allStats?.winRate ?? '—'}%   (backtest: 32%)
  Mode:       ${mode}
  Status:     ${onTrack}
  Next signal check: ${nextCheck}`;

    return `📊 <b>F40d C104 — Daily Dashboard</b>
${dstr}
${sep}
${posBlock}
${sep}
${todayBlock}
${sep}
${statsBlock}
${sep}
${sizingBlock}
${sep}
${healthBlock}`;
  },

  async startupMsg(ip) {
    await this.send(`🤖 <b>F40d C104 Bot ONLINE</b>
━━━━━━━━━━━━━━━━━━━━━━
Strategy: ETHUSDT 1H — Hilbert Envelope
Exchange:  ${config.bybitDemo ? 'Bybit Demo' : 'Bybit Live'}
Leverage:  ${config.leverage}x  |  TP ${config.tpPct}% / SL ${config.slPct}%
Signal:    Native engine — checks every 1H bar close
━━━━━━━━━━━━━━━━━━━━━━
Port: ${config.port}  |  Waiting for first signal...`);
  },
};
