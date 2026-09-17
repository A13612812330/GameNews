module.exports = {
  apps: [{
    name: "gamenews-api",
    script: "server/index.js",
    env: {
      GAME_NEWS_API_PORT: 64424,
      NODE_ENV: "production",
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "logs/gamenews-error.log",
    out_file: "logs/gamenews-out.log",
    merge_logs: true,
  }],
};
