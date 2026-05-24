import fs   from 'fs';
import path  from 'path';
import { Client }           from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const reqFile = process.argv[2];
if (!reqFile) { console.error('Usage: run-backtest.js <request.json>'); process.exit(1); }

const req = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
if (req.status !== 'pending') { console.log(`Skipping — status: ${req.status}`); process.exit(0); }

const API_KEY  = process.env.TRADER_DEV_API_KEY;
if (!API_KEY)  { console.error('TRADER_DEV_API_KEY not set'); process.exit(1); }

const repoRoot   = path.resolve(path.dirname(reqFile), '..');
const pineScript = fs.readFileSync(path.join(repoRoot, req.pineFile), 'utf8');

console.log(`Running: ${req.id}`);
console.log(`  ${req.symbol} ${req.timeframe} | ${req.fromDate} → ${req.toDate} | $${req.initialCapital}`);

// Connect to trader-dev via MCP SSE
const transport = new SSEClientTransport(
  new URL('https://mcp.trader.dev/sse'),
  { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } }
);

const client = new Client({ name: 'backtest-runner', version: '1.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);
  console.log('  Connected to trader-dev MCP');
} catch (err) {
  console.error('  MCP connect failed:', err.message);
  req.status = 'error'; req.error = 'MCP connect: ' + err.message;
  fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
  process.exit(1);
}

let raw;
try {
  raw = await client.callTool({
    name: 'quick_backtest',
    arguments: {
      symbol:         req.symbol,
      timeframe:      String(req.timeframe),
      fromDate:       req.fromDate,
      toDate:         req.toDate,
      initialCapital: req.initialCapital,
      pineSource:     pineScript,
    },
  });
} catch (err) {
  console.error('  quick_backtest failed:', err.message);
  req.status = 'error'; req.error = 'quick_backtest: ' + err.message;
  fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
  await client.close();
  process.exit(1);
}

await client.close();

// Parse result — MCP returns content array
const text   = raw?.content?.[0]?.text ?? JSON.stringify(raw);
let result;
try   { result = JSON.parse(text); }
catch { result = { raw: text }; }

const kpis = result?.result?.kpis ?? result?.kpis ?? {};
console.log(`\n  ✓ Result ID:  ${result.resultId ?? result.id ?? 'unknown'}`);
console.log(`    Net P&L:   ${kpis.netProfitPct ?? '?'}%`);
console.log(`    PF:        ${kpis.profitFactor ?? '?'}`);
console.log(`    Max DD:    ${kpis.maxDrawdownPct ?? '?'}%`);
console.log(`    WR:        ${kpis.winRate ?? '?'}%`);
console.log(`    Trades:    ${kpis.numTrades ?? '?'}`);

// Save result
const outFile = path.join(repoRoot, 'backtest_results', `${req.id}.json`);
fs.writeFileSync(outFile, JSON.stringify({ request: req, result, savedAt: new Date().toISOString() }, null, 2));
console.log(`    Saved:     backtest_results/${req.id}.json`);

// Mark done
req.status = 'done'; req.resultFile = `backtest_results/${req.id}.json`;
req.resultId = result.resultId ?? result.id; req.completedAt = new Date().toISOString();
fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
