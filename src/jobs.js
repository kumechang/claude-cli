'use strict';

/**
 * フォルダベースのキュー:
 *   queue/pending/<id>.md   未実施プロンプト
 *   queue/done/<id>.md|json 実施済み(プロンプト+結果) / <id>.meta.json に GitHub push 結果
 *   queue/failed/<id>.md    実行失敗(<id>.error.txt 付き。無限リトライ防止のため pending には戻さない)
 * ワーカーは pending が空になるまで古い順に1件ずつ実行し、空になったら停止する。
 * 新しいプロンプトが届くか、サーバー起動時に pending が残っていれば再度起動する。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { runClaude } = require('./claude');
const { pushFile } = require('./github');

const dir = (name) => path.join(config.queueDir, name);
const PENDING = dir('pending');
const DONE = dir('done');
const FAILED = dir('failed');

let workerRunning = false;
let current = null;

async function enqueue(prompt) {
  await fs.mkdir(PENDING, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = path.join(PENDING, `.${id}.tmp`);
  await fs.writeFile(tmp, prompt);
  await fs.rename(tmp, path.join(PENDING, `${id}.md`)); // 書き込み途中のファイルを拾わない
  start();
  return id;
}

const listPending = async () =>
  (await fs.readdir(PENDING).catch(() => [])).filter((f) => f.endsWith('.md')).sort();

/** ワーカー起動(既に動いていれば何もしない)。 */
function start() {
  if (workerRunning) return;
  workerRunning = true;
  loop()
    .catch((e) => console.error('worker error:', e))
    .finally(() => {
      workerRunning = false;
      current = null;
      console.log('worker stopped: pending is empty');
    });
}

async function loop() {
  for (;;) {
    const [file] = await listPending();
    if (!file) return; // 未実施がなくなったら停止
    await processOne(file);
  }
}

async function processOne(file) {
  const id = file.replace(/\.md$/, '');
  current = id;
  const src = path.join(PENDING, file);
  const prompt = await fs.readFile(src, 'utf8');
  try {
    const result = await runClaude(prompt, {
      bin: config.claudeBin,
      args: config.claudeArgs,
      cwd: config.workDir,
      timeoutMs: config.timeoutMs,
    });
    const markdown = `# Prompt\n\n${prompt}\n\n# Result\n\n${result.text}\n`;
    await fs.mkdir(DONE, { recursive: true });
    await fs.writeFile(path.join(DONE, `${id}.json`), JSON.stringify(result.raw, null, 2));
    await fs.writeFile(path.join(DONE, `${id}.md`), markdown);
    await fs.unlink(src); // 結果保存後に pending から除去 = 実施済みへ移動

    const meta = { finishedAt: new Date().toISOString() };
    try {
      meta.github = await pushFile(`${config.github.dir}/${id}.md`, markdown, `claude result ${id}`);
    } catch (e) {
      meta.pushError = e.message; // 結果はローカルに残る。実行自体は成功扱い
      console.error(`push failed for ${id}:`, e.message);
    }
    await fs.writeFile(path.join(DONE, `${id}.meta.json`), JSON.stringify(meta, null, 2));
  } catch (e) {
    await fs.mkdir(FAILED, { recursive: true });
    await fs.writeFile(path.join(FAILED, `${id}.error.txt`), e.message);
    await fs.rename(src, path.join(FAILED, file));
  }
}

async function status(id) {
  const exists = (p) => fs.access(p).then(() => true, () => false);
  if (await exists(path.join(DONE, `${id}.md`))) {
    const meta = await fs.readFile(path.join(DONE, `${id}.meta.json`), 'utf8').then(JSON.parse, () => ({}));
    return { id, status: 'done', ...meta };
  }
  if (await exists(path.join(FAILED, `${id}.md`))) {
    const error = await fs.readFile(path.join(FAILED, `${id}.error.txt`), 'utf8').catch(() => '');
    return { id, status: 'failed', error };
  }
  if (await exists(path.join(PENDING, `${id}.md`))) {
    return { id, status: current === id ? 'running' : 'queued' };
  }
  return null;
}

module.exports = { enqueue, status, start, isRunning: () => workerRunning };
