import 'dotenv/config';

export const config = {
  // Telegram
  telegramToken:  process.env.TELEGRAM_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,

  // Bybit
  bybitKey:       process.env.BYBIT_API_KEY,
  bybitSecret:    process.env.BYBIT_API_SECRET,
  bybitDemo:      process.env.BYBIT_DEMO !== 'false', // default: demo trading (api-demo.bybit.com)

  // Strategy
  symbol:         'ETHUSDT',
  baseCash:       15000,       // base notional ($600 margin at 25x)
  leverage:       25,          // 25x leverage
  slPct:          2.0,
  tpPct:          5.0,
  bybitCategory:  'linear',

  // Bybit fees (demo mirrors live)
  takerFee:       0.0006,
  makerFee:       0.0001,

  // Server
  port:           process.env.PORT || 3000,
  webhookSecret:  process.env.WEBHOOK_SECRET || '',
  deploySecret:   process.env.DEPLOY_SECRET || '',
};
