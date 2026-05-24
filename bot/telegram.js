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

  async startupMsg(ip) {
    await this.send(`🤖 <b>F40d C104 Bot ONLINE</b>
━━━━━━━━━━━━━━━━━━━━━━
Strategy: Fixed $3k Base — ETHUSDT 1H
Exchange:  Bybit Demo (testnet)
Leverage:  ${config.leverage}x
TP / SL:   ${config.tpPct}% / ${config.slPct}%
━━━━━━━━━━━━━━━━━━━━━━
Webhook:   http://${ip}:${config.port}/webhook
Waiting for trader-dev signals...`);
  },
};
