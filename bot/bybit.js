import { RestClientV5 } from 'bybit-api';
import { config } from './config.js';

const client = new RestClientV5({
  key:     config.bybitKey,
  secret:  config.bybitSecret,
  demoTrading: config.bybitDemo,
});

export const Bybit = {
  // Set leverage (call once on startup)
  async setLeverage(symbol, leverage) {
    try {
      await client.setLeverage({
        category: config.bybitCategory,
        symbol,
        buyLeverage:  String(leverage),
        sellLeverage: String(leverage),
      });
      console.log(`Leverage set: ${leverage}x on ${symbol}`);
    } catch (e) {
      // Ignore "leverage not modified" errors
      if (!e.message?.includes('110043')) console.warn('setLeverage:', e.message);
    }
  },

  // Get current mid price
  async getPrice(symbol) {
    const r = await client.getTickers({ category: config.bybitCategory, symbol });
    return parseFloat(r.result.list[0].lastPrice);
  },

  // Place market order with TP and SL attached
  async placeOrder({ side, symbol, qty, tpPrice, slPrice }) {
    const r = await client.submitOrder({
      category:          config.bybitCategory,
      symbol,
      side,                           // 'Buy' or 'Sell'
      orderType:         'Market',
      qty:               String(qty),
      takeProfit:        String(tpPrice.toFixed(2)),
      stopLoss:          String(slPrice.toFixed(2)),
      tpTriggerBy:       'LastPrice',
      slTriggerBy:       'LastPrice',
      tpOrderType:       'Limit',     // TP as limit = maker fee
      slOrderType:       'Market',    // SL as market = taker fee
      timeInForce:       'IOC',
      reduceOnly:        false,
      positionIdx:       0,           // one-way mode
    });

    if (r.retCode !== 0) throw new Error(`Bybit order failed: ${r.retMsg}`);
    return r.result.orderId;
  },

  // Get open position for symbol
  async getPosition(symbol) {
    const r = await client.getPositionInfo({
      category: config.bybitCategory,
      symbol,
    });
    const pos = r.result.list?.[0];
    if (!pos || parseFloat(pos.size) === 0) return null;
    return {
      side:       pos.side,                          // 'Buy' or 'Sell'
      size:       parseFloat(pos.size),
      entryPrice: parseFloat(pos.avgPrice),
      unrealPnl:  parseFloat(pos.unrealisedPnl),
      liqPrice:   parseFloat(pos.liqPrice),
    };
  },

  // Close entire position at market
  async closePosition({ symbol, side, qty }) {
    const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
    const r = await client.submitOrder({
      category:    config.bybitCategory,
      symbol,
      side:        closeSide,
      orderType:   'Market',
      qty:         String(qty),
      reduceOnly:  true,
      timeInForce: 'IOC',
      positionIdx: 0,
    });
    if (r.retCode !== 0) throw new Error(`Bybit close failed: ${r.retMsg}`);
    return r.result.orderId;
  },

  // Get last closed trade P&L from Bybit
  async getLastFill(symbol, since) {
    const r = await client.getClosedPnL({
      category: config.bybitCategory,
      symbol,
      limit: 1,
    });
    return r.result.list?.[0] ?? null;
  },
};
