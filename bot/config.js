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
  baseCash:       3000,        // fixed $3k base position value
  leverage:       5,           // set on Bybit account
  slPct:          2.0,         // matches Pine strategy
  tpPct:          5.0,         // matches Pine strategy
  bybitCategory:  'linear',    // USDT perpetuals

  // Bybit fees (demo mirrors live)
  takerFee:       0.0006,      // 0.06% market orders
  makerFee:       0.0001,      // 0.01% limit orders (TP)

  // Server
  port:           process.env.PORT || 3000,
  webhookSecret:  process.env.WEBHOOK_SECRET || '',
  deploySecret:   process.env.DEPLOY_SECRET || '',
};
