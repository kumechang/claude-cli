'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 最小の偽 SMTP サーバー(平文)。受信したメール(DATA)を配列に溜める。
function fakeSmtp(mails) {
  return net.createServer((s) => {
    let data = null;
    let buf = '';
    s.write('220 fake\r\n');
    s.on('data', (d) => {
      buf += d;
      for (;;) {
        if (data !== null) {
          const i = buf.indexOf('\r\n.\r\n');
          if (i < 0) return;
          mails.push(data + buf.slice(0, i));
          data = null; buf = buf.slice(i + 5);
          s.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO/.test(line)) s.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH/.test(line)) s.write('235 ok\r\n');
        else if (/^DATA/.test(line)) { data = ''; s.write('354 go\r\n'); }
        else if (/^QUIT/.test(line)) s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
  });
}

test('認証切れ → 管理者メール(1回だけ) → ジョブは pending に保留 → 復旧メールで再開', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'));
  const flag = path.join(tmp, 'broken');
  fs.writeFileSync(flag, '');
  const fakeClaude = path.join(tmp, 'claude');
  fs.writeFileSync(fakeClaude,
    `#!/bin/sh\nread p\nif [ -f ${flag} ]; then echo "Invalid API key · Please run /login" >&2; exit 1; fi\necho '{"result":"ok"}'\n`,
    { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({ projects: { alpha: { workDir: tmp, handlers: [] } } }));

  const mails = [];
  const smtp = fakeSmtp(mails).listen(0);
  await new Promise((r) => smtp.once('listening', r));
  Object.assign(process.env, {
    API_TOKEN: 't', PORT: '0', PROJECTS_FILE: path.join(tmp, 'projects.json'), CLAUDE_BIN: fakeClaude,
    QUEUE_DIR: path.join(tmp, 'queue'), HEALTHCHECK_INTERVAL_MS: '300',
    ADMIN_EMAIL: 'admin@example.com', MAIL_FROM: 'bot@example.com',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_STARTTLS: 'false', SMTP_USER: 'u', SMTP_PASS: 'p',
  });
  const { server, listen } = require('../src/server');
  listen();
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { Authorization: 'Bearer t', 'Content-Type': 'application/json' };
  const wait = async (fn) => { for (let i = 0; i < 60 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 100)); };
  const subject = (m) => Buffer.from(m.match(/Subject: =\?UTF-8\?B\?(.+?)\?=/)[1], 'base64').toString();

  await wait(() => mails.length >= 1);
  assert.match(subject(mails[0]), /認証が切れています/);
  assert.strictEqual((await (await fetch(`${base}/healthz`)).json()).claude.kind, 'auth');

  // 認証切れ中に届いたプロンプトは実行されず pending に残る
  const { id } = await (await fetch(`${base}/projects/alpha/run`, { method: 'POST', headers: H, body: '{"prompt":"hi"}' })).json();
  await new Promise((r) => setTimeout(r, 1000)); // 数回のチェックを跨いでも
  assert.strictEqual(mails.length, 1, '異常継続中に通知が連発されない');
  assert.ok(fs.existsSync(path.join(tmp, 'queue/alpha/pending', `${id}.md`)));
  assert.ok(!fs.existsSync(path.join(tmp, 'queue/alpha/failed', `${id}.md`)));

  // 復旧 → 復旧メール + 保留ジョブが自動実行される
  fs.unlinkSync(flag);
  await wait(() => fs.existsSync(path.join(tmp, 'queue/alpha/done', `${id}.md`)));
  assert.ok(fs.existsSync(path.join(tmp, 'queue/alpha/done', `${id}.md`)));
  await wait(() => mails.length >= 2);
  assert.match(subject(mails[1]), /復旧しました/);

  require('../src/health').stop();
  server.closeAllConnections(); server.close(); smtp.close();
});
