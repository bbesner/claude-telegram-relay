#!/bin/bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $1"; exit 1; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     Claude Telegram Relay — Installer    ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# --- Parse arguments ---
TOKEN=""
USER_IDS=""
INSTALL_DIR=""
WORKING_DIR=""
CLAUDE_PATH_ARG=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --token)        TOKEN="$2"; shift 2 ;;
    --users)        USER_IDS="$2"; shift 2 ;;
    --install-dir)  INSTALL_DIR="$2"; shift 2 ;;
    --working-dir)  WORKING_DIR="$2"; shift 2 ;;
    --claude-path)  CLAUDE_PATH_ARG="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: install.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --token <token>        Telegram bot token (from @BotFather)"
      echo "  --users <ids>          Comma-separated allowed Telegram user IDs"
      echo "  --install-dir <path>   Installation directory (default: ~/claude-telegram-relay)"
      echo "  --working-dir <path>   Working directory for Claude CLI (default: \$HOME)"
      echo "  --claude-path <path>   Path to claude binary (auto-detected if omitted)"
      echo "  -h, --help             Show this help"
      exit 0
      ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

# --- Pre-flight checks ---
info "Running pre-flight checks..."

# Node.js
if ! command -v node &>/dev/null; then
  fail "Node.js is required but not found. Install Node.js 18+ first."
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ $NODE_VER -lt 18 ]]; then
  fail "Node.js 18+ required, found $(node -v)"
fi
ok "Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
  fail "npm is required but not found."
fi
ok "npm $(npm -v)"

# PM2
if ! command -v pm2 &>/dev/null; then
  fail "PM2 is required but not found. Install with: npm install -g pm2"
fi
ok "PM2 $(pm2 -v 2>/dev/null || echo 'installed')"

# Claude CLI
CLAUDE_BIN="${CLAUDE_PATH_ARG}"
if [[ -z "$CLAUDE_BIN" ]]; then
  CLAUDE_BIN=$(which claude 2>/dev/null || echo "")
fi
if [[ -z "$CLAUDE_BIN" || ! -x "$CLAUDE_BIN" ]]; then
  fail "Claude CLI not found. Install it or pass --claude-path"
fi
CLAUDE_VER=$($CLAUDE_BIN --version 2>/dev/null || echo "unknown")
ok "Claude CLI: $CLAUDE_BIN ($CLAUDE_VER)"

echo ""

# --- Interactive prompts for missing config ---
if [[ -z "$TOKEN" ]]; then
  echo -e "${YELLOW}Telegram Bot Token${NC} (from @BotFather):"
  read -r TOKEN
  [[ -z "$TOKEN" ]] && fail "Bot token is required"
fi

if [[ -z "$USER_IDS" ]]; then
  echo -e "${YELLOW}Allowed Telegram User IDs${NC} (comma-separated):"
  echo "  (Find your ID by messaging @userinfobot on Telegram)"
  read -r USER_IDS
  [[ -z "$USER_IDS" ]] && fail "At least one user ID is required"
fi

if [[ -z "$INSTALL_DIR" ]]; then
  DEFAULT_DIR="$HOME/claude-telegram-relay"
  echo -e "${YELLOW}Installation directory${NC} [${DEFAULT_DIR}]:"
  read -r INSTALL_DIR
  INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_DIR}"
fi

if [[ -z "$WORKING_DIR" ]]; then
  echo -e "${YELLOW}Working directory for Claude CLI${NC} [\$HOME]:"
  echo "  (This determines which CLAUDE.md context is loaded)"
  read -r WORKING_DIR
  WORKING_DIR="${WORKING_DIR:-$HOME}"
fi

echo ""
info "Configuration:"
echo "  Token:        ${TOKEN:0:15}..."
echo "  User IDs:     $USER_IDS"
echo "  Install dir:  $INSTALL_DIR"
echo "  Working dir:  $WORKING_DIR"
echo "  Claude CLI:   $CLAUDE_BIN"
echo ""

# --- Install ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$SCRIPT_DIR" != "$INSTALL_DIR" ]]; then
  info "Copying files to $INSTALL_DIR..."
  mkdir -p "$INSTALL_DIR"
  cp -r "$SCRIPT_DIR"/{bot.js,lib,package.json,ecosystem.config.js,config,VERSION,LICENSE,README.md,.gitignore} "$INSTALL_DIR/" 2>/dev/null || true
  ok "Files copied"
else
  ok "Already in install directory"
fi

cd "$INSTALL_DIR"

# Generate .env
info "Generating .env..."
cat > .env <<EOF
TELEGRAM_BOT_TOKEN=${TOKEN}
ALLOWED_USER_IDS=${USER_IDS}
CLAUDE_PATH=${CLAUDE_BIN}
WORKING_DIR=${WORKING_DIR}
CLAUDE_TIMEOUT_MS=120000
LOG_LEVEL=info
GROUP_MODE=mention
EOF
ok ".env created"

# Update ecosystem.config.js cwd
info "Configuring PM2 ecosystem..."
sed -i "s|cwd: __dirname|cwd: '${INSTALL_DIR}'|" ecosystem.config.js 2>/dev/null || true
ok "PM2 config updated"

# npm install
info "Installing dependencies..."
npm install --production --no-fund --no-audit 2>&1 | tail -1
ok "Dependencies installed"

# Create logs directory
mkdir -p logs

# Start with PM2
info "Starting with PM2..."
pm2 delete claude-telegram-relay 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save --force 2>/dev/null || true
ok "Bot started with PM2"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Installation Complete!          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo "  Service name:  claude-telegram-relay"
echo "  Install dir:   $INSTALL_DIR"
echo "  Logs:          pm2 logs claude-telegram-relay"
echo "  Restart:       pm2 restart claude-telegram-relay"
echo "  Stop:          pm2 stop claude-telegram-relay"
echo ""
echo "  Open Telegram and send a message to your bot to test!"
echo ""
