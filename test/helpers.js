'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

exports.tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
exports.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
exports.wait = async (fn, n = 80) => { for (let i = 0; i < n && !(await fn()); i++) await exports.sleep(100); };
exports.subject = (m) => Buffer.from(m.match(/Subject: =\?UTF-8\?B\?(.+?)\?=/)[1], 'base64').toString();

/** 偽 claude: stdin のプロンプトを読み、script(sh) の内容で応答する */
exports.fakeClaude = (dir, body) => {
  const f = path.join(dir, 'claude');
  fs.writeFileSync(f, `#!/bin/sh\nread p\n${body}\n`, { mode: 0o755 });
  return f;
};

/** 最小の偽 SMTP サーバー。受信メールを mails に溜める。 */
exports.fakeSmtp = (mails) => net.createServer((s) => {
  let data = null; let buf = '';
  s.write('220 fake\r\n');
  s.on('data', (d) => {
    buf += d;
    for (;;) {
      if (data !== null) {
        const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return;
        mails.push(data + buf.slice(0, i)); data = null; buf = buf.slice(i + 5); s.write('250 queued\r\n'); continue;
      }
      const i = buf.indexOf('\r\n'); if (i < 0) return;
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (/^EHLO/.test(line)) s.write('250-fake\r\n250 AUTH PLAIN\r\n');
      else if (/^AUTH/.test(line)) s.write('235 ok\r\n');
      else if (/^DATA/.test(line)) { data = ''; s.write('354 go\r\n'); }
      else if (/^QUIT/.test(line)) s.end('221 bye\r\n');
      else s.write('250 ok\r\n');
    }
  });
});
