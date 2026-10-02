'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { tmpdir } = require('./helpers');

// Gmail (smtp.gmail.com:587) と同じ STARTTLS + AUTH PLAIN の流れを、自己署名証明書のローカルサーバーで検証する
test('SMTP: STARTTLS で暗号化してから AUTH PLAIN し、メールを送れる', async () => {
  const tmp = tmpdir();
  const key = path.join(tmp, 'k.pem'); const crt = path.join(tmp, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const seen = []; let mail = ''; let authedOverTls = false;

  const server = net.createServer((raw) => {
    let sock = raw; let buf = ''; let data = null;
    const on = (s) => s.on('data', (d) => {
      buf += d;
      for (;;) {
        if (data !== null) { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; mail = data + buf.slice(0, i); data = null; buf = buf.slice(i + 5); sock.write('250 ok\r\n'); continue; }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2); seen.push(line);
        if (/^EHLO/.test(line)) sock.write(sock === raw ? '250-fake\r\n250-STARTTLS\r\n250 8BITMIME\r\n' : '250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^STARTTLS/.test(line)) {
          sock.write('220 go\r\n'); buf = '';
          const t = new tls.TLSSocket(raw, { isServer: true, key: fs.readFileSync(key), cert: fs.readFileSync(crt) });
          sock = t; on(t);
        } else if (/^AUTH PLAIN/.test(line)) { authedOverTls = sock !== raw; sock.write(sock === raw ? '530 must STARTTLS\r\n' : '235 ok\r\n'); }
        else if (/^DATA/.test(line)) { data = ''; sock.write('354 go\r\n'); }
        else if (/^QUIT/.test(line)) sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
    raw.write('220 fake\r\n'); on(raw);
  }).listen(0);
  await new Promise((r) => server.once('listening', r));

  // 自己署名 CA を信頼させるため NODE_EXTRA_CA_CERTS を付けた別プロセスで送信
  const script = `require('${path.join(__dirname, '../src/mailer')}').sendMail({to:'a@x.com',subject:'テスト件名',text:'本文 ✓'}).then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})`;
  const r = await new Promise((resolve) => execFile(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: crt, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.address().port), SMTP_USER: 'me@gmail.com', SMTP_PASS: 'app pass', MAIL_FROM: 'me@gmail.com' },
  }, (err, so, se) => resolve({ err, se })));
  server.close();
  assert.ifError(r.err && Object.assign(r.err, { message: r.se }));
  assert.ok(seen.some((l) => /^STARTTLS/.test(l)));
  assert.ok(authedOverTls, 'AUTH は TLS 確立後に行われる');
  assert.match(mail, /Subject: =\?UTF-8\?B\?/);
  assert.strictEqual(Buffer.from(mail.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString(), '本文 ✓');
});
