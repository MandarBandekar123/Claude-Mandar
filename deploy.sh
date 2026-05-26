#!/usr/bin/env bash
# F40d C104 — EC2 deploy script
# Run once on a fresh Amazon Linux 2 / Ubuntu EC2 instance

set -e

BOT_DIR="$(cd "$(dirname "$0")/bot" && pwd)"
echo "Bot directory: $BOT_DIR"

# ── 1. Install Node 20 (if not present) ──────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.version.split(".")[0].slice(1))')" -lt 18 ]]; then
  echo "Installing Node.js 20..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
    sudo yum install -y nodejs
  else
    echo "ERROR: Unknown package manager. Install Node 20 manually." && exit 1
  fi
fi
echo "Node: $(node -v) | npm: $(npm -v)"

# ── 2. Install PM2 ────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  echo "Installing PM2..."
  sudo npm install -g pm2
fi

# ── 3. Install bot dependencies ───────────────────────────────────────────────
cd "$BOT_DIR"
echo "Installing npm dependencies..."
npm install

# ── 4. Check .env ─────────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  .env created from .env.example — FILL IN YOUR CREDENTIALS"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  echo "  Edit: nano bot/.env"
  echo ""
  echo "  Required:"
  echo "    TELEGRAM_TOKEN=     (from @BotFather → /newbot)"
  echo "    TELEGRAM_CHAT_ID=   (from @userinfobot)"
  echo "    BYBIT_API_KEY=      (demo-bybit.com → API Management)"
  echo "    BYBIT_API_SECRET=   (demo-bybit.com → API Management)"
  echo "    BYBIT_TESTNET=true  (keep true for demo)"
  echo ""
  echo "  Then run:  bash deploy.sh --start"
  echo ""
  exit 0
fi

# ── 5. Start / restart with PM2 ──────────────────────────────────────────────
if [[ "$1" == "--start" || "$1" == "--restart" ]]; then
  pm2 delete f40d-bot 2>/dev/null || true
  pm2 start server.js --name f40d-bot --no-autorestart false
  pm2 save
  pm2 startup 2>/dev/null | tail -1 | bash 2>/dev/null || true

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Bot started!  Useful commands:"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  pm2 logs f40d-bot          — live log stream"
  echo "  pm2 status                 — process status"
  echo "  curl localhost:3000/health — open trades"
  echo "  pm2 restart f40d-bot       — restart after code changes"
  echo "  pm2 stop f40d-bot          — stop bot"
  echo ""
fi
