# Agents — F40d C104 Funded Platform Research Desk

Specialized agent prompts for your local Claude Code session (trader-dev MCP required).

## Setup

These agents require the Trader Dev MCP running locally:
```bash
claude mcp add --transport sse --scope user trader-dev https://mcp.trader.dev/sse
```

Cloud Claude Code (code.claude.com) cannot reach Trader Dev — run these on your local machine.

## Agents

### funded-risk-auditor.md
Audits the funded strategy variant against Apex/Topstep, MyFundedFX, and FTMO limits.
- Runs funded backtests if missing
- Stress-tests against chop periods, volatility spikes, and bear markets
- Produces a platform compliance matrix

**Use when**: validating that Max DD stays under prop firm limits at a given risk level.

```
# Paste into local Claude Code:
read agents/funded-risk-auditor.md and execute it
```

### strategy-iterator.md
Iterates on entry/exit logic to improve WR and reduce DD without changing the core edge.
- Tests one hypothesis per cycle (velocity threshold, ADX threshold, asymmetric long/short, etc.)
- Enforces anti-overfitting: must work on 2+ symbols

**Use when**: trying to improve funded pass rate by tightening the signal quality.

```
# Paste into local Claude Code:
read agents/strategy-iterator.md and execute it
```

## Loop commands (run continuously)

```bash
# Audit funded compliance every 15 min
/loop 15m read agents/funded-risk-auditor.md and execute it

# Iterate on strategy edge every 15 min
/loop 15m read agents/strategy-iterator.md and execute it
```

## Workflow

1. Run `funded-risk-auditor` first to get baseline compliance status
2. If Max DD is too close to a platform limit, run `strategy-iterator` to tighten the edge
3. Re-run `funded-risk-auditor` after each iterator cycle to check compliance
4. Once all three platforms pass with ≥1.5% headroom → strategy is funded-ready

## Reference metrics

| Variant              | Net P&L    | PF   | Max DD  | WR     | Trades |
|----------------------|-----------|------|---------|--------|--------|
| Fixed 100 ETH        | +2371.75% | 2.00 | 18.36%  | 46.15% | 78     |
| Funded 0.5% risk     | TBD       | TBD  | TBD     | TBD    | TBD    |

Funded backtest pending: run `funded-risk-auditor` locally to fill in the TBD values.
