'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('POST /run -> claude 実行 -> ファイル保存 -> GitHub API push', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
  const fakeClaude = path.join(tmp, 'claude');
  fs.writeFileSync(fakeClaude, '#!/bin/sh\nread p; echo "{\\"result\\":\\"echo: $p\\"}"\n', { mode: 0o755 });

  const puts = [];
  const gh = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.method === 'PUT') puts.push({ url: req.url, body: JSON.parse(b) });
      if (req.method === 'GET') { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ commit: { sha: 'abc' }, content: { html_url: 'http://x' } }));
    });
  }).listen(0);
  await new Promise((r) => gh.once('listening', r));

  Object.assign(process.env, {
    API_TOKEN: 't', GITHUB_TOKEN: 'g', GITHUB_REPO: 'o/r', PORT: '0',
    GITHUB_API_URL: `http://127.0.0.1:${gh.address().port}`,
    CLAUDE_BIN: fakeClaude, QUEUE_DIR: path.join(tmp, 'queue'),
  });
  const { server, listen } = require('../src/server');
  listen();
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { Authorization: 'Bearer t', 'Content-Type': 'application/json' };

  assert.strictEqual((await fetch(`${base}/run`, { method: 'POST' })).status, 401);
  const r = await fetch(`${base}/run`, { method: 'POST', headers: H, body: JSON.stringify({ prompt: 'hello' }) });
  assert.strictEqual(r.status, 202);
  const { id } = await r.json();

  const q = path.join(tmp, 'queue');
  let job;
  for (let i = 0; i < 50; i++) {
    job = await (await fetch(`${base}/jobs/${id}`, { headers: H })).json();
    if (job.status === 'done' && job.github) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.strictEqual(job.status, 'done', JSON.stringify(job));
  assert.match(fs.readFileSync(path.join(q, 'done', `${id}.md`), 'utf8'), /echo: hello/);
  assert.deepStrictEqual(fs.readdirSync(path.join(q, 'pending')), []); // 未実施は空
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual((await (await fetch(`${base}/healthz`)).json()).workerRunning, false); // 空で停止
  assert.strictEqual(puts.length, 1);
  assert.match(Buffer.from(puts[0].body.content, 'base64').toString(), /echo: hello/);

  server.closeAllConnections(); server.close(); gh.closeAllConnections(); gh.close();
});
