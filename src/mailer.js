'use strict';

/**
 * 依存なしの最小 SMTP クライアント(SMTPS / STARTTLS / AUTH PLAIN)。
 * env: SMTP_HOST SMTP_PORT(587) SMTP_SECURE(true=暗黙TLS, 465向け) SMTP_STARTTLS(false で無効化)
 *      SMTP_USER SMTP_PASS MAIL_FROM
 */

const net = require('node:net');
const tls = require('node:tls');

const clean = (s) => String(s).replace(/[\r\n]+/g, ' ').trim(); // ヘッダインジェクション対策
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

class Conn {
  constructor(socket) {
    this.socket = socket;
    this.buf = '';
    this.waiters = [];
    this.error = null;
    socket.setEncoding('utf8');
    socket.on('data', (d) => { this.buf += d; this.flush(); });
    socket.on('error', (e) => { this.error = e; this.flush(); });
    socket.on('close', () => { this.error ||= new Error('connection closed'); this.flush(); });
  }

  /** 1つの完結した応答({code, text})を読む。複数行応答は "250-" … "250 " で完結。 */
  read() {
    return new Promise((resolve, reject) => { this.waiters.push({ resolve, reject }); this.flush(); });
  }

  flush() {
    while (this.waiters.length) {
      const lines = this.buf.split('\r\n');
      const end = lines.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
      if (end >= 0) {
        const got = lines.slice(0, end + 1);
        this.buf = lines.slice(end + 1).join('\r\n');
        this.waiters.shift().resolve({ code: Number(got[end].slice(0, 3)), text: got.join('\n') });
      } else if (this.error) {
        this.waiters.shift().reject(this.error);
      } else return;
    }
  }

  async cmd(line, ok) {
    this.socket.write(`${line}\r\n`);
    return this.expect(ok, line.split(' ')[0]);
  }

  async expect(ok, what) {
    const r = await this.read();
    if (!ok.includes(r.code)) throw new Error(`SMTP ${what} failed: ${r.text}`);
    return r;
  }
}

async function sendMail({ to, subject, text }, env = process.env) {
  const host = env.SMTP_HOST;
  const from = env.MAIL_FROM;
  if (!host || !from) throw new Error('SMTP_HOST / MAIL_FROM が未設定です');
  const recipients = (Array.isArray(to) ? to : String(to).split(',')).map(clean).filter(Boolean);
  if (!recipients.length) throw new Error('宛先がありません');
  const secure = env.SMTP_SECURE === 'true';
  const port = Number(env.SMTP_PORT || (secure ? 465 : 587));

  const socket = await new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    s.setTimeout(30000, () => s.destroy(new Error('SMTP timeout')));
    s.once(secure ? 'secureConnect' : 'connect', () => resolve(s));
    s.once('error', reject);
  });
  let c = new Conn(socket);
  try {
    await c.expect([220], 'greeting');
    let ehlo = await c.cmd('EHLO claude-cli-server', [250]);
    if (!secure && env.SMTP_STARTTLS !== 'false' && /STARTTLS/i.test(ehlo.text)) {
      await c.cmd('STARTTLS', [220]);
      c = new Conn(tls.connect({ socket, servername: host }));
      ehlo = await c.cmd('EHLO claude-cli-server', [250]);
    }
    if (env.SMTP_USER) {
      await c.cmd(`AUTH PLAIN ${b64(`\0${env.SMTP_USER}\0${env.SMTP_PASS || ''}`)}`, [235]);
    }
    await c.cmd(`MAIL FROM:<${clean(from)}>`, [250]);
    for (const r of recipients) await c.cmd(`RCPT TO:<${r}>`, [250, 251]);
    await c.cmd('DATA', [354]);
    const body = (b64(text).match(/.{1,76}/g) || []).join('\r\n');
    const msg = [
      `From: ${clean(from)}`,
      `To: ${recipients.join(', ')}`,
      `Subject: =?UTF-8?B?${b64(clean(subject))}?=`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\r\n');
    c.socket.write(`${msg}\r\n.\r\n`); // base64 本文に "." 始まりの行は存在しないため dot-stuffing 不要
    await c.expect([250], 'DATA');
    c.socket.write('QUIT\r\n');
  } finally {
    c.socket.end();
  }
}

module.exports = { sendMail };
