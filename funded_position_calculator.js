#!/usr/bin/env node
/**
 * Funded Platform Position-Size Calculator & Scorecard
 *
 * Strategy: F40d C104 v2 (ETHUSDT 1H)
 * Backtest baseline (Fixed 100 ETH on $10k):
 *   Net +2371.75% | PF 2.00 | Max DD 18.36% | WR 46.15% | 78 trades
 *
 * Position sizing formula (fixed fractional risk):
 *   qty = (account × riskPct) / (stopPct × price)
 *   A full stop-out then loses exactly riskPct of the account.
 */

const STOP_PCT = 0.02;          // 2% stop loss (from strategy)
const ETH_PRICES = [1500, 2500, 4000];   // low / mid / high regime
const RISK_LEVELS = [0.0025, 0.005, 0.01]; // 0.25%, 0.5%, 1.0% per trade

const PLATFORMS = [
  { name: 'Apex / Topstep', maxDD: 0.06, maxDaily: 0.02 },
  { name: 'MyFundedFX',      maxDD: 0.08, maxDaily: 0.04 },
  { name: 'FTMO',            maxDD: 0.10, maxDaily: 0.05 },
];

const ACCOUNT_TIERS = [25000, 50000, 100000, 150000, 200000];

// ── Position size table ──────────────────────────────────────────────────────

function positionSize(account, riskPct, price) {
  const notional = (account * riskPct) / STOP_PCT;
  const eth = notional / price;
  const leverage = notional / account;
  return { notional, eth, leverage };
}

function printSizingTable() {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  POSITION SIZE — ETH per trade  (stop = 2%)');
  console.log('══════════════════════════════════════════════════════════════════');
  for (const risk of RISK_LEVELS) {
    console.log(`\n  Risk per trade: ${(risk * 100).toFixed(2)}%`);
    console.log('  ┌────────────┬──────────────┬───────────────────────────────┐');
    console.log('  │  Account   │   Notional   │  ETH qty @ $1.5k / $2.5k / $4k │');
    console.log('  ├────────────┼──────────────┼───────────────────────────────┤');
    for (const acct of ACCOUNT_TIERS) {
      const sizes = ETH_PRICES.map(p => positionSize(acct, risk, p).eth.toFixed(1));
      const notional = positionSize(acct, risk, ETH_PRICES[1]).notional;
      console.log(
        `  │ $${String(acct.toLocaleString()).padEnd(9)}│ $${String(Math.round(notional).toLocaleString()).padEnd(11)}│  ${sizes[0].padStart(6)} / ${sizes[1].padStart(6)} / ${sizes[2].padStart(6)}        │`
      );
    }
    console.log('  └────────────┴──────────────┴───────────────────────────────┘');
  }
}

// ── DD projection ────────────────────────────────────────────────────────────
// The fixed-100-ETH backtest hit 18.36% DD, but that run used wildly variable
// leverage (100 ETH on a $10k→$247k account). With fixed-fractional sizing the
// max DD scales ~linearly with risk%. We estimate the funded DD from the
// strategy's worst losing streak rather than the leverage-distorted 18.36%.
//
// From the trade data: ~42 losses across 78 trades, PF 2.0. A conservative
// worst-case run is ~6 consecutive full-stop losses (observed clustering).
// DD ≈ 1 - (1 - risk)^streak  (compounded), plus a slippage cushion.

const WORST_STREAK = 6;       // consecutive full-stop losses (conservative)
const SLIPPAGE_CUSHION = 1.25; // 25% buffer for gaps / partial fills

function projectedMaxDD(riskPct) {
  const compounded = 1 - Math.pow(1 - riskPct, WORST_STREAK);
  return compounded * SLIPPAGE_CUSHION;
}

function printScorecard() {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  FUNDED PLATFORM SCORECARD');
  console.log(`  (projected max DD from ${WORST_STREAK}-loss streak × ${SLIPPAGE_CUSHION}× cushion)`);
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('\n  ┌──────────┬───────────┬──────────────────────────────────────┐');
  console.log('  │  Risk %  │  Proj. DD │  Pass / Fail by platform             │');
  console.log('  ├──────────┼───────────┼──────────────────────────────────────┤');
  for (const risk of RISK_LEVELS) {
    const dd = projectedMaxDD(risk);
    const verdicts = PLATFORMS.map(p => {
      const pass = dd <= p.maxDD;
      return `${p.name.split(' ')[0]}:${pass ? 'PASS' : 'FAIL'}`;
    }).join('  ');
    console.log(
      `  │ ${((risk * 100).toFixed(2) + '%').padStart(7)} │ ${((dd * 100).toFixed(2) + '%').padStart(8)} │  ${verdicts.padEnd(36)}│`
    );
  }
  console.log('  └──────────┴───────────┴──────────────────────────────────────┘');

  console.log('\n  Daily loss check (single worst trade = risk%, well under all limits):');
  for (const p of PLATFORMS) {
    const safeRisk = RISK_LEVELS.filter(r => projectedMaxDD(r) <= p.maxDD);
    const maxSafe = safeRisk.length ? Math.max(...safeRisk) : 0;
    console.log(`    ${p.name.padEnd(16)} maxDD ${(p.maxDD*100).toFixed(0)}% → safe up to ${(maxSafe*100).toFixed(2)}% risk/trade`);
  }
}

// ── Recommendation ───────────────────────────────────────────────────────────

function printRecommendation() {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  RECOMMENDATION');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log(`
  - Apex / Topstep (6% DD)  → use 0.25% risk/trade. Conservative, passes clean.
  - MyFundedFX (8% DD)      → 0.5% risk/trade is the sweet spot.
  - FTMO (10% DD)           → 0.5% risk/trade with headroom.

  At $100k account, 0.5% risk, ETH $2.5k:
     Notional $25,000  →  10 ETH/trade  →  one stop = -$500 (0.5%)

  CAVEAT: projected DD assumes a 6-loss streak. VERIFY by running
  strategy_v2_funded.pine through trader-dev quick_backtest with the
  matching riskPct, then compare the engine's real Max DD to these limits.
`);
}

printSizingTable();
printScorecard();
printRecommendation();
