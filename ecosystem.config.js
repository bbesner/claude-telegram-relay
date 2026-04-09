module.exports = {
  apps: [{
    name: 'claude-telegram-relay',
    script: 'bot.js',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
    },
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    max_memory_restart: '200M',
  }],
};
