module.exports = {
  apps: [{
    name: 'qqbot',
    script: 'src/index.ts',
    interpreter: '/usr/local/bin/bun',
    cwd: '/home/ubuntu/Magent/claudeqqbot',
    max_restarts: 20,
    restart_delay: 5000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/home/ubuntu/Magent/claudeqqbot/logs/error.log',
    out_file: '/home/ubuntu/Magent/claudeqqbot/logs/out.log',
    merge_logs: true,
  }, {
    name: 'progress',
    script: 'tools/progress_server.cjs',
    interpreter: '/usr/local/bin/node',
    cwd: '/home/ubuntu/Magent/claudeqqbot',
    max_restarts: 10,
    restart_delay: 3000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/home/ubuntu/Magent/claudeqqbot/logs/progress-error.log',
    out_file: '/home/ubuntu/Magent/claudeqqbot/logs/progress-out.log',
    merge_logs: true,
  }]
}
