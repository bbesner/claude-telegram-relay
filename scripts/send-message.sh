#!/bin/bash
# ============================================================================
# send-message.sh — Outbound Telegram message helper
# Part of claude-telegram-relay v1.3.0+
#
# Sends a message through your Telegram bot to an allowed user.
# Reads bot token and default chat ID from the relay's .env file.
#
# Usage:
#   bash send-message.sh "Hello from the command line"
#   bash send-message.sh --file /path/to/message.txt
#   echo "Status update" | bash send-message.sh --stdin
#   bash send-message.sh --chat-id 123456789 "Direct to a specific user"
#   bash send-message.sh --title "Deploy complete" "Build 42 succeeded"
#   bash send-message.sh --parse-mode Markdown "*bold* and _italic_"
#
# Environment variables (override .env):
#   TELEGRAM_BOT_TOKEN  Bot token (required)
#   DEFAULT_CHAT_ID     Override the default chat ID (default: first in ALLOWED_USER_IDS)
#   TELEGRAM_RELAY_ENV  Path to .env file (default: repo root .env)
#
# Long messages (>4096 chars) are automatically split at paragraph breaks.
# Exit codes: 0 success, 1 missing args/env, 2 send failure
# ============================================================================

set -o pipefail

# ── Locate .env file ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${TELEGRAM_RELAY_ENV:-$REPO_ROOT/.env}"

if [ -f "$ENV_FILE" ]; then
    # Load .env but only the keys we care about, and preserve existing env vars
    while IFS='=' read -r key val; do
        # Skip comments and empty lines
        [[ "$key" =~ ^#.*$ ]] && continue
        [[ -z "$key" ]] && continue
        # Strip surrounding quotes from value
        val="${val%\"}"
        val="${val#\"}"
        val="${val%\'}"
        val="${val#\'}"
        case "$key" in
            TELEGRAM_BOT_TOKEN)
                [ -z "${TELEGRAM_BOT_TOKEN:-}" ] && export TELEGRAM_BOT_TOKEN="$val"
                ;;
            ALLOWED_USER_IDS)
                [ -z "${ALLOWED_USER_IDS:-}" ] && export ALLOWED_USER_IDS="$val"
                ;;
            DEFAULT_CHAT_ID)
                [ -z "${DEFAULT_CHAT_ID:-}" ] && export DEFAULT_CHAT_ID="$val"
                ;;
        esac
    done < "$ENV_FILE"
fi

# ── Parse arguments ─────────────────────────────────────────────────────────
CHAT_ID=""
MESSAGE=""
MESSAGE_FILE=""
READ_STDIN=false
TITLE=""
PARSE_MODE=""
POSITIONAL_MESSAGE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --chat-id)
            CHAT_ID="$2"
            shift 2
            ;;
        --file)
            MESSAGE_FILE="$2"
            shift 2
            ;;
        --stdin)
            READ_STDIN=true
            shift
            ;;
        --title)
            TITLE="$2"
            shift 2
            ;;
        --parse-mode)
            PARSE_MODE="$2"
            shift 2
            ;;
        --help|-h)
            sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2
            echo "Run with --help for usage." >&2
            exit 1
            ;;
        *)
            if [ -z "$POSITIONAL_MESSAGE" ]; then
                POSITIONAL_MESSAGE="$1"
            else
                POSITIONAL_MESSAGE="$POSITIONAL_MESSAGE $1"
            fi
            shift
            ;;
    esac
done

# ── Resolve message body ────────────────────────────────────────────────────
if [ -n "$MESSAGE_FILE" ]; then
    if [ ! -f "$MESSAGE_FILE" ]; then
        echo "Error: file not found: $MESSAGE_FILE" >&2
        exit 1
    fi
    MESSAGE=$(cat "$MESSAGE_FILE")
elif [ "$READ_STDIN" = true ]; then
    MESSAGE=$(cat)
elif [ -n "$POSITIONAL_MESSAGE" ]; then
    MESSAGE="$POSITIONAL_MESSAGE"
else
    echo "Error: no message provided." >&2
    echo "Usage:" >&2
    echo "  send-message.sh \"Your message here\"" >&2
    echo "  send-message.sh --file message.txt" >&2
    echo "  echo 'hi' | send-message.sh --stdin" >&2
    echo "" >&2
    echo "Run with --help for full usage." >&2
    exit 1
fi

if [ -z "$MESSAGE" ]; then
    echo "Error: message is empty." >&2
    exit 1
fi

# Prepend title if provided
if [ -n "$TITLE" ]; then
    MESSAGE="$TITLE

$MESSAGE"
fi

# ── Validate bot token ──────────────────────────────────────────────────────
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    echo "Error: TELEGRAM_BOT_TOKEN not set." >&2
    echo "Either set it in the environment, or in $ENV_FILE" >&2
    exit 1
fi

# ── Resolve chat ID ─────────────────────────────────────────────────────────
if [ -z "$CHAT_ID" ]; then
    if [ -n "${DEFAULT_CHAT_ID:-}" ]; then
        CHAT_ID="$DEFAULT_CHAT_ID"
    elif [ -n "${ALLOWED_USER_IDS:-}" ]; then
        # Use the first ID in the comma-separated list
        CHAT_ID="$(echo "$ALLOWED_USER_IDS" | cut -d',' -f1 | tr -d ' ')"
    fi
fi

if [ -z "$CHAT_ID" ]; then
    echo "Error: no chat ID available." >&2
    echo "Either pass --chat-id, set DEFAULT_CHAT_ID in env, or set ALLOWED_USER_IDS in $ENV_FILE" >&2
    exit 1
fi

# Validate chat ID is numeric (Telegram user IDs are integers)
if ! [[ "$CHAT_ID" =~ ^-?[0-9]+$ ]]; then
    echo "Error: chat ID must be a number, got: $CHAT_ID" >&2
    exit 1
fi

# ── Send message (with automatic chunking for long messages) ────────────────
# Telegram's hard limit is 4096 chars per message. We use 3800 to leave room
# for chunk markers if we split.
MAX_LEN=3800

# Write message to a temp file so we don't have to worry about shell escaping
# special characters (backticks, $, quotes, etc.) in the body.
MSG_TMP="/tmp/.tg-send-msg-$$"
printf '%s' "$MESSAGE" > "$MSG_TMP"

python3 - << PYEOF
import json
import os
import sys
import urllib.request
import urllib.error

token = os.environ.get('TELEGRAM_BOT_TOKEN', '')
chat_id = int('$CHAT_ID')
parse_mode = '''$PARSE_MODE''' or None
max_len = $MAX_LEN

# Read message from temp file (written by the shell wrapper)
with open('$MSG_TMP') as f:
    text = f.read()

def chunks(s, n):
    """Split text into chunks of at most n chars, preferring paragraph breaks."""
    if len(s) <= n:
        return [s]
    result = []
    remaining = s
    while len(remaining) > n:
        # Try to break at the last double newline before n
        split_at = remaining.rfind('\n\n', 0, n)
        if split_at == -1 or split_at < n // 2:
            # Fallback: break at the last single newline
            split_at = remaining.rfind('\n', 0, n)
        if split_at == -1 or split_at < n // 2:
            # Fallback: break at the last space
            split_at = remaining.rfind(' ', 0, n)
        if split_at == -1:
            # Last resort: hard split
            split_at = n
        result.append(remaining[:split_at].rstrip())
        remaining = remaining[split_at:].lstrip()
    if remaining:
        result.append(remaining)
    return result

parts = chunks(text, max_len)
n_parts = len(parts)

def send(body):
    payload = {'chat_id': chat_id, 'text': body}
    if parse_mode:
        payload['parse_mode'] = parse_mode
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        f'https://api.telegram.org/bot{token}/sendMessage',
        data=data,
        headers={'Content-Type': 'application/json'}
    )
    try:
        resp = urllib.request.urlopen(req, timeout=15)
        result = json.loads(resp.read())
        if not result.get('ok'):
            print(f'ERROR: Telegram rejected message: {result}', file=sys.stderr)
            return None
        return result['result'].get('message_id')
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()
        print(f'ERROR: HTTP {e.code}: {body_text}', file=sys.stderr)
        return None
    except Exception as e:
        print(f'ERROR: {type(e).__name__}: {e}', file=sys.stderr)
        return None

sent_ids = []
for i, part in enumerate(parts, 1):
    prefix = f'[{i}/{n_parts}] ' if n_parts > 1 else ''
    mid = send(prefix + part)
    if mid is None:
        sys.exit(2)
    sent_ids.append(str(mid))

print(f'Sent {n_parts} message(s) (ids: {", ".join(sent_ids)})')
PYEOF

EXIT=$?

# Clean up temp file
rm -f "$MSG_TMP"

exit $EXIT
