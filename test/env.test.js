'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir, fakeClaude } = require('./helpers');

test('claude にはサーバーの秘密情報・API キーを渡さない', async () => {
  const tmp = tmpdir();
  const out = path.join(tmp, 'env.txt');
  Object.assign(process.env, { API_TOKEN: 'SECRET1', SMTP_PASS: 'SECRET2', GITHUB_TOKEN_X: 'SECRET3', ANTHROPIC_API_KEY: 'SECRET4', CLAUDE_CODE_OAUTH_TOKEN: 'OK_TOKEN', PROJECTS_FILE: path.join(tmp, 'p.json') });
  fs.writeFileSync(process.env.PROJECTS_FILE, '{"projects":{"a":{}}}');
  const claude = fakeClaude(tmp, `env > ${out}; echo '{"result":"x"}'`);
  const { runClaude } = require('../src/claude');
  await runClaude('hi', { bin: claude, args: [], cwd: tmp, timeoutMs: 5000 });
  const env = fs.readFileSync(out, 'utf8');
  assert.ok(!/SECRET\d/.test(env), '秘密情報が漏れている');
  assert.match(env, /CLAUDE_CODE_OAUTH_TOKEN=OK_TOKEN/);
});
