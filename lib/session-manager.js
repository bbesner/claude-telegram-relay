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

/**
 * Switch the active session to an arbitrary session ID (e.g. from /resume).
 * Preserves model preference and message count; resets startedAt.
 */
function setSessionById(msg, sessionId) {
  const key = sessionKey(msg);
  const existing = sessions[key] || {};
  sessions[key] = {
    ...existing,
    sessionId,
    startedAt: new Date().toISOString(),
    messageCount: existing.messageCount || 0,
    resumedAt: new Date().toISOString(),
  };
  save();
  log.info('Session switched via /resume', { key, sessionId: sessionId.slice(0, 8) });
  return sessions[key];
}

/**
 * Save a human-readable label for the current session.
 * Labels are stored under sessions._named and keyed by session ID.
 */
function saveSessionLabel(msg, label) {
  const key = sessionKey(msg);
  const session = sessions[key];
  if (!session?.sessionId) return false;

  if (!sessions._named) sessions._named = {};
  sessions._named[session.sessionId] = {
    label: label.trim(),
    savedAt: new Date().toISOString(),
  };
  save();
  log.info('Session labeled', { sessionId: session.sessionId.slice(0, 8), label });
  return true;
}

/**
 * Look up a session ID by label (case-insensitive).
 */
function getSessionByLabel(label) {
  const named = sessions._named || {};
  const lower = label.toLowerCase();
  for (const [sessionId, meta] of Object.entries(named)) {
    if (meta.label.toLowerCase() === lower) return sessionId;
  }
  return null;
}

/**
 * Returns a Set of all session IDs the relay has ever tracked.
 * Used by the session browser to mark relay-originated sessions.
 */
function getAllRelaySessionIds() {
  const ids = new Set();
  for (const [key, val] of Object.entries(sessions)) {
    if (key === '_named') continue;
    if (val?.sessionId) ids.add(val.sessionId);
  }
  return ids;
}

/**
 * Store the last /sessions listing for a chat so /resume <n> works by index.
 */
function setSessionListing(msg, listing) {
  const key = sessionKey(msg);
  if (!sessions[key]) sessions[key] = { sessionId: null, startedAt: new Date().toISOString(), messageCount: 0 };
  sessions[key]._lastListing = listing.map(s => s.sessionId);
  save();
}

/**
 * Get a session ID by 1-based index from the last /sessions listing.
 */
function getSessionFromListing(msg, index) {
  const key = sessionKey(msg);
  const listing = sessions[key]?._lastListing;
  if (!listing || index < 1 || index > listing.length) return null;
  return listing[index - 1];
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
  setSessionById,
  clearSession,
  getUserModel,
  setUserModel,
  saveSessionLabel,
  getSessionByLabel,
  getAllRelaySessionIds,
  setSessionListing,
  getSessionFromListing,
  sessionKey,
};
