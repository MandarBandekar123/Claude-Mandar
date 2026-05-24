import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'trades.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    side        TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    entryPrice  REAL,
    exitPrice   REAL,
    qty         REAL,
    notional    REAL,
    tpPrice     REAL,
    slPrice     REAL,
    leverage    INTEGER,
    margin      REAL,
    entryFee    REAL,
    exitFee     REAL,
    grossPnl    REAL,
    netPnl      REAL,
    closeReason TEXT,
    bybitOrderId TEXT,
    status      TEXT DEFAULT 'open',
    openedAt    TEXT,
    closedAt    TEXT,
    signalRaw   TEXT
  );
`);

const ins = db.prepare(`
  INSERT INTO trades (side,symbol,entryPrice,qty,notional,tpPrice,slPrice,leverage,margin,entryFee,bybitOrderId,status,openedAt,signalRaw)
  VALUES (@side,@symbol,@entryPrice,@qty,@notional,@tpPrice,@slPrice,@leverage,@margin,@entryFee,@bybitOrderId,'open',@openedAt,@signalRaw)
`);

const close = db.prepare(`
  UPDATE trades SET exitPrice=@exitPrice,exitFee=@exitFee,grossPnl=@grossPnl,
    netPnl=@netPnl,closeReason=@closeReason,status='closed',closedAt=@closedAt
  WHERE id=@id
`);

export const Tracker = {
  open(t)  { return ins.run(t).lastInsertRowid; },
  close(t) { close.run(t); },

  getOpen() {
    return db.prepare(`SELECT * FROM trades WHERE status='open' ORDER BY openedAt DESC`).all();
  },

  getById(id) {
    return db.prepare(`SELECT * FROM trades WHERE id=?`).get(id);
  },

  // Stats for reporting
  stats(since) {
    const rows = since
      ? db.prepare(`SELECT * FROM trades WHERE status='closed' AND closedAt >= ?`).all(since)
      : db.prepare(`SELECT * FROM trades WHERE status='closed'`).all();

    if (!rows.length) return null;
    const wins   = rows.filter(r => r.netPnl > 0);
    const losses = rows.filter(r => r.netPnl <= 0);
    const netPnl = rows.reduce((s, r) => s + r.netPnl, 0);
    const fees   = rows.reduce((s, r) => s + r.entryFee + r.exitFee, 0);
    const pnls   = rows.map(r => r.netPnl);
    let peak = 0, dd = 0, cur = 0;
    for (const p of pnls) { cur += p; if (cur > peak) peak = cur; dd = Math.min(dd, cur - peak); }

    return {
      total: rows.length, wins: wins.length, losses: losses.length,
      winRate: (wins.length / rows.length * 100).toFixed(1),
      netPnl: netPnl.toFixed(2),
      totalFees: fees.toFixed(2),
      maxDD: Math.abs(dd).toFixed(2),
      bestTrade: Math.max(...pnls).toFixed(2),
      worstTrade: Math.min(...pnls).toFixed(2),
    };
  },
};
