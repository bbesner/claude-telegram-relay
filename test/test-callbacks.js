// Tests for lib/callbacks.js — inline keyboard buttons + callback routing.
// Uses a scratch HOME so session-manager writes to a throwaway sessions.json.

const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cb-'));
process.env.HOME = SCRATCH;
process.env.LOG_LEVEL = 'error';
// INLINE_KEYBOARDS not set → default enabled

const { registerCallbackHandlers, buildResponseKeyboard, handleSaveReplyIfPresent, _savePromptIds } = require('../lib/callbacks');
const sm = require('../lib/session-manager');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

// ============================================================================
// buildResponseKeyboard
// ============================================================================

console.log('\n=== buildResponseKeyboard ===');

const kb = buildResponseKeyboard();
ok('keyboard object shape',          typeof kb === 'object' && Array.isArray(kb.inline_keyboard));
ok('one row of three buttons',        kb.inline_keyboard.length === 1 && kb.inline_keyboard[0].length === 3);

const [newBtn, saveBtn, infoBtn] = kb.inline_keyboard[0];
ok('new button text',    newBtn.text.includes('New'));
ok('save button text',   saveBtn.text.includes('Save'));
ok('info button text',   infoBtn.text.includes('Info'));
ok('new callback_data',  newBtn.callback_data === 'rly:new');
ok('save callback_data', saveBtn.callback_data === 'rly:save');
ok('info callback_data', infoBtn.callback_data === 'rly:info');

// Each callback_data must be short enough (<=64 bytes per Telegram limit)
ok('callback_data all <= 64 bytes',
   kb.inline_keyboard[0].every(b => Buffer.byteLength(b.callback_data) <= 64));

// ============================================================================
// Mock bot with EventEmitter + stubs
// ============================================================================

class MockBot extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.answered = [];
  }
  sendMessage(chatId, text, opts) {
    const message_id = this.sent.length + 1000;
    this.sent.push({ chatId, text, opts, message_id });
    return Promise.resolve({ message_id, chat: { id: chatId } });
  }
  answerCallbackQuery(id, options) {
    this.answered.push({ id, options });
    return Promise.resolve(true);
  }
}

const bot = new MockBot();
const START_TIME = Date.now() - 60_000; // 1 min ago
registerCallbackHandlers(bot, START_TIME);

function fireCallback(data, userId = 555, chatId = 555) {
  bot.emit('callback_query', {
    id: 'cb-' + Math.random().toString(36).slice(2, 8),
    data,
    from: { id: userId },
    message: { chat: { id: chatId, type: 'private' }, message_id: 42 },
  });
  // Return a promise that resolves after the event handlers run
  return new Promise(r => setImmediate(r));
}

// ============================================================================
// Callback routing
// ============================================================================

(async () => {
  console.log('\n=== Callback routing ===');

  // Set up a session for user 555 so /save has something to label
  sm.setSession({ chat: { id: 555, type: 'private' }, from: { id: 555 } }, 'cccccccc-1111-2222-3333-444444444444');

  // rly:new — clears the session
  bot.sent.length = 0;
  bot.answered.length = 0;
  await fireCallback('rly:new');
  ok('rly:new sends confirmation message',  bot.sent.length === 1 && bot.sent[0].text.includes('Session cleared'));
  ok('rly:new answers the callback query',  bot.answered.length === 1);
  ok('rly:new actually cleared the session',
     sm.getSession({ chat: { id: 555, type: 'private' }, from: { id: 555 } }) === null);

  // Re-seed a session for the /info test
  sm.setSession({ chat: { id: 555, type: 'private' }, from: { id: 555 } }, 'dddddddd-1111-2222-3333-444444444444');

  // rly:info — sends session info
  bot.sent.length = 0;
  bot.answered.length = 0;
  await fireCallback('rly:info');
  ok('rly:info sends info message',                bot.sent.length === 1);
  ok('rly:info message contains full session ID',  bot.sent[0].text.includes('dddddddd-1111-2222-3333-444444444444'));
  ok('rly:info message contains uptime',            bot.sent[0].text.includes('Uptime'));
  ok('rly:info uses HTML parse_mode',               bot.sent[0].opts?.parse_mode === 'HTML');
  ok('rly:info answers the callback query',        bot.answered.length === 1);

  // rly:save with an active session — prompts for label
  bot.sent.length = 0;
  bot.answered.length = 0;
  _savePromptIds.clear();
  await fireCallback('rly:save');
  ok('rly:save sends a prompt',                     bot.sent.length === 1);
  ok('rly:save prompt mentions "label"',            bot.sent[0].text.includes('label'));
  ok('rly:save uses ForceReply',                    bot.sent[0].opts?.reply_markup?.force_reply === true);
  ok('rly:save registers a pending save prompt',    _savePromptIds.has(555));
  ok('rly:save answers the callback query',         bot.answered.length === 1);

  // rly:save with NO active session — alert, no prompt
  sm.clearSession({ chat: { id: 999, type: 'private' }, from: { id: 999 } });
  _savePromptIds.clear();
  bot.sent.length = 0;
  bot.answered.length = 0;
  await fireCallback('rly:save', 999, 999);
  ok('rly:save without session answers with alert', bot.answered.length === 1 && bot.answered[0].options?.show_alert === true);
  ok('rly:save without session does NOT send prompt message', bot.sent.length === 0);
  ok('rly:save without session does NOT register prompt',      !_savePromptIds.has(999));

  // ==========================================================================
  // handleSaveReplyIfPresent
  // ==========================================================================

  console.log('\n=== handleSaveReplyIfPresent ===');

  // Re-seed a session and a pending prompt
  sm.setSession({ chat: { id: 555, type: 'private' }, from: { id: 555 } }, 'eeeeeeee-1111-2222-3333-444444444444');
  _savePromptIds.clear();
  _savePromptIds.set(555, { messageId: 1000, expiresAt: Date.now() + 60_000 });

  // Reply that matches the pending prompt
  bot.sent.length = 0;
  let handled = await handleSaveReplyIfPresent(bot, {
    chat: { id: 555, type: 'private' },
    from: { id: 555 },
    text: 'my-label',
    reply_to_message: { message_id: 1000 },
  });
  ok('matching save-prompt reply handled',  handled === true);
  ok('session was labeled',                  sm.getSessionByLabel('my-label') === 'eeeeeeee-1111-2222-3333-444444444444');
  ok('save-prompt consumed (deleted from map)', !_savePromptIds.has(555));
  ok('confirmation message sent',             bot.sent.length === 1 && bot.sent[0].text.includes('my-label'));

  // Reply to a different message (not our prompt)
  _savePromptIds.set(555, { messageId: 2000, expiresAt: Date.now() + 60_000 });
  bot.sent.length = 0;
  handled = await handleSaveReplyIfPresent(bot, {
    chat: { id: 555, type: 'private' },
    from: { id: 555 },
    text: 'irrelevant',
    reply_to_message: { message_id: 9999 }, // different message
  });
  ok('non-matching reply NOT handled', handled === false);
  ok('prompt still pending',            _savePromptIds.has(555));

  // Expired prompt
  _savePromptIds.set(555, { messageId: 3000, expiresAt: Date.now() - 1000 });
  handled = await handleSaveReplyIfPresent(bot, {
    chat: { id: 555, type: 'private' },
    from: { id: 555 },
    text: 'x',
    reply_to_message: { message_id: 3000 },
  });
  ok('expired prompt NOT handled',  handled === false);
  ok('expired prompt cleaned up',    !_savePromptIds.has(555));

  // Message to a chat with NO pending prompt
  handled = await handleSaveReplyIfPresent(bot, {
    chat: { id: 12345, type: 'private' },
    from: { id: 12345 },
    text: 'whatever',
  });
  ok('no pending prompt returns false', handled === false);

  // Cleanup
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\ncallbacks: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
