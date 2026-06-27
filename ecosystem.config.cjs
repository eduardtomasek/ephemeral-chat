module.exports = {
  apps: [
    {
      name: 'ephemeral-chat',
      cwd: __dirname,
      script: 'dist/src/cli.js',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '250M',
      listen_timeout: 8000,
      kill_timeout: 5000,
      time: true
    }
  ]
};
