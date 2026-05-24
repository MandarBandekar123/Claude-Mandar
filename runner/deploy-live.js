import fs   from 'fs';
import path  from 'path';
import { Client }           from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const reqFile = process.argv[2];
if (!reqFile) { console.error('Usage: deploy-live.js <deploy-request.json>'); process.exit(1); }

const req = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
if (req.status !== 'pending') { console.log(`Skipping — status: ${req.status}`); process.exit(0); }

const API_KEY = process.env.TRADER_DEV_API_KEY;
if (!API_KEY) { console.error('TRADER_DEV_API_KEY not set'); process.exit(1); }

const repoRoot   = path.resolve(path.dirname(reqFile), '..');
const pineScript = fs.readFileSync(path.join(repoRoot, req.pineFile), 'utf8');
const resultsDir = path.join(repoRoot, 'deploy-results');
if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir);

const fail = (msg, extra = {}) => {
  console.error(' ', msg);
  req.status = 'error'; req.error = msg; Object.assign(req, extra);
  fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
  process.exit(1);
};

const parse = raw => {
  const text = raw?.content?.[0]?.text ?? JSON.stringify(raw);
  try { return JSON.parse(text); } catch { return { raw: text }; }
};

console.log(`Deploying: ${req.id}`);
console.log(`  ${req.name} | ${req.symbol} ${req.timeframe}`);

const transport = new SSEClientTransport(
  new URL('https://mcp.trader.dev/sse'),
  { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } }
);
const client = new Client({ name: 'deploy-runner', version: '1.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);
  console.log('  Connected to trader-dev MCP');
} catch (err) { fail('MCP connect: ' + err.message); }

// ── Step 1: verify auth ──────────────────────────────────────────────────────
let whoami;
try {
  const raw = await client.callTool({ name: 'whoami', arguments: {} });
  whoami = parse(raw);
  console.log(`  Authenticated as: ${whoami.email ?? whoami.userId ?? JSON.stringify(whoami)}`);
} catch (err) { fail('whoami: ' + err.message); }

// ── Step 2: create or update strategy ───────────────────────────────────────
let strategy;
const existingId = req.strategyId;
try {
  if (existingId) {
    console.log(`  Updating existing strategy: ${existingId}`);
    const raw = await client.callTool({
      name: 'update_strategy',
      arguments: { id: existingId, pineSource: pineScript, name: req.name },
    });
    strategy = parse(raw);
    console.log(`  Strategy updated: ${existingId}`);
  } else {
    const raw = await client.callTool({
      name: 'create_strategy',
      arguments: {
        name:           req.name,
        symbol:         req.symbol,
        timeframe:      req.timeframe,
        pineSource:     pineScript,
        initialCapital: req.initialCapital,
        warmupBars:     req.warmupBars ?? 300,
      },
    });
    strategy = parse(raw);
    console.log(`  Strategy created: ${strategy.id ?? strategy.strategyId}`);
  }
} catch (err) { fail((existingId ? 'update_strategy' : 'create_strategy') + ': ' + err.message); }

const strategyId = existingId ?? strategy.id ?? strategy.strategyId;
if (!strategyId) fail('No strategyId returned', { raw: strategy });

// ── Step 3: run validation backtest (last 90 days — quick sanity check) ──────
let btResult;
try {
  const raw = await client.callTool({
    name: 'run_backtest',
    arguments: { strategyId, from: req.validateFrom ?? '2025-01-01', to: req.validateTo ?? '2026-05-13' },
  });
  const job = parse(raw);
  const jobId = job.jobId ?? job.id;
  console.log(`  Backtest queued: ${jobId} — waiting for result...`);

  const res = await client.callTool({
    name: 'get_backtest_result',
    arguments: { jobId, waitForCompletion: true },
  });
  btResult = parse(res);
} catch (err) { fail('validation backtest: ' + err.message); }

const r = btResult?.result ?? btResult;
const pf  = r?.profitFactor ?? 0;
const dd  = r?.maxDrawdownPct ?? 999;
const trades = r?.totalTrades ?? 0;
console.log(`  Validation: PF=${pf?.toFixed ? pf.toFixed(2) : pf}  MaxDD=${dd?.toFixed ? dd.toFixed(2) : dd}%  Trades=${trades}`);

if (req.requirePF && pf < req.requirePF) fail(`Validation failed: PF ${pf} < required ${req.requirePF}`);
if (req.requireMaxDD && dd > req.requireMaxDD) fail(`Validation failed: MaxDD ${dd}% > limit ${req.requireMaxDD}%`);

// ── Step 4: promote to live ──────────────────────────────────────────────────
let deployed;
try {
  const raw = await client.callTool({
    name: 'promote_strategy',
    arguments: { id: strategyId },
  });
  deployed = parse(raw);
  console.log(`  Promoted to LIVE ✓  strategyId: ${strategyId}`);
} catch (err) { fail('promote_strategy: ' + err.message); }

await client.close();

// ── Save result ──────────────────────────────────────────────────────────────
const outFile = path.join(resultsDir, `${req.id}.json`);
fs.writeFileSync(outFile, JSON.stringify({
  request: req,
  strategyId,
  whoami,
  validationBacktest: { profitFactor: pf, maxDrawdownPct: dd, totalTrades: trades },
  deployedAt: new Date().toISOString(),
  deployed,
}, null, 2));

req.status = 'deployed';
req.strategyId   = strategyId;
req.deployedAt   = new Date().toISOString();
req.resultFile   = `deploy-results/${req.id}.json`;
fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));

console.log(`\n  ✓ LIVE on trader-dev`);
console.log(`    Strategy ID : ${strategyId}`);
console.log(`    View at     : https://mcp-api.trader.dev/strategies/${strategyId}`);
console.log(`    Result      : deploy-results/${req.id}.json`);
