import 'dotenv/config';

export const config = {
  // Telegram
  telegramToken:  process.env.TELEGRAM_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,

  // Exchange selector: 'bybit' (default) or 'toobit'
  exchange:       (process.env.EXCHANGE || 'bybit').toLowerCase(),

  // Bybit
  bybitKey:       process.env.BYBIT_API_KEY,
  bybitSecret:    process.env.BYBIT_API_SECRET,
  bybitDemo:      process.env.BYBIT_DEMO !== 'false',
  bybitCategory:  'linear',

  // Toobit
  toobitKey:      process.env.TOOBIT_API_KEY,
  toobitSecret:   process.env.TOOBIT_API_SECRET,

  // Strategy
  symbol:         process.env.SYMBOL || 'ETHUSDT',
  baseCash:       parseFloat(process.env.BASE_CASH) || 3000,
  startEquity:    parseFloat(process.env.START_EQUITY) || 10000, // account starting capital
  leverage:       parseInt(process.env.LEVERAGE)    || 25,
  slPct:          2.0,
  tpPct:          5.0,

  // Fees
  takerFee:       0.0006,
  makerFee:       0.0001,

  // Server
  port:           process.env.PORT || 3000,
  webhookSecret:  process.env.WEBHOOK_SECRET || '',
  deploySecret:   process.env.DEPLOY_SECRET || '',
};
