#!/usr/bin/env node
/**
 * Backtest runner — calls trader-dev REST API directly.
 * Works from local Mac (whitelisted). Blocked from cloud container.
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const reqFile = process.argv[2];
if (!reqFile) { console.error('Usage: run-backtest.js <request.json>'); process.exit(1); }

const req = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
if (req.status !== 'pending') {
  console.log(`Skipping — status: ${req.status}`);
  process.exit(0);
}

const API_KEY = process.env.TRADER_DEV_API_KEY;
if (!API_KEY) { console.error('TRADER_DEV_API_KEY not set'); process.exit(1); }

const repoRoot   = path.resolve(__dirname, '..');
const pineScript = fs.readFileSync(path.join(repoRoot, req.pineFile), 'utf8');

console.log(`Running: ${req.id}`);
console.log(`  ${req.symbol} ${req.timeframe} | ${req.fromDate} → ${req.toDate} | $${req.initialCapital}`);

function post(hostname, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname,
      path: pathname,
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${API_KEY}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const r = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        console.log(`  HTTP ${res.statusCode} from ${hostname}${pathname}`);
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

async function run() {
  const payload = {
    symbol:         req.symbol,
    timeframe:      String(req.timeframe),
    from:           req.fromDate,
    to:             req.toDate,
    initialCapital: req.initialCapital || 10000,
    pine:           pineScript,
  };

  // Try known trader-dev endpoints
  const endpoints = [
    { host: 'mcp-api.trader.dev', path: '/backtest/quick'  },
    { host: 'mcp-api.trader.dev', path: '/backtest/run'    },
    { host: 'mcp-api.trader.dev', path: '/backtest'        },
    { host: 'api.trader.dev',     path: '/backtest/quick'  },
  ];

  let res = null;
  for (const ep of endpoints) {
    console.log(`  Trying ${ep.host}${ep.path} ...`);
    try {
      res = await post(ep.host, ep.path, payload);
      if (res.status === 200 || res.status === 201) break;
      console.log(`  → ${res.status}: ${JSON.stringify(res.body).slice(0, 120)}`);
    } catch (err) {
      console.log(`  → Error: ${err.message}`);
    }
  }

  if (!res || (res.status !== 200 && res.status !== 201)) {
    // Save raw responses for debugging and mark error
    req.status   = 'error';
    req.error    = `All endpoints failed. Last status: ${res?.status}`;
    req.debugRes = res?.body;
    fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
    console.error('All endpoints failed — see request JSON for details.');
    process.exit(1);
  }

  const result = res.body;
  const kpis   = result.result?.kpis ?? result.kpis ?? {};

  console.log(`\n  ✓ Result ID: ${result.resultId ?? result.id ?? 'unknown'}`);
  console.log(`    Net P&L:  ${kpis.netProfitPct ?? '?'}%`);
  console.log(`    PF:       ${kpis.profitFactor ?? '?'}`);
  console.log(`    Max DD:   ${kpis.maxDrawdownPct ?? '?'}%`);
  console.log(`    WR:       ${kpis.winRate ?? '?'}%`);
  console.log(`    Trades:   ${kpis.numTrades ?? '?'}`);

  // Save result
  const outFile = path.join(repoRoot, 'backtest_results', `${req.id}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ request: req, result, savedAt: new Date().toISOString() }, null, 2));
  console.log(`    Saved:    backtest_results/${req.id}.json`);

  // Mark done
  req.status      = 'done';
  req.resultFile  = `backtest_results/${req.id}.json`;
  req.resultId    = result.resultId ?? result.id;
  req.completedAt = new Date().toISOString();
  fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
}

run().catch(err => {
  console.error('Fatal:', err.message);
  req.status = 'error';
  req.error  = err.message;
  fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
  process.exit(1);
});
