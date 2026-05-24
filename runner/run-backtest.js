#!/usr/bin/env node
/**
 * Backtest runner — reads a request JSON, calls trader-dev API, saves result.
 * Runs on the self-hosted GitHub Actions runner (local Mac).
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

const reqFile = process.argv[2];
if (!reqFile) { console.error('Usage: run-backtest.js <request.json>'); process.exit(1); }

const req = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
if (req.status !== 'pending') { console.log(`Skipping ${reqFile} — status: ${req.status}`); process.exit(0); }

const API_KEY = process.env.TRADER_DEV_API_KEY;
if (!API_KEY) { console.error('TRADER_DEV_API_KEY env var not set'); process.exit(1); }

console.log(`Running backtest: ${req.id}`);
console.log(`  Symbol: ${req.symbol} ${req.timeframe}`);
console.log(`  Period: ${req.fromDate} → ${req.toDate}`);

// Read Pine source if path provided
let pineScript = req.pineScript || '';
if (req.pineFile) {
  const pinePath = path.resolve(path.dirname(reqFile), '..', req.pineFile);
  pineScript = fs.readFileSync(pinePath, 'utf8');
  console.log(`  Pine: ${req.pineFile} (${pineScript.length} chars)`);
}

const body = JSON.stringify({
  symbol:         req.symbol,
  timeframe:      String(req.timeframe),
  from:           req.fromDate,
  to:             req.toDate,
  initialCapital: req.initialCapital || 10000,
  pine:           pineScript,
});

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'mcp-api.trader.dev',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body || ''),
      },
    };
    const r = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function run() {
  // Submit backtest
  const submit = await apiCall('POST', '/backtest/quick', body);
  if (submit.status !== 200 && submit.status !== 201) {
    console.error('Submit failed:', submit.status, JSON.stringify(submit.body));
    req.status = 'error';
    req.error  = submit.body;
    fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
    process.exit(1);
  }

  const result = submit.body;
  console.log(`  Result ID: ${result.resultId || result.id}`);
  console.log(`  Net P&L:   ${result.result?.kpis?.netProfitPct ?? result.kpis?.netProfitPct ?? '?'}%`);
  console.log(`  PF:        ${result.result?.kpis?.profitFactor ?? result.kpis?.profitFactor ?? '?'}`);
  console.log(`  Max DD:    ${result.result?.kpis?.maxDrawdownPct ?? result.kpis?.maxDrawdownPct ?? '?'}%`);
  console.log(`  WR:        ${result.result?.kpis?.winRate ?? result.kpis?.winRate ?? '?'}%`);
  console.log(`  Trades:    ${result.result?.kpis?.numTrades ?? result.kpis?.numTrades ?? '?'}`);

  // Save result JSON
  const outDir  = path.resolve(path.dirname(reqFile), '..', 'backtest_results');
  const outFile = path.join(outDir, `${req.id}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`  Saved: ${outFile}`);

  // Mark request as done
  req.status     = 'done';
  req.resultFile = `backtest_results/${req.id}.json`;
  req.resultId   = result.resultId || result.id;
  req.completedAt = new Date().toISOString();
  fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
}

run().catch(err => {
  console.error('Runner error:', err);
  req.status = 'error';
  req.error  = err.message;
  fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
  process.exit(1);
});
