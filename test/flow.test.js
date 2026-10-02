'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir, wait, sleep, fakeClaude, fakeSmtp, subject } = require('./helpers');

test('複数プロンプトを順次実行 → 空になったら送信スクリプトが1回だけ走る / リトライ / 失敗 / 機密検出', async () => {
  const tmp = tmpdir();
  const counter = path.join(tmp, 'n');
  // プロンプトに応じて動作を変える偽 claude (outbox にファイルを出力する)
  const claude = fakeClaude(tmp, `
mkdir -p outbox
case "$p" in
  flaky*) n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}; [ "$n" = 0 ] && { echo "boom" >&2; exit 1; } ;;
  broken*) echo "always fails" >&2; exit 1 ;;
  secret*) echo "key=AKIAABCDEFGHIJKLMNOP" > outbox/leak.txt ;;
  *) echo "data for: $p" > "outbox/$(echo $p | tr -c 'a-z0-9\\n' _).txt" ;;
esac
echo "{\\"result\\":\\"done: $p\\"}"`);
  fs.mkdirSync(path.join(tmp, 'wa')); fs.mkdirSync(path.join(tmp, 'wb'));
  const sendLog = path.join(tmp, 'send.log');
  const sender = path.join(tmp, 'send.sh');
  fs.writeFileSync(sender, `#!/bin/sh\necho "$PROJECT_NAME ids=$(echo "$RESULT_IDS" | wc -l) outbox=$(ls "$OUTBOX_DIR" | tr '\\n' ',') tok=$MYTOK" >> ${sendLog}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({ projects: {
    alpha: { workDir: path.join(tmp, 'wa'), maxAttempts: 2, retryDelayMs: 50, instructions: 'outbox に出力', finalize: { command: [sender], env: { MYTOK: 'x' } } },
    beta: { workDir: path.join(tmp, 'wb'), maxAttempts: 1, finalize: { command: [sender] } },
  } }));

  const mails = []; const smtp = fakeSmtp(mails).listen(0); await new Promise((r) => smtp.once('listening', r));
  Object.assign(process.env, {
    API_TOKEN: 't', PORT: '0', PROJECTS_FILE: path.join(tmp, 'projects.json'), CLAUDE_BIN: claude, QUEUE_DIR: path.join(tmp, 'q'),
    HEALTHCHECK_INTERVAL_MS: '0', ADMIN_EMAIL: 'a@example.com', MAIL_FROM: 'b@example.com',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_STARTTLS: 'false',
    API_TOKEN_LEAK_CHECK: 'should-not-reach-claude',
  });
  const { server, listen } = require('../src/server');
  listen(); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { Authorization: 'Bearer t', 'Content-Type': 'application/json' };
  const post = async (proj, prompt) => (await fetch(`${base}/projects/${proj}/run`, { method: 'POST', headers: H, body: JSON.stringify({ prompt }) })).json();
  const q = (...p) => path.join(tmp, 'q', ...p);

  // --- 1. 認証 / 死活監視
  assert.strictEqual((await fetch(`${base}/projects/alpha/run`, { method: 'POST' })).status, 401);
  assert.strictEqual((await fetch(`${base}/healthz`, { method: 'HEAD' })).status, 200);

  // --- 2. 2件 + リトライされる1件。送信は全部終わってから1回だけ
  const a = await post('alpha', 'one'); const b = await post('alpha', 'flaky'); const c = await post('alpha', 'two');
  await wait(() => fs.existsSync(sendLog));
  await sleep(300);
  const log = fs.readFileSync(sendLog, 'utf8').trim().split('\n');
  assert.strictEqual(log.length, 1, `送信は1回だけ: ${log}`);
  assert.match(log[0], /alpha ids=3 .*tok=x/);
  for (const id of [a.id, b.id, c.id]) assert.ok(fs.existsSync(q('alpha/done', `${id}.md`)), `${id} done`);
  assert.strictEqual(fs.readFileSync(counter, 'utf8').trim(), '2', 'flaky は2回実行された(1回目失敗→リトライ)');
  assert.deepStrictEqual(fs.readdirSync(q('alpha/pending')), []);
  assert.ok(!fs.existsSync(q('alpha/.dirty')), '送信済みなので dirty は消える');
  assert.strictEqual((await (await fetch(`${base}/healthz`)).json()).workerRunning, false, '空で停止');

  // --- 3. 失敗(maxAttempts=1) → failed フォルダ + 管理者メール、送信はしない(結果なし)
  const f = await post('beta', 'broken');
  await wait(() => fs.existsSync(q('beta/failed', `${f.id}.md`)));
  assert.ok(fs.existsSync(q('beta/failed', `${f.id}.error.txt`)));
  await wait(() => mails.length >= 1);
  assert.match(subject(mails[0]), /実行に失敗/);
  assert.strictEqual((await (await fetch(`${base}/projects/beta/jobs/${f.id}`, { headers: H })).json()).status, 'failed');

  // --- 4. 機密情報: 送信せず管理者にメール(値は本文に載せない)
  const before = fs.readFileSync(sendLog, 'utf8');
  const s = await post('beta', 'secret');
  await wait(() => mails.length >= 2);
  assert.match(subject(mails[1]), /機密情報/);
  assert.ok(!Buffer.from(mails[1].split('\r\n\r\n').pop().replace(/\r\n/g, ''), 'base64').toString().includes('AKIAABCDEFGHIJKLMNOP'));
  await sleep(300);
  assert.strictEqual(fs.readFileSync(sendLog, 'utf8'), before, '機密検出時は送信スクリプトを実行しない');
  assert.ok(fs.existsSync(q('beta/.dirty')), '送信待ちのまま残る');
  assert.ok(fs.existsSync(q('beta/done', `${s.id}.md`)));

  // --- 5. 機密を取り除いて再度リクエスト → 再チェックを通って送信される
  fs.rmSync(path.join(tmp, 'wb/outbox/leak.txt'));
  await post('beta', 'clean');
  await wait(() => fs.readFileSync(sendLog, 'utf8') !== before);
  assert.match(fs.readFileSync(sendLog, 'utf8'), /beta ids=/);
  assert.ok(!fs.existsSync(q('beta/.dirty')));

  server.closeAllConnections(); server.close(); smtp.close();
});
