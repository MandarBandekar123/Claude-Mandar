#!/usr/bin/env node
/**
 * Backtest runner — uses `claude --print` with trader-dev MCP.
 * Runs on the self-hosted GitHub Actions runner (local Mac).
 * trader-dev MCP must already be configured in Claude Code.
 */

const fs            = require('fs');
const path          = require('path');
const { execSync }  = require('child_process');
const os            = require('os');

const reqFile = process.argv[2];
if (!reqFile) { console.error('Usage: run-backtest.js <request.json>'); process.exit(1); }

const req = JSON.parse(fs.readFileSync(reqFile, 'utf8'));
if (req.status !== 'pending') {
  console.log(`Skipping ${reqFile} — status: ${req.status}`);
  process.exit(0);
}

// Read Pine source
const repoRoot   = path.resolve(__dirname, '..');
const pinePath   = path.join(repoRoot, req.pineFile);
const pineScript = fs.readFileSync(pinePath, 'utf8');

console.log(`\nRunning: ${req.id}`);
console.log(`  Symbol:  ${req.symbol} ${req.timeframe}`);
console.log(`  Period:  ${req.fromDate} → ${req.toDate}`);
console.log(`  Capital: $${req.initialCapital}`);
console.log(`  Pine:    ${req.pineFile} (${pineScript.length} chars)`);

// Write prompt to temp file (avoids shell escaping issues)
const prompt = `
Use the trader-dev MCP quick_backtest tool to run a backtest with exactly these parameters:
- symbol: ${req.symbol}
- timeframe: ${req.timeframe}
- from_date: ${req.fromDate}
- to_date: ${req.toDate}
- initial_capital: ${req.initialCapital}
- pine_script: the Pine Script below

Pine Script:
\`\`\`pine
${pineScript}
\`\`\`

After the backtest completes, output ONLY a single valid JSON object (no markdown, no explanation) with these exact fields:
{
  "resultId": "...",
  "netProfitPct": 0.0,
  "profitFactor": 0.0,
  "maxDrawdownPct": 0.0,
  "winRate": 0.0,
  "numTrades": 0,
  "numLongs": 0,
  "numShorts": 0,
  "sharpe": 0.0
}
`.trim();

const promptFile = path.join(os.tmpdir(), `bt-prompt-${req.id}.txt`);
fs.writeFileSync(promptFile, prompt);

let raw = '';
try {
  raw = execSync(`claude --print < "${promptFile}"`, {
    encoding: 'utf8',
    timeout: 300000,  // 5 min timeout
    maxBuffer: 10 * 1024 * 1024,
  });
} catch (err) {
  console.error('claude --print failed:', err.message);
  req.status = 'error';
  req.error  = err.message;
  fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
  fs.unlinkSync(promptFile);
  process.exit(1);
}

fs.unlinkSync(promptFile);

// Extract JSON from output
let result;
try {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in output');
  result = JSON.parse(jsonMatch[0]);
} catch (err) {
  console.error('Failed to parse result JSON:', err.message);
  console.error('Raw output:', raw.slice(0, 500));
  req.status = 'error';
  req.error  = 'JSON parse failed: ' + err.message;
  req.rawOutput = raw.slice(0, 1000);
  fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));
  process.exit(1);
}

console.log(`\n  Result ID:  ${result.resultId}`);
console.log(`  Net P&L:    ${result.netProfitPct}%`);
console.log(`  PF:         ${result.profitFactor}`);
console.log(`  Max DD:     ${result.maxDrawdownPct}%`);
console.log(`  Win Rate:   ${result.winRate}%`);
console.log(`  Trades:     ${result.numTrades} (${result.numLongs}L / ${result.numShorts}S)`);

// Save full result
const outDir  = path.join(repoRoot, 'backtest_results');
const outFile = path.join(outDir, `${req.id}.json`);
const full    = { request: req, result, savedAt: new Date().toISOString() };
fs.writeFileSync(outFile, JSON.stringify(full, null, 2));
console.log(`  Saved:      backtest_results/${req.id}.json`);

// Mark request done
req.status      = 'done';
req.resultFile  = `backtest_results/${req.id}.json`;
req.resultId    = result.resultId;
req.completedAt = new Date().toISOString();
fs.writeFileSync(reqFile, JSON.stringify(req, null, 2));

console.log(`\n  ✓ Done: ${req.id}`);
