'use strict';

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が未設定です`);
  return v;
};

module.exports = {
  port: Number(process.env.PORT || 3000),
  authToken: required('API_TOKEN'),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  claudeArgs: (process.env.CLAUDE_ARGS || '').split(' ').filter(Boolean),
  workDir: process.env.WORK_DIR || process.cwd(),
  queueDir: process.env.QUEUE_DIR || './queue', // pending/ done/ failed/ を配下に作る
  timeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS || 10 * 60 * 1000),
  maxBodyBytes: 1024 * 1024,
  github: {
    token: required('GITHUB_TOKEN'),
    repo: required('GITHUB_REPO'), // owner/name
    branch: process.env.GITHUB_BRANCH || 'main',
    dir: process.env.GITHUB_RESULTS_DIR || 'results',
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  },
};
