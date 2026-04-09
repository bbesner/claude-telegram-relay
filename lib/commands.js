const { clearSession, getSession, getUserModel, setUserModel } = require('./session-manager');
const log = require('./logger');

const startTime = Date.now();

/**
 * Pass-through commands — these get forwarded to Claude Code as prompts.
 * The key is the command name, the value is a function that builds the prompt.
 */
const PASSTHROUGH_COMMANDS = {
  status: () => 'Show full server status: PM2 services, disk usage, memory usage, and gateway health.',
  logs: (args) => {
    if (!args) return 'Show recent PM2 logs. Ask which service I want to see logs for.';
    return `Show recent logs for the "${args}" PM2 service. Use: pm2 logs ${args} --lines 50 --nostream`;
  },
  restart: (args) => {
    if (!args) return 'Ask which PM2 service I want to restart, and list the available services.';
    return `Restart the "${args}" PM2 service using pm2 restart. Confirm the result.`;
  },
  deploy: (args) => {
    if (!args) return 'Ask which site I want to deploy, and list the available sites.';
    return `Deploy the "${args}" site. Follow the deploy skill if one exists.`;
  },
};

/**
 * Check if a message is a pass-through command.
 * Returns { prompt } if it is, null if not.
 */
function getPassthroughPrompt(text) {
  if (!text || !text.startsWith('/')) return null;

  const parts = text.split(/\s+/);
  const cmd = parts[0].replace('/', '').replace(/@\w+$/, '').toLowerCase();
  const args = parts.slice(1).join(' ').trim() || null;

  if (PASSTHROUGH_COMMANDS[cmd]) {
    return { prompt: PASSTHROUGH_COMMANDS[cmd](args) };
  }
  return null;
}

function registerCommands(bot) {
  bot.onText(/\/start/, (msg) => {
    const text = [
      '<b>Claude Code Relay</b>',
      '',
      'Send me a message and I\'ll relay it to Claude Code CLI.',
      '',
      '<b>Bot Commands:</b>',
      '/new — Start a fresh conversation',
      '/info — Show current session info',
      '/model — Show or set model (e.g. /model sonnet)',
      '/help — Show this message',
      '',
      '<b>Server Commands</b> (run via Claude Code):',
      '/status — Full server status (PM2, disk, memory, gateways)',
      '/logs [service] — Show recent logs for a service',
      '/restart [service] — Restart a PM2 service',
      '/deploy [site] — Deploy a site via SSH',
      '',
      'You can also send photos, PDFs, and files — Claude will analyze them.',
    ].join('\n');
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  });

  bot.onText(/\/help/, (msg) => {
    const text = [
      '<b>Available Commands</b>',
      '',
      '<b>Bot Commands</b> (instant, no AI):',
      '/start — Welcome message',
      '/new — Clear session, start fresh conversation',
      '/info — Current session ID, message count, uptime',
      '/model — Show current model',
      '/model &lt;name&gt; — Set model (e.g. sonnet, opus, haiku)',
      '/model default — Reset to default model',
      '/help — This message',
      '',
      '<b>Server Commands</b> (passed to Claude Code):',
      '/status — Full server status (PM2, disk, memory, gateways)',
      '/logs &lt;service&gt; — Recent logs for a PM2 service',
      '/restart &lt;service&gt; — Restart a PM2 service',
      '/deploy &lt;site&gt; — Deploy a site via SSH',
      '',
      '<b>Media Support</b>',
      'Send photos, screenshots, PDFs, or files and Claude will read/analyze them.',
      'When Claude creates files, they\'re automatically sent back to you.',
    ].join('\n');
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
  });

  bot.onText(/\/new/, (msg) => {
    clearSession(msg);
    bot.sendMessage(msg.chat.id, 'Session cleared. Next message starts a fresh conversation.');
    log.info('/new command', { chatId: msg.chat.id, userId: msg.from.id });
  });

  bot.onText(/\/info/, (msg) => {
    const session = getSession(msg);
    const uptimeMs = Date.now() - startTime;
    const uptimeMin = Math.floor(uptimeMs / 60000);
    const uptimeHr = Math.floor(uptimeMin / 60);

    const lines = ['<b>Session Info</b>', ''];
    if (session?.sessionId) {
      lines.push(`Session: <code>${session.sessionId.slice(0, 8)}...</code>`);
      lines.push(`Messages: ${session.messageCount || 0}`);
      lines.push(`Started: ${session.startedAt || 'unknown'}`);
    } else {
      lines.push('No active session');
    }

    const model = getUserModel(msg);
    lines.push(`Model: ${model || 'default'}`);
    lines.push(`Uptime: ${uptimeHr}h ${uptimeMin % 60}m`);

    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.onText(/\/model(?:\s+(.+))?/, (msg, match) => {
    const newModel = match[1]?.trim();
    if (!newModel) {
      const current = getUserModel(msg);
      bot.sendMessage(msg.chat.id, `Current model: <b>${current || 'default'}</b>`, { parse_mode: 'HTML' });
      return;
    }
    if (newModel === 'default' || newModel === 'reset') {
      setUserModel(msg, null);
      bot.sendMessage(msg.chat.id, 'Model reset to default.');
    } else {
      setUserModel(msg, newModel);
      bot.sendMessage(msg.chat.id, `Model set to <b>${newModel}</b>`, { parse_mode: 'HTML' });
    }
    log.info('/model command', { chatId: msg.chat.id, model: newModel });
  });
}

module.exports = { registerCommands, getPassthroughPrompt };
