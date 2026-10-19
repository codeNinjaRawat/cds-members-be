// pm2: the API and the worker on the server (same code, two processes).
//   cd membership/BE && pm2 start deploy/ecosystem.config.cjs && pm2 save
// Settings: BE/.env.production when it exists (--env=production), otherwise BE/.env (deploy/SERVER.md's first, staging
// setup). Read by src/load-env.ts; nothing secret is in this file.
const { existsSync } = require('node:fs');
const profile = existsSync(__dirname + '/../.env.production') ? '--env=production' : '';
module.exports = {
  apps: [
    {
      name: 'membership-api',
      cwd: __dirname + '/..',
      script: 'src/http/server.ts',
      exec_mode: 'fork',            // never cluster: cluster mode drops the tsx loader and the .ts files cannot run
      interpreter: 'node',
      interpreter_args: '--import tsx --import ./src/load-env.ts',
      node_args: '--import tsx --import ./src/load-env.ts',
      args: profile,
      env: { NODE_ENV: 'production' },
      instances: 1,                 // one process (MEMBERS_CACHE_SECONDS assumes one); scale later with a shared cache
      max_memory_restart: '700M',
      kill_timeout: 12000,          // the API finishes open requests on SIGTERM (10 s at most)
      time: true,
      out_file: '../logs/api.out.log', error_file: '../logs/api.err.log', merge_logs: true,
    },
    {
      name: 'membership-worker',
      cwd: __dirname + '/..',
      script: 'src/jobs/worker.ts',
      exec_mode: 'fork',
      interpreter: 'node',
      interpreter_args: '--import tsx --import ./src/load-env.ts',
      node_args: '--import tsx --import ./src/load-env.ts',
      args: profile,
      env: { NODE_ENV: 'production' },
      instances: 1,
      max_memory_restart: '400M',
      kill_timeout: 60000,          // let a running batch of emails finish
      time: true,
      out_file: '../logs/worker.out.log', error_file: '../logs/worker.err.log', merge_logs: true,
    },
  ],
};
