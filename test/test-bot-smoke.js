// Smoke-test: require bot.js with a fake node-telegram-bot-api so it can boot
// through registerCommands + setMyCommands without actually polling Telegram.
// Also disables the v1.5.0 update checker so the test doesn't try to hit
// api.github.com from CI.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { createFixtureHome, cleanupFixtureHome } = require('./fixtures');

const fx = createFixtureHome();
process.env.HOME = fx.home;
process.env.LOG_LEVEL = 'warn';
process.env.TELEGRAM_BOT_TOKEN = 'fake-token-for-smoke-test';
process.env.ALLOWED_USER_IDS = '999';
process.env.CLAUDE_PATH = process.platform === 'win32' ? 'cmd' : '/usr/bin/true';
process.env.WORKING_DIR = fx.home;
process.env.UPDATE_CHECK = 'false'; // don't hit GitHub during smoke test

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

// --- Intercept `require('node-telegram-bot-api')` ---
let setMyCommandsCalls = 0;
let lastCommands = null;
let handlerCount = 0;

const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'node-telegram-bot-api') {
    return class FakeBot {
      constructor(token, opts) { this._opts = opts; }
      getMe() { return Promise.resolve({ id: 999, username: 'fake_bot', first_name: 'Fake' }); }
      onText(regex, handler) { handlerCount++; }
      on(event, handler)     { /* noop */ }
      sendMessage()          { return Promise.resolve({ message_id: 1 }); }
      sendChatAction()       { return Promise.resolve(); }
      sendPhoto()            { return Promise.resolve({ message_id: 2 }); }
      sendDocument()         { return Promise.resolve({ message_id: 3 }); }
      setMyCommands(cmds)    { setMyCommandsCalls++; lastCommands = cmds; return Promise.resolve(true); }
      stopPolling()          {}
    };
  }
  return origLoad.apply(this, [request, parent, ...rest]);
};

try {
  require('../bot.js');
  ok('bot.js loaded without throwing', true);
} catch (e) {
  ok('bot.js loaded without throwing', false, e.message);
  cleanupFixtureHome(fx);
  process.exit(1);
}

// Give the getMe().then() a tick to resolve so setMyCommands fires
setTimeout(() => {
  ok('onText handlers registered',      handlerCount >= 8);
  ok('setMyCommands called on startup', setMyCommandsCalls === 1);
  ok('setMyCommands sent >= 10 commands', lastCommands && lastCommands.length >= 10);

  // Spot-check a couple of commands are present
  const cmdSet = new Set((lastCommands || []).map(c => c.command));
  ok('published /sessions', cmdSet.has('sessions'));
  ok('published /resume',   cmdSet.has('resume'));
  ok('published /save',     cmdSet.has('save'));
  ok('published /status',   cmdSet.has('status'));
  ok('published /help',     cmdSet.has('help'));

  // Each entry has a non-empty description
  const allHaveDescription = (lastCommands || []).every(c => typeof c.description === 'string' && c.description.length > 0);
  ok('all commands carry descriptions', allHaveDescription);

  console.log(`\nbot-smoke: ${pass} passed, ${fail} failed`);
  cleanupFixtureHome(fx);
  process.exit(fail === 0 ? 0 : 1);
}, 300);
