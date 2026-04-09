const fs = require('fs');
const path = require('path');
const log = require('./logger');

const STATE_DIR = path.join(process.env.HOME || '/tmp', '.claude-telegram-relay');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');

let sessions = {};

function load() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      sessions = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      log.info('Sessions loaded', { count: Object.keys(sessions).length });
    }
  } catch (e) {
    log.warn('Failed to load sessions, starting fresh', { error: e.message });
    sessions = {};
  }
}

function save() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    log.error('Failed to save sessions', { error: e.message });
  }
}

/**
 * Get session key for a chat. DMs use user ID, groups use chat ID.
 */
function sessionKey(msg) {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  if (chatType === 'private') {
    return `user:${msg.from.id}`;
  }
  return `group:${chatId}`;
}

function getSession(msg) {
  const key = sessionKey(msg);
  return sessions[key] || null;
}

function setSession(msg, sessionId) {
  const key = sessionKey(msg);
  if (!sessions[key]) {
    sessions[key] = {
      sessionId,
      startedAt: new Date().toISOString(),
      messageCount: 0,
    };
  } else {
    sessions[key].sessionId = sessionId;
  }
  sessions[key].messageCount++;
  sessions[key].lastMessageAt = new Date().toISOString();
  save();
  return sessions[key];
}

function clearSession(msg) {
  const key = sessionKey(msg);
  delete sessions[key];
  save();
  log.info('Session cleared', { key });
}

function getUserModel(msg) {
  const key = sessionKey(msg);
  return sessions[key]?.model || null;
}

function setUserModel(msg, model) {
  const key = sessionKey(msg);
  if (!sessions[key]) {
    sessions[key] = {
      sessionId: null,
      startedAt: new Date().toISOString(),
      messageCount: 0,
    };
  }
  sessions[key].model = model || undefined;
  save();
}

// Load on require
load();

module.exports = {
  getSession,
  setSession,
  clearSession,
  getUserModel,
  setUserModel,
  sessionKey,
};
