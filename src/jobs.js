'use strict';

/**
 * 案件ごとのフォルダキュー:
 *   queue/<project>/pending/<id>.md   未実施プロンプト
 *   queue/<project>/done/<id>.md|json 実施済み(プロンプト+結果)
 *   queue/<project>/failed/<id>.md    失敗(<id>.error.txt 付き)。再実行は pending/ に戻すだけ
 *   queue/<project>/.dirty            「送信待ちの結果がある」印(中身は完了した id の一覧)
 *
 * 流れ: リクエスト受信 → pending に保存 → ワーカー起動 → 全案件の pending が空になるまで
 *       古い順に1件ずつ claude 実行 → 空になったら、結果のある案件ごとに finalize(送信スクリプト)を実行 → 停止
 * 認証切れの間は pending を残したまま停止(復旧後に再開)。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { runClaude } = require('./claude');
const { runFinalize } = require('./finalize');
const health = require('./health');
const { notifyAdmin } = require('./notify');

const sub = (project, name) => path.join(config.queueDir, project, name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let workerRunning = false;
let stopping = false;
let workerDone = Promise.resolve();
let current = null; // "<project>/<id>"

async function enqueue(project, prompt) {
  const dir = sub(project, 'pending');
  await fs.mkdir(dir, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = path.join(dir, `.${id}.tmp`);
  await fs.writeFile(tmp, prompt);
  await fs.rename(tmp, path.join(dir, `${id}.md`)); // 書き込み途中のファイルを拾わない
  start();
  return id;
}

/** 全案件の未実施を id(=時刻)順に返す。 */
async function listPending() {
  const all = [];
  for (const project of Object.keys(config.projects)) {
    const files = await fs.readdir(sub(project, 'pending')).catch(() => []);
    for (const f of files) if (f.endsWith('.md')) all.push({ project, id: f.slice(0, -3) });
  }
  return all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const dirtyProjects = async () => {
  const out = [];
  for (const name of Object.keys(config.projects)) {
    if (await fs.access(sub(name, '.dirty')).then(() => true, () => false)) out.push(config.projects[name]);
  }
  return out;
};

function start() {
  if (workerRunning || stopping) return;
  workerRunning = true;
  workerDone = loop()
    .catch((e) => console.error('worker error:', e))
    .finally(() => {
      workerRunning = false;
      current = null;
      console.log('worker stopped');
    });
}

async function loop() {
  for (;;) {
    // 1. 未実施がなくなるまで実行
    for (;;) {
      if (stopping || !health.canRun()) return; // 認証切れ/停止要求: pending を残して終了(finalize もしない)
      const [next] = await listPending();
      if (!next) break;
      await processOne(config.projects[next.project], next.id);
    }
    // 2. 空になったら、結果のある案件の送信処理
    for (const project of await dirtyProjects()) {
      if (stopping) return;
      current = `${project.name}/finalize`;
      await runFinalize(project, sub(project.name, ''));
    }
    // 3. 送信処理中に新しいプロンプトが届いていれば続行、なければ停止
    if (!(await listPending()).length) return;
  }
}

/** 案件の instructions に、このプロンプト専用の出力先(outbox/<id>/)を足したシステムプロンプト。 */
function systemPrompt(project, id) {
  const out = path.relative(project.workDir, path.join(project.outboxDir, id)) || id;
  return [
    project.instructions,
    `【出力先】このタスクで外部へ送るファイルは、必ずカレントディレクトリからの相対パス ${out}/ 配下に出力すること(このディレクトリは自分で作成してよい)。`,
    '【送信先】プロンプトに「保存(push)先のリポジトリ・格納フォルダ」が書かれている場合は、' + `${out}/_target.json に {"repo":"owner/name","branch":"main","dir":"格納フォルダ"} の形式で書き出すこと(branch 省略時は main、dir は空でもよい)。` +
      'リポジトリへの送信自体は行わないこと(後続の処理が _target.json を読んで送信する)。送信先の記載がなければ _target.json は作らない。',
    'パスワード・API キー・トークンなどの秘密情報は、出力ファイルに絶対に含めないこと。',
  ].filter(Boolean).join('\n\n');
}

async function processOne(project, id) {
  current = `${project.name}/${id}`;
  const src = path.join(sub(project.name, 'pending'), `${id}.md`);
  const attemptsFile = path.join(sub(project.name, 'pending'), `${id}.attempts`);
  const prompt = await fs.readFile(src, 'utf8');
  const attempts = Number(await fs.readFile(attemptsFile, 'utf8').catch(() => 0)) + 1;
  try {
    const result = await runClaude(prompt, {
      bin: config.claudeBin,
      args: [...project.claudeArgs, '--append-system-prompt', systemPrompt(project, id)],
      cwd: project.workDir,
      timeoutMs: project.timeoutMs,
    });
    const markdown = `# Prompt\n\n${prompt}\n\n# Result\n\n${result.text}\n`;
    const done = sub(project.name, 'done');
    await fs.mkdir(done, { recursive: true });
    await fs.writeFile(path.join(done, `${id}.json`), JSON.stringify(result.raw, null, 2));
    await fs.writeFile(path.join(done, `${id}.md`), markdown);
    await fs.appendFile(sub(project.name, '.dirty'), `${id}\n`); // 送信待ちの印(unlink より先に書く)
    await fs.unlink(src); // 結果保存後に pending から除去 = 実施済みへ移動
    await fs.unlink(attemptsFile).catch(() => {});
  } catch (e) {
    if (health.isAuthError(e.message)) {
      // 認証切れ: 失敗扱いにせず pending に残し、管理者に通知してワーカーを止める
      await health.reportFailure(e.message);
      return;
    }
    if (attempts < project.maxAttempts) {
      // 一時的な失敗かもしれないので、間を置いて同じプロンプトをもう一度
      await fs.writeFile(attemptsFile, String(attempts));
      console.error(`[${project.name}] ${id} 失敗 (${attempts}/${project.maxAttempts}): ${e.message}`);
      await sleep(project.retryDelayMs);
      return;
    }
    const failed = sub(project.name, 'failed');
    await fs.mkdir(failed, { recursive: true });
    await fs.writeFile(path.join(failed, `${id}.error.txt`), e.message);
    await fs.rename(src, path.join(failed, `${id}.md`));
    await fs.unlink(attemptsFile).catch(() => {});
    await notifyAdmin(`[${project.name}] プロンプトの実行に失敗しました`, `案件: ${project.name}\nid: ${id}\n試行回数: ${attempts}\n\n${e.message}\n\nqueue/${project.name}/failed/ に保存しました。再実行するには ${id}.md を pending/ に戻してください。`);
  }
}

async function status(project, id) {
  const exists = (p) => fs.access(p).then(() => true, () => false);
  if (await exists(path.join(sub(project, 'done'), `${id}.md`))) return { project, id, status: 'done' };
  if (await exists(path.join(sub(project, 'failed'), `${id}.md`))) {
    const error = await fs.readFile(path.join(sub(project, 'failed'), `${id}.error.txt`), 'utf8').catch(() => '');
    return { project, id, status: 'failed', error };
  }
  if (await exists(path.join(sub(project, 'pending'), `${id}.md`))) {
    return { project, id, status: current === `${project}/${id}` ? 'running' : 'queued' };
  }
  return null;
}

/** 実行中の1件だけ完了を待ってワーカーを止める(デプロイ時の再起動で処理が途切れないように)。 */
async function shutdown() {
  stopping = true;
  await workerDone;
}

module.exports = { enqueue, status, start, shutdown, isRunning: () => workerRunning };
