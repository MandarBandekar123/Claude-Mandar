import ccxt from 'ccxt';
import { config } from './config.js';

const CCXT_SYMBOL = 'ETH/USDT:USDT';

let _ex = null;
function ex() {
  if (!_ex) {
    _ex = new ccxt.toobit({
      apiKey: config.toobitKey,
      secret: config.toobitSecret,
      options: { defaultType: 'swap' },
    });
  }
  return _ex;
}

export const Toobit = {
  async setLeverage(symbol, leverage) {
    try {
      await ex().setLeverage(leverage, CCXT_SYMBOL);
      console.log(`Toobit leverage set: ${leverage}x on ${symbol}`);
    } catch (e) {
      if (!e.message?.includes('not modified')) console.warn('setLeverage:', e.message);
    }
  },

  async getPrice(symbol) {
    const ticker = await ex().fetchTicker(CCXT_SYMBOL);
    return ticker.last;
  },

  async placeOrder({ side, symbol, qty, tpPrice, slPrice }) {
    const orderSide = side === 'Buy' ? 'buy' : 'sell';
    const r = await ex().createOrder(CCXT_SYMBOL, 'market', orderSide, qty, undefined, {
      stopLossPrice:   slPrice,
      takeProfitPrice: tpPrice,
    });
    if (!r?.id) throw new Error('Toobit order: no order ID returned');
    return r.id;
  },

  async getPosition(symbol) {
    const positions = await ex().fetchPositions([CCXT_SYMBOL]);
    const pos = positions.find(p => Math.abs(p.contracts ?? 0) > 0);
    if (!pos) return null;
    return {
      side:       pos.side === 'long' ? 'Buy' : 'Sell',
      size:       Math.abs(pos.contracts),
      entryPrice: pos.entryPrice,
      unrealPnl:  pos.unrealizedPnl,
      liqPrice:   pos.liquidationPrice,
    };
  },

  async closePosition({ symbol, side, qty }) {
    const closeSide = side === 'Buy' ? 'sell' : 'buy';
    await ex().createOrder(CCXT_SYMBOL, 'market', closeSide, qty, undefined, {
      reduceOnly: true,
    });
  },

  async getLastFill(symbol, since) {
    try {
      const trades = await ex().fetchMyTrades(CCXT_SYMBOL, undefined, 5);
      if (!trades?.length) return null;
      const t = trades[trades.length - 1];
      return {
        avgExitPrice: String(t.price),
        closedPnl:   String(t.info?.realizedPnl ?? 0),
      };
    } catch {
      return null;
    }
  },
};
