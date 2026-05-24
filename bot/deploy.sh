#!/usr/bin/env bash
# Run this on your EC2 once to set everything up
set -euo pipefail

echo "=== F40d Bot — EC2 Setup ==="

# 1. Install Node 22 if needed
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node: $(node -v)"

# 2. Install PM2
sudo npm install -g pm2

# 3. Install bot deps
cd "$(dirname "$0")"
npm install

# 4. Create .env if missing
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo ">>> Edit .env with your credentials then re-run this script <<<"
  echo "    nano .env"
  exit 0
fi

# 5. Open port 3000 in firewall (if ufw active)
if command -v ufw &>/dev/null && ufw status | grep -q active; then
  sudo ufw allow 3000/tcp
  echo "Port 3000 opened"
fi

# 6. Start with PM2
pm2 stop f40d-bot 2>/dev/null || true
pm2 start server.js --name f40d-bot --node-args="--experimental-vm-modules"
pm2 save
pm2 startup | tail -1 | bash 2>/dev/null || true

echo ""
echo "=== DONE ==="
echo "Bot is running. Your webhook URL:"
echo "  http://$(curl -s ifconfig.me):3000/webhook"
echo ""
echo "Paste this URL into trader-dev → your strategy → Alert Sinks → Webhook"
echo ""
echo "Check status: pm2 logs f40d-bot"
echo "Health check: curl http://localhost:3000/health"
