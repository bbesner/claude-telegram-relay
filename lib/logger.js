const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

function log(level, msg, data) {
  if (LEVELS[level] < currentLevel) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(data && { data })
  };
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(entry) + '\n');
}

module.exports = {
  debug: (msg, data) => log('debug', msg, data),
  info: (msg, data) => log('info', msg, data),
  warn: (msg, data) => log('warn', msg, data),
  error: (msg, data) => log('error', msg, data),
};
