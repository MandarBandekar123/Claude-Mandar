# Self-Hosted Backtest Runner

This system lets cloud Claude push backtest requests that run automatically on your local Mac.

## One-time setup (10 minutes)

### 1. Add the TRADER_DEV_API_KEY secret to GitHub

Go to: github.com/mandarbandekar123/claude-mandar → Settings → Secrets and variables → Actions → New repository secret

- Name: `TRADER_DEV_API_KEY`
- Value: `pk_byFvHR3_86OtLt3mVmslkXV8J1w7uZMH`

### 2. Register your Mac as a self-hosted runner

Go to: github.com/mandarbandekar123/claude-mandar → Settings → Actions → Runners → New self-hosted runner

Select: macOS → follow the download and configure steps shown on that page.

They'll look like:
```bash
# Download
mkdir actions-runner && cd actions-runner
curl -o actions-runner-osx-x64-2.x.x.tar.gz -L https://github.com/actions/runner/releases/download/...
tar xzf ./actions-runner-osx-x64-2.x.x.tar.gz

# Configure (use the token shown on the GitHub page)
./config.sh --url https://github.com/mandarbandekar123/claude-mandar --token YOUR_TOKEN

# Run
./run.sh
```

### 3. Keep the runner running

To run as a background service (survives reboots):
```bash
# In the actions-runner directory:
sudo ./svc.sh install
sudo ./svc.sh start
```

### 4. Pull the repo on your Mac
```bash
git clone https://github.com/mandarbandekar123/claude-mandar ~/claude-mandar
git -C ~/claude-mandar checkout claude/add-trader-dev-mcp-dJbZq
```

That's it. After this, cloud Claude pushes requests → your Mac runs them → results appear in git automatically.

## How it works

1. Cloud Claude writes a JSON file to `backtest-requests/` with `"status": "pending"`
2. GitHub Action triggers automatically on your Mac
3. `runner/run-backtest.js` reads the request, calls trader-dev API, saves result to `backtest_results/`
4. Results committed and pushed back to git
5. Cloud Claude reads the results

## Request format

```json
{
  "id": "unique_name_for_result_file",
  "status": "pending",
  "description": "What this test is for",
  "pineFile": "strategy_v2_personal.pine",
  "symbol": "ETHUSDT",
  "timeframe": "60",
  "fromDate": "2022-01-01",
  "toDate": "2026-05-13",
  "initialCapital": 10000
}
```

After running, status changes to `"done"` and `resultFile` is added pointing to the saved JSON.
