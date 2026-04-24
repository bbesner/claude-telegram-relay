// v1.7.0: unit test for lib/stream-renderer.js. Uses a mock bot that
// records every sendMessage/editMessageText call. Verifies:
//   - renderer sends exactly one seed, edits it as events arrive
//   - consecutive edits are throttled/coalesced
//   - finalize replaces the seed with the final response text
//   - finalizeError replaces the seed with error HTML
//   - long responses spill into additional messages (chunking)
process.env.LOG_LEVEL = 'warn';

const { createRenderer, summarizeTool, toolIcon } = require('../lib/stream-renderer');

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { console.log('PASS', label); pass++; }
  else      { console.log('FAIL', label, extra || ''); fail++; }
}

function mockBot() {
  const sends = [], edits = [];
  let nextId = 1000;
  return {
    sends, edits,
    sendMessage: async (chatId, text, opts) => {
      const id = nextId++;
      sends.push({ chatId, text, opts, id });
      return { message_id: id };
    },
    editMessageText: async (text, opts) => {
      edits.push({ text, opts });
      return { message_id: opts.message_id };
    },
  };
}

(async () => {
  // ---- 1: seed, tool_use, final -> one seed, edits, final replacement ----
  {
    const bot = mockBot();
    const r = createRenderer(bot, 999, { replyTo: 1, minEditMs: 0 });
    r.onEvent({ kind: 'init', sessionId: 'abcdef12-3456-7890-abcd-ef1234567890' });
    await new Promise(res => setTimeout(res, 10));
    ok('sends exactly 1 seed on init',
       bot.sends.length === 1, `got ${bot.sends.length}`);
    ok('seed uses HTML parse_mode',
       bot.sends[0].opts.parse_mode === 'HTML');
    ok('seed replies to original msg id',
       bot.sends[0].opts.reply_to_message_id === 1);
    ok('seed contains session short id',
       bot.sends[0].text.includes('abcdef12'));

    r.onEvent({ kind: 'tool_use', toolName: 'Read', toolInput: { file_path: '/a/b/c.js' } });
    await new Promise(res => setTimeout(res, 40));
    ok('edit fired for tool_use',
       bot.edits.length >= 1);
    ok('edit mentions tool name Read',
       bot.edits.some(e => e.text.includes('Read')));
    ok('edit mentions file path',
       bot.edits.some(e => e.text.includes('/a/b/c.js')));

    r.onEvent({ kind: 'final', text: 'done', cost: 0.01 });
    const result = await r.finalize({ text: 'Here is the final answer.' });
    ok('finalize returns seed message id',
       result.firstMessageId === 1000);
    ok('finalize produces 0 extra chunks for short text',
       result.extraChunksSent === 0);
    const lastEdit = bot.edits[bot.edits.length - 1];
    ok('final edit contains the answer text',
       lastEdit.text.includes('Here is the final answer'));
    ok('still only 1 send total (seed) — finalize edited in place',
       bot.sends.length === 1, `got ${bot.sends.length}`);
  }

  // ---- 2: throttling coalesces rapid-fire events ----
  {
    const bot = mockBot();
    const r = createRenderer(bot, 999, { minEditMs: 200 });
    r.onEvent({ kind: 'init', sessionId: 'abcdef12-3456-7890-abcd-ef1234567890' });
    await new Promise(res => setTimeout(res, 20));
    // Fire a burst of 10 distinct phase changes in ~30ms
    for (let i = 0; i < 10; i++) {
      r.onEvent({ kind: 'tool_use', toolName: 'Bash', toolInput: { command: `echo ${i}` } });
      await new Promise(res => setTimeout(res, 3));
    }
    await new Promise(res => setTimeout(res, 400));
    ok('throttling coalesces — no more than 3 edits despite 10 events',
       bot.edits.length <= 3, `edits=${bot.edits.length}`);
  }

  // ---- 3: finalize with long text -> spills into multiple messages ----
  {
    const bot = mockBot();
    const r = createRenderer(bot, 999, { minEditMs: 0 });
    r.onEvent({ kind: 'init', sessionId: 'abcdef12-3456-7890-abcd-ef1234567890' });
    await new Promise(res => setTimeout(res, 10));
    const huge = 'line\n'.repeat(1500); // ~7500 chars, should chunk
    const result = await r.finalize({ text: huge });
    ok('chunking — first message is the seed (edited)',  bot.sends.length >= 1);
    ok('chunking produces at least 1 extra chunk for 7500-char text',
       result.extraChunksSent >= 1, `extras=${result.extraChunksSent}`);
  }

  // ---- 4: finalizeError replaces seed with explanation ----
  {
    const bot = mockBot();
    const r = createRenderer(bot, 999, { minEditMs: 0 });
    r.onEvent({ kind: 'init', sessionId: 'abcdef12-3456-7890-abcd-ef1234567890' });
    await new Promise(res => setTimeout(res, 10));
    await r.finalizeError('⏹ <b>Cancelled.</b>');
    const lastEdit = bot.edits[bot.edits.length - 1];
    ok('finalizeError triggers an edit',              bot.edits.length >= 1);
    ok('edit contains the error html',                lastEdit.text.includes('Cancelled'));
    ok('no duplicate seed — still 1 send',            bot.sends.length === 1);
  }

  // ---- 5: summarizeTool / toolIcon sanity ----
  ok('summarizeTool Read shows file path',
     summarizeTool('Read', { file_path: '/a.txt' }).includes('/a.txt'));
  ok('summarizeTool Bash shows first command line only',
     summarizeTool('Bash', { command: 'echo hi\nls /\ncat foo' }).includes('echo hi')
     && !summarizeTool('Bash', { command: 'echo hi\nls /' }).includes('ls /'));
  ok('summarizeTool Bash escapes HTML',
     summarizeTool('Bash', { command: '<script>' }).includes('&lt;script&gt;'));
  ok('toolIcon known tool',   toolIcon('Read') === '📖');
  ok('toolIcon unknown tool fallback', toolIcon('Frobnicate') === '🔧');

  console.log(`\nstream-renderer: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('UNCAUGHT', e);
  process.exit(1);
});
