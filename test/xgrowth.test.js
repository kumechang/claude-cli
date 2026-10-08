'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir, wait, sleep, fakeClaude } = require('./helpers');

test('x-growth: 結果を応答で返す / 案件別トークン / 案件別の並列実行 / タイムアウト / 保持期間 / 既存案件は従来どおり', async () => {
  const tmp = tmpdir();
  const argsLog = path.join(tmp, 'args.log');
  const XTOKEN = 'x'.repeat(40);
  // プロンプトに応じた偽 claude。引数を記録する
  const claude = fakeClaude(tmp, `
echo "[$(pwd | xargs basename)] $*" >> ${argsLog}
case "$p" in
  slow*) sleep 2; echo '{"result":"slow done"}' ;;
  hang*) sleep 5; echo '{"result":"never"}' ;;
  fail*) echo "boom" >&2; exit 1 ;;
  *) printf '{"result":"こんにちは\\\\n  **そのまま** <b>x</b>  "}' ;;
esac`);
  for (const d of ['wm', 'wx']) fs.mkdirSync(path.join(tmp, d));
  fs.writeFileSync(path.join(tmp, 'projects.json'), JSON.stringify({ projects: {
    mahjong: { workDir: path.join(tmp, 'wm'), maxAttempts: 1, finalize: { command: ['/bin/true'] } },
    'x-growth': { workDir: path.join(tmp, 'wx'), tokenEnv: 'XGROWTH_API_TOKEN', returnResult: true, retentionDays: 1, maxAttempts: 1, timeoutMs: 1000, claudeArgs: ['--tools', ''], instructions: 'X の投稿文を書く' },
  } }));
  Object.assign(process.env, {
    API_TOKEN: 'g'.repeat(40), XGROWTH_API_TOKEN: XTOKEN, PORT: '0', PROJECTS_FILE: path.join(tmp, 'projects.json'), CLAUDE_BIN: claude,
    QUEUE_DIR: path.join(tmp, 'q'), HEALTHCHECK_INTERVAL_MS: '0', CLAUDE_MAX_CONCURRENCY: '2',
  });
  const { server, listen } = require('../src/server');
  const jobs = require('../src/jobs');
  listen(); await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const G = { Authorization: `Bearer ${process.env.API_TOKEN}`, 'Content-Type': 'application/json' };
  const X = { Authorization: `Bearer ${XTOKEN}`, 'Content-Type': 'application/json' };
  const post = (proj, prompt, H) => fetch(`${base}/projects/${proj}/run`, { method: 'POST', headers: H, body: JSON.stringify({ prompt }) });
  const get = (proj, id, H) => fetch(`${base}/projects/${proj}/jobs/${id}`, { headers: H });

  // --- 認証: 案件専用トークンはその案件だけ。全体トークンは全案件。未知の案件名でも存在を漏らさない
  assert.strictEqual((await post('x-growth', 'hi', { ...X, Authorization: 'Bearer wrong' })).status, 401);
  assert.strictEqual((await post('mahjong', 'hi', X)).status, 401, 'x-growth 用トークンで mahjong は使えない');
  assert.strictEqual((await post('nope', 'hi', X)).status, 401, '未知の案件名でも専用トークンは通らない(存在を漏らさない)');
  assert.strictEqual((await post('nope', 'hi', G)).status, 404);
  assert.strictEqual((await get('mahjong', 'x', X)).status, 401);

  // --- 並列: mahjong の遅いジョブが走っていても x-growth は待たされない
  const slow = await (await post('mahjong', 'slow job', G)).json();
  await sleep(300);
  const t0 = Date.now();
  const fast = await (await post('x-growth', 'draft', X)).json();   // 専用トークンで送信
  let r;
  await wait(async () => { r = await (await get('x-growth', fast.id, X)).json(); return r.status === 'done'; }, 30);
  assert.strictEqual(r.status, 'done');
  assert.ok(Date.now() - t0 < 1500, `x-growth が mahjong の後ろに並んでいない (${Date.now() - t0}ms)`);
  assert.strictEqual((await (await get('mahjong', slow.id, G)).json()).status, 'running', 'その間 mahjong はまだ実行中');

  // --- 応答の形: result.text は claude の出力をそのまま / finishedAt は ISO 8601
  assert.deepStrictEqual(Object.keys(r), ['project', 'id', 'status', 'result', 'finishedAt']);
  assert.strictEqual(r.project, 'x-growth');
  assert.strictEqual(r.result.text, 'こんにちは\n  **そのまま** <b>x</b>  ');
  assert.match(r.finishedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  // 全体トークンでも読める
  assert.strictEqual((await get('x-growth', fast.id, G)).status, 200);

  // --- finalize 無しの案件には outbox の指示を付けず、instructions だけを渡す。finalize 有りの案件には付く
  const log = fs.readFileSync(argsLog, 'utf8');
  assert.match(log, /\[wx\] -p --output-format json --tools  --append-system-prompt X の投稿文を書く\n/);
  assert.doesNotMatch(log.split('\n').find((l) => l.startsWith('[wx]')), /outbox|_target/);
  assert.match(log, /\[wm\] [^\n]*outbox\/[^\n]*\n[\s\S]*_target\.json/, 'finalize 有りの案件には outbox / _target.json の指示が付く');
  // finalize 無しなので送信待ち(.dirty)は作らない
  assert.ok(!fs.existsSync(path.join(tmp, 'q/x-growth/.dirty')));

  // --- 失敗: error.message(returnResult の案件)/ 従来の案件は error が文字列のまま
  const f = await (await post('x-growth', 'fail please', X)).json();
  await wait(async () => (await (await get('x-growth', f.id, X)).json()).status === 'failed', 30);
  const fr = await (await get('x-growth', f.id, X)).json();
  assert.deepStrictEqual(Object.keys(fr), ['project', 'id', 'status', 'error', 'finishedAt']);
  assert.match(fr.error.message, /boom/);
  assert.match(fr.finishedAt, /^\d{4}-/);

  // --- タイムアウト: 案件の timeoutMs で自動的に failed
  const h = await (await post('x-growth', 'hang', X)).json();
  await wait(async () => (await (await get('x-growth', h.id, X)).json()).status === 'failed', 40);
  assert.match((await (await get('x-growth', h.id, X)).json()).error.message, /タイムアウト/);

  const mf = await (await post('mahjong', 'fail please', G)).json();
  await wait(async () => (await (await get('mahjong', mf.id, G)).json()).status === 'failed', 60);
  const mr = await (await get('mahjong', mf.id, G)).json();
  assert.strictEqual(typeof mr.error, 'string', '従来の案件の error は文字列のまま');

  // --- 従来案件の done は result を含まない(従来どおり) + 送信処理は走る
  await wait(async () => (await (await get('mahjong', slow.id, G)).json()).status === 'done', 40);
  const sd = await (await get('mahjong', slow.id, G)).json();
  assert.strictEqual(sd.result, undefined);
  assert.strictEqual(sd.status, 'done');

  // --- 保持期間: retentionDays を過ぎた done/failed は削除、新しいものは残る。保持期間なしの案件は触らない
  const old = Date.now() - 2 * 24 * 3600 * 1000;
  for (const f2 of fs.readdirSync(path.join(tmp, 'q/x-growth/done')).filter((n) => n.startsWith(fast.id))) {
    fs.utimesSync(path.join(tmp, 'q/x-growth/done', f2), old / 1000, old / 1000);
  }
  const mfiles = fs.readdirSync(path.join(tmp, 'q/mahjong/done')).length;
  for (const f2 of fs.readdirSync(path.join(tmp, 'q/mahjong/done'))) fs.utimesSync(path.join(tmp, 'q/mahjong/done', f2), old / 1000, old / 1000);
  await jobs.cleanup();
  assert.deepStrictEqual(fs.readdirSync(path.join(tmp, 'q/x-growth/done')).filter((n) => n.startsWith(fast.id)), [], '古い結果は削除');
  assert.strictEqual((await get('x-growth', fast.id, X)).status, 404);
  assert.ok(fs.readdirSync(path.join(tmp, 'q/x-growth/failed')).some((n) => n.startsWith(f.id)), '新しい失敗は残る');
  assert.strictEqual(fs.readdirSync(path.join(tmp, 'q/mahjong/done')).length, mfiles, '保持期間なしの案件は消さない');

  // --- 同じ案件の中は 1 件ずつ(受付順)
  const a = await (await post('mahjong', 'slow a', G)).json();
  const b = await (await post('mahjong', 'slow b', G)).json();
  await sleep(500);
  assert.strictEqual((await (await get('mahjong', a.id, G)).json()).status, 'running');
  assert.strictEqual((await (await get('mahjong', b.id, G)).json()).status, 'queued');

  await jobs.shutdown();
  server.closeAllConnections(); server.close();
});

test('設定: 案件専用トークンが短い・未設定なら起動時にエラー', async () => {
  const tmp = tmpdir();
  fs.writeFileSync(path.join(tmp, 'p.json'), JSON.stringify({ projects: { a: { tokenEnv: 'SHORT_TOKEN' } } }));
  const { execFileSync } = require('node:child_process');
  const run = (env) => { try { execFileSync(process.execPath, ['-e', "require('./src/config')"], { cwd: path.join(__dirname, '..'), env: { PATH: process.env.PATH, API_TOKEN: 'g'.repeat(40), PROJECTS_FILE: path.join(tmp, 'p.json'), ...env }, stdio: 'pipe' }); return null; } catch (e) { return String(e.stderr); } };
  assert.match(run({}), /SHORT_TOKEN/);
  assert.match(run({ SHORT_TOKEN: 'short' }), /32文字未満/);
  assert.strictEqual(run({ SHORT_TOKEN: 'y'.repeat(32) }), null);
});
