'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('./helpers');

test('scripts/github-push.sh: _target.json の送信先検証、新規は PUT、変更なしはスキップ、既存は sha 付きで更新', async () => {
  const tmp = tmpdir();
  const outbox = path.join(tmp, 'outbox'); fs.mkdirSync(path.join(outbox, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(outbox, '_target.json'), JSON.stringify({ repo: 'o/r', branch: 'main', dir: 'data' }));
  fs.writeFileSync(path.join(outbox, 'new.json'), '{"a":1}\n');
  fs.writeFileSync(path.join(outbox, 'sub/日本語 file.md'), 'hello\n');
  fs.writeFileSync(path.join(outbox, 'same.txt'), 'same\n');
  fs.writeFileSync(path.join(outbox, 'changed.txt'), 'new body\n');
  const blob = (s) => spawnSync('git', ['hash-object', '--stdin'], { input: s }).stdout.toString().trim();

  const puts = []; const refs = []; let created = false;
  const gh = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      assert.strictEqual(req.headers.authorization, 'Bearer TKN');
      const p = decodeURIComponent(req.url.split('?')[0]);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && p === '/repos/o/r') return res.end(JSON.stringify({ default_branch: 'main' }));
      if (req.method === 'GET' && p.startsWith('/repos/o/r/git/ref/heads/')) {
        const br = p.replace('/repos/o/r/git/ref/heads/', '');
        if (br === 'main' || (br === 'inbox/2026-10-05' && created)) return res.end(JSON.stringify({ object: { sha: 'BASESHA' } }));
        res.statusCode = 404; return res.end('{}');
      }
      if (req.method === 'POST' && p === '/repos/o/r/git/refs') { refs.push(JSON.parse(b)); created = true; res.statusCode = 201; return res.end('{}'); }
      if (req.method === 'GET') {
        if (p.endsWith('/data/same.txt')) return res.end(JSON.stringify({ sha: blob('same\n') }));
        if (p.endsWith('/data/changed.txt')) return res.end(JSON.stringify({ sha: 'OLDSHA' }));
        res.statusCode = 404; return res.end('{}');
      }
      puts.push({ p, body: JSON.parse(b) });
      res.statusCode = 201; res.end('{}');
    });
  }).listen(0);
  await new Promise((r) => gh.once('listening', r));

  const run = (extra = {}) => new Promise((resolve) => {
    require('node:child_process').execFile(path.join(__dirname, '../scripts/github-push.sh'), [], {
      env: { ...process.env, OUTBOX_DIR: outbox, PROJECT_NAME: 'mj', GH_TOKEN_VAR: 'MYTKN', MYTKN: 'TKN', GH_ALLOWED_REPOS: 'o/*', GITHUB_API_URL: `http://127.0.0.1:${gh.address().port}`, ...extra },
    }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
  // 許可外のリポジトリ・不正な値は何も送らず失敗する
  const n0 = puts.length;
  assert.ok((await run({ GH_ALLOWED_REPOS: 'other/*' })).err, '許可外 repo は拒否');
  const bad = (t) => { fs.writeFileSync(path.join(outbox, '_target.json'), JSON.stringify(t)); return run(); };
  assert.ok((await bad({ repo: 'o/r', dir: '../etc' })).err, 'dir の .. は拒否');
  assert.ok((await bad({ repo: 'o/r', dir: '/abs' })).err, '絶対パスは拒否');
  assert.ok((await bad({ repo: 'o/r x' })).err, '不正な repo は拒否');
  assert.ok((await bad({ dir: 'd' })).err, 'repo なしは拒否');
  assert.strictEqual(puts.length, n0);
  fs.writeFileSync(path.join(outbox, '_target.json'), JSON.stringify({ repo: 'o/r', branch: 'main', dir: 'data' }));

  const r = await run();

  // 存在しないブランチは、既定ブランチ(base)から自動で作ってから書き込む
  fs.writeFileSync(path.join(outbox, '_target.json'), JSON.stringify({ repo: 'o/r', branch: 'inbox/2026-10-05', dir: 'data' }));
  const nPuts = puts.length;
  const r2 = await run();
  gh.close();
  assert.ifError(r2.err && Object.assign(r2.err, { message: r2.stderr }));
  assert.deepStrictEqual(refs, [{ ref: 'refs/heads/inbox/2026-10-05', sha: 'BASESHA' }]);
  assert.match(r2.stdout, /created branch: o\/r@inbox\/2026-10-05 \(from main\)/);
  assert.ok(puts.slice(nPuts).length > 0 && puts.slice(nPuts).every((x) => x.body.branch === 'inbox/2026-10-05'));
  puts.length = nPuts;
  assert.ifError(r.err && Object.assign(r.err, { message: r.stderr }));
  const byPath = Object.fromEntries(puts.map((x) => [x.p.replace('/repos/o/r/contents/', ''), x.body]));
  assert.deepStrictEqual(Object.keys(byPath).sort(), ['data/changed.txt', 'data/new.json', 'data/sub/日本語 file.md'], '_target.json は送らない');
  assert.strictEqual(byPath['data/changed.txt'].sha, 'OLDSHA');
  assert.strictEqual(byPath['data/new.json'].sha, undefined);
  assert.strictEqual(byPath['data/new.json'].branch, 'main');
  assert.strictEqual(Buffer.from(byPath['data/new.json'].content, 'base64').toString(), '{"a":1}\n');
  assert.match(r.stdout, /unchanged: o\/r\/data\/same.txt/);
});
