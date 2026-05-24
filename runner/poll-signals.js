// poll-signals.js — runs on Mac, polls trader-dev for new signals
// and forwards them to the EC2 bot webhook.
//
// Usage:
//   BOT_WEBHOOK=http://<EC2-IP>:3000/webhook \
//   TRADER_DEV_API_KEY=pk_... \
//   node runner/poll-signals.js

import { Client }           from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const API_KEY     = process.env.TRADER_DEV_API_KEY;
const BOT_WEBHOOK = process.env.BOT_WEBHOOK;
const STRATEGY_ID = process.env.STRATEGY_ID || '01KSDS5BCKYSXRET62Z32X17TN';
const POLL_MS     = 60_000; // 60 seconds

if (!API_KEY)     { console.error('TRADER_DEV_API_KEY not set'); process.exit(1); }
if (!BOT_WEBHOOK) { console.error('BOT_WEBHOOK not set'); process.exit(1); }

// Track last seen signal to avoid duplicates
let lastSeenId = null;

async function makeClient() {
  const transport = new SSEClientTransport(
    new URL('https://mcp.trader.dev/sse'),
    { requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } } }
  );
  const client = new Client({ name: 'signal-poller', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

function parse(raw) {
  const text = raw?.content?.[0]?.text ?? JSON.stringify(raw);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function pollOnce(client) {
  const raw = await client.callTool({
    name: 'get_recent_signals',
    arguments: { strategyId: STRATEGY_ID, limit: 5 },
  });

  const data    = parse(raw);
  const signals = data?.signals ?? data?.data ?? (Array.isArray(data) ? data : []);

  if (!signals.length) { process.stdout.write('.'); return; }

  // Process newest first, stop at last seen
  for (const sig of signals) {
    const id = sig.id ?? sig.signalId ?? sig.barCloseTime;
    if (id === lastSeenId) break;

    console.log(`\n[${new Date().toISOString()}] New signal:`, JSON.stringify(sig));

    // Forward to EC2 bot
    try {
      const res = await fetch(BOT_WEBHOOK, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          signal:     sig.signalType ?? sig.type ?? sig.action,
          price:      sig.price ?? sig.closePrice ?? sig.barClose,
          symbol:     sig.symbol ?? 'ETHUSDT',
          strategyId: STRATEGY_ID,
          barTime:    sig.barCloseTime ?? sig.timestamp,
          raw:        sig,
        }),
      });
      console.log(`  Forwarded to bot: HTTP ${res.status}`);
    } catch (e) {
      console.error(`  Forward failed: ${e.message}`);
    }

    // Only process the latest signal per poll (strategy fires one at a time)
    lastSeenId = id;
    break;
  }
}

async function run() {
  console.log('========================================');
  console.log(' Signal Poller — F40d C104 $3k Live');
  console.log(` Strategy: ${STRATEGY_ID}`);
  console.log(` Webhook:  ${BOT_WEBHOOK}`);
  console.log(` Interval: ${POLL_MS / 1000}s`);
  console.log('========================================');

  let client;
  try {
    client = await makeClient();
    console.log('Connected to trader-dev MCP\n');
  } catch (e) {
    console.error('MCP connect failed:', e.message);
    process.exit(1);
  }

  // Initial poll to set baseline (don't fire old signals)
  const raw  = await client.callTool({ name: 'get_recent_signals', arguments: { strategyId: STRATEGY_ID, limit: 1 } });
  const data = parse(raw);
  const sigs = data?.signals ?? data?.data ?? (Array.isArray(data) ? data : []);
  if (sigs.length) {
    lastSeenId = sigs[0].id ?? sigs[0].signalId ?? sigs[0].barCloseTime;
    console.log(`Baseline signal ID: ${lastSeenId} (won't replay old signals)`);
  }

  // Poll loop — reconnect on error
  while (true) {
    try {
      await pollOnce(client);
    } catch (e) {
      console.error('\nPoll error:', e.message, '— reconnecting...');
      try { await client.close(); } catch {}
      await new Promise(r => setTimeout(r, 5000));
      try { client = await makeClient(); } catch {}
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

run();
