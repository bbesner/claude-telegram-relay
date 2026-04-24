// End-to-end test of lib/commands.js via a mock bot. Uses a hermetic fixture
// HOME so /sessions and /resume <partial> resolve against known sessions.
const fs = require('fs');
const { createFixtureHome, cleanupFixtureHome, IDS } = require('./fixtures');

const fx = createFixtureHome();
process.env.HOME = fx.home;
process.env.LOG_LEVEL = 'warn';

const { registerCommands, getPassthroughPrompt } = require('../lib/commands');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

// ---- getPassthroughPrompt ----
console.log('\n=== getPassthroughPrompt ===');
ok('/status returns prompt',                     getPassthroughPrompt('/status')?.prompt.includes('server status'));
ok('/logs ari returns ari-specific prompt',      getPassthroughPrompt('/logs ari')?.prompt.includes('"ari"'));
ok('/logs (no args) returns ask-which prompt',   getPassthroughPrompt('/logs')?.prompt.includes('Ask which'));
ok('/restart fleet-gateway',                     getPassthroughPrompt('/restart fleet-gateway')?.prompt.includes('fleet-gateway'));
ok('/deploy mysite',                             getPassthroughPrompt('/deploy mysite')?.prompt.includes('"mysite"'));
ok('/status@BotName strips suffix',              getPassthroughPrompt('/status@MyBot')?.prompt.includes('server status'));
ok('STATUS uppercase works',                     getPassthroughPrompt('/STATUS')?.prompt.includes('server status'));
ok('/new returns null (not passthrough)',        getPassthroughPrompt('/new') === null);
ok('/sessions returns null (not passthrough)',   getPassthroughPrompt('/sessions') === null);
ok('/resume returns null (not passthrough)',     getPassthroughPrompt('/resume 3') === null);
ok('/save returns null (not passthrough)',       getPassthroughPrompt('/save foo') === null);
ok('plain text returns null',                    getPassthroughPrompt('hello world') === null);

// ---- Mock bot ----
console.log('\n=== Mock bot: command handlers ===');
const onText = [];
const sent   = [];

const mockBot = {
  onText: (regex, handler) => onText.push({ regex, handler }),
  sendMessage: (chatId, text, opts) => { sent.push({ chatId, text, opts }); return Promise.resolve(); },
  sendChatAction: () => Promise.resolve(),
};

registerCommands(mockBot);
ok('registered at least 8 handlers', onText.length >= 8);

function dm(userId) { return { chat: { id: userId, type: 'private' }, from: { id: userId } }; }

async function fire(text, userId = 500) {
  const msg = dm(userId);
  msg.text = text;
  const before = sent.length;
  for (const { regex, handler } of onText) {
    const m = text.match(regex);
    if (m) await handler(msg, m);
  }
  return sent.slice(before);
}

const sm = require('../lib/session-manager');

(async () => {
  let out;

  // ---- /start ----
  out = await fire('/start');
  ok('/start sends welcome', out.some(r => r.text.includes('Claude Code Relay') && r.text.includes('/sessions')));

  // ---- /help ----
  out = await fire('/help');
  ok('/help lists /resume by id', out.some(r => r.text.includes('/resume &lt;session-id&gt;')));
  ok('/help lists /save',         out.some(r => r.text.includes('/save')));

  // ---- /info with no session ----
  out = await fire('/info');
  ok('/info no session shows "No active session"',
     out.some(r => r.text.includes('No active session')));

  // ---- /info with session ----
  sm.setSession(dm(500), 'abcd1234-ab12-ab12-ab12-abcdef123456');
  out = await fire('/info');
  ok('/info shows full session ID', out.some(r => r.text.includes('abcd1234-ab12-ab12-ab12-abcdef123456')));
  ok('/info shows Model line',      out.some(r => r.text.includes('Model:')));

  // ---- /save ----
  out = await fire('/save twilio-fix');
  ok('/save sends label confirmation', out.some(r => r.text.includes('<b>twilio-fix</b>')));

  out = await fire('/save');
  ok('/save no arg shows usage', out.some(r => r.text.includes('Usage')));

  out = await fire('/save foo', 600);
  ok('/save with no active session returns helpful error',
     out.some(r => r.text.includes('No active session to label')));

  // ---- /resume no arg ----
  out = await fire('/resume');
  ok('/resume no arg shows usage', out.some(r => r.text.includes('Usage')));

  // ---- /resume <label> ----
  out = await fire('/resume twilio-fix');
  ok('/resume <label> resolves',
     out.some(r => r.text.includes('abcd1234-ab12-ab12-ab12-abcdef123456')
                && r.text.includes('label "twilio-fix"')));
  ok('/resume label switches active session',
     sm.getSession(dm(500))?.sessionId === 'abcd1234-ab12-ab12-ab12-abcdef123456');

  // ---- /resume <full UUID> ----
  out = await fire('/resume deadbeef-1111-2222-3333-444455556666');
  ok('/resume full UUID accepted',
     out.some(r => r.text.includes('deadbeef-1111-2222-3333-444455556666')
                && r.text.includes('full session ID')));

  // ---- /resume <bogus> ----
  out = await fire('/resume notarealsession');
  ok('/resume bogus -> could not find',
     out.some(r => r.text.includes('Could not find a session matching')));

  // ---- /resume <partial UUID> — against the fixture sessions ----
  const prefix = IDS.A.slice(0, 10);
  out = await fire(`/resume ${prefix}`);
  ok('/resume <partial>: resolves against fixture session A',
     out.some(r => r.text.includes(IDS.A) && r.text.includes('partial ID prefix')));

  // ---- /sessions ----
  out = await fire('/sessions');
  ok('/sessions returns listing header',
     out.some(r => r.text.includes('Recent Claude Code Sessions')));
  ok('/sessions mentions fixture session A',
     out.some(r => r.text.includes(IDS.A.slice(0, 8))));

  // Verify _lastListing was populated
  const first = sm.getSessionFromListing(dm(500), 1);
  ok('/sessions populated _lastListing with session A',
     first === IDS.A, `got ${first}`);

  // ---- /resume 1 (from the listing we just populated) ----
  out = await fire('/resume 1');
  ok('/resume 1 resolves from listing',
     out.some(r => r.text.includes(IDS.A) && r.text.includes('from last /sessions list')));

  // ---- /resume 99 ----
  out = await fire('/resume 99');
  ok('/resume 99 -> could not find',
     out.some(r => r.text.includes('Could not find a session matching')));

  // ---- v1.6.0: /info enrichment ----
  // Seed the state with a degraded session + cost to exercise the new fields.
  sm.setSession(dm(500), 'abcd1234-ab12-ab12-ab12-abcdef123456');
  sm.markSessionError(dm(500), 'previous resume failed at boot', { kind: 'resume-failed' });
  sm.recordCost(dm(500), 0.0123);
  out = await fire('/info');
  ok('/info shows Status line',
     out.some(r => /Status: /.test(r.text)));
  ok('/info shows degraded status',
     out.some(r => r.text.includes('degraded')));
  ok('/info shows Last error',
     out.some(r => r.text.includes('Last error') && r.text.includes('previous resume failed')));
  ok('/info shows Last resume failure timestamp',
     out.some(r => r.text.includes('Last resume failure:')));
  ok('/info shows cost fields',
     out.some(r => r.text.includes('Last turn cost: $0.0123')));

  // ---- v1.6.0: /cost ----
  out = await fire('/cost');
  ok('/cost shows last-turn and session-total lines',
     out.some(r => r.text.includes('Last turn: $0.0123') && r.text.includes('Session total:')));

  out = await fire('/cost', 9001);
  ok('/cost on fresh user says no active session',
     out.some(r => r.text.includes('No active session')));

  // ---- v1.6.0: /interrupt with nothing running ----
  out = await fire('/interrupt');
  ok('/interrupt with nothing running says so',
     out.some(r => r.text.includes('No active Claude job')));
  out = await fire('/stop');
  ok('/stop alias also works',
     out.some(r => r.text.includes('No active Claude job')));
  out = await fire('/cancel');
  ok('/cancel alias also works',
     out.some(r => r.text.includes('No active Claude job')));

  // ---- /new ----
  out = await fire('/new');
  ok('/new confirmation',           out.some(r => r.text.includes('Session cleared')));
  ok('/new actually cleared state', sm.getSession(dm(500)) === null);

  // ---- /model ----
  out = await fire('/model');
  ok('/model shows current (default)', out.some(r => r.text.includes('default')));
  out = await fire('/model sonnet');
  ok('/model sonnet sets model',        out.some(r => r.text.includes('sonnet')));
  ok('model persists to state',         sm.getUserModel(dm(500)) === 'sonnet');
  out = await fire('/model default');
  ok('/model default resets',           out.some(r => r.text.includes('reset to default')));
  ok('model cleared to null',           sm.getUserModel(dm(500)) === null);

  console.log(`\ncommands: ${pass} passed, ${fail} failed`);
  cleanupFixtureHome(fx);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('UNCAUGHT', e);
  cleanupFixtureHome(fx);
  process.exit(1);
});
