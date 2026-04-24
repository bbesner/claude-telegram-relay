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
  const now = new Date().toISOString();
  if (!sessions[key]) {
    sessions[key] = {
      sessionId,
      startedAt: now,
      messageCount: 0,
      status: 'active',
    };
  } else {
    sessions[key].sessionId = sessionId;
    sessions[key].status = 'active';
    // Clear any transient error state on a successful turn.
    sessions[key].lastError = null;
  }
  sessions[key].messageCount++;
  sessions[key].lastMessageAt = now;
  sessions[key].lastSuccessAt = now;
  save();
  return sessions[key];
}

/**
 * v1.6.0: record a session-level error (resume failure, timeout, crash) without
 * swapping the sessionId. Marks the session degraded so /info can surface it.
 */
function markSessionError(msg, reason, { kind = 'error' } = {}) {
  const key = sessionKey(msg);
  if (!sessions[key]) return null;
  const now = new Date().toISOString();
  sessions[key].lastError = reason || 'unknown error';
  sessions[key].lastErrorAt = now;
  if (kind === 'resume-failed') {
    sessions[key].lastResumeFailedAt = now;
    sessions[key].status = 'degraded';
  } else if (kind === 'timeout') {
    sessions[key].status = 'degraded';
  } else {
    sessions[key].status = 'degraded';
  }
  save();
  return sessions[key];
}

/**
 * v1.6.0: explicitly swap a broken session for a fresh one, recording the
 * previous ID so users can trace what happened. Unlike setSession this is
 * only called when the user has opted in to replacement.
 */
function replaceSession(msg, newSessionId, previousSessionId, reason) {
  const key = sessionKey(msg);
  const now = new Date().toISOString();
  const prev = sessions[key] || {};
  sessions[key] = {
    sessionId: newSessionId,
    startedAt: now,
    messageCount: 0,
    status: 'active',
    replacedPreviousSessionId: previousSessionId || prev.sessionId || null,
    replacedAt: now,
    replacedReason: reason || null,
    lastError: null,
    lastMessageAt: now,
    lastSuccessAt: now,
    model: prev.model,
    _lastListing: prev._lastListing,
  };
  save();
  return sessions[key];
}

/**
 * v1.6.0: per-chat cost accounting. Adds the cost of the latest turn and
 * returns a running total. Costs come from Claude's JSON output
 * (total_cost_usd), which the CLI reports per invocation.
 */
function recordCost(msg, costUsd) {
  if (typeof costUsd !== 'number' || !isFinite(costUsd) || costUsd <= 0) return;
  const key = sessionKey(msg);
  if (!sessions[key]) return;
  sessions[key].lastCostUsd = costUsd;
  sessions[key].totalCostUsd = (sessions[key].totalCostUsd || 0) + costUsd;
  save();
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
  // v1.6.0
  markSessionError,
  replaceSession,
  recordCost,
};
