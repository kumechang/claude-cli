'use strict';

/**
 * 案件ごとのフォルダキュー:
 *   queue/<project>/pending/<id>.md   未実施プロンプト
 *   queue/<project>/done/<id>.md|json 実施済み(プロンプト+結果) / <id>.meta.json にハンドラ結果
 *   queue/<project>/failed/<id>.md    実行失敗(<id>.error.txt 付き。自動リトライしない)
 * ワーカーは全案件の pending を古い順に1件ずつ(同時に claude は1つ)実行し、
 * 全案件の pending が空になったら停止する。新規受信・起動時に pending があれば再開。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { runClaude } = require('./claude');
const { runHandlers } = require('./handlers');

const sub = (project, name) => path.join(config.queueDir, project, name);

let workerRunning = false;
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
    const [next] = await listPending();
    if (!next) return;
    await processOne(config.projects[next.project], next.id);
  }
}

async function processOne(project, id) {
  current = `${project.name}/${id}`;
  const src = path.join(sub(project.name, 'pending'), `${id}.md`);
  const done = sub(project.name, 'done');
  const prompt = await fs.readFile(src, 'utf8');
  try {
    const result = await runClaude(prompt, {
      bin: config.claudeBin,
      args: project.claudeArgs,
      cwd: project.workDir,
      timeoutMs: project.timeoutMs,
    });
    const markdown = `# Prompt\n\n${prompt}\n\n# Result\n\n${result.text}\n`;
    await fs.mkdir(done, { recursive: true });
    await fs.writeFile(path.join(done, `${id}.json`), JSON.stringify(result.raw, null, 2));
    await fs.writeFile(path.join(done, `${id}.md`), markdown);
    await fs.unlink(src); // 結果保存後に pending から除去 = 実施済みへ移動

    const handlers = await runHandlers(project, { id, prompt, result, markdown });
    const meta = { finishedAt: new Date().toISOString(), handlers };
    await fs.writeFile(path.join(done, `${id}.meta.json`), JSON.stringify(meta, null, 2));
  } catch (e) {
    const failed = sub(project.name, 'failed');
    await fs.mkdir(failed, { recursive: true });
    await fs.writeFile(path.join(failed, `${id}.error.txt`), e.message);
    await fs.rename(src, path.join(failed, `${id}.md`));
  }
}

async function status(project, id) {
  const exists = (p) => fs.access(p).then(() => true, () => false);
  if (await exists(path.join(sub(project, 'done'), `${id}.md`))) {
    const meta = await fs.readFile(path.join(sub(project, 'done'), `${id}.meta.json`), 'utf8').then(JSON.parse, () => ({}));
    return { project, id, status: 'done', ...meta };
  }
  if (await exists(path.join(sub(project, 'failed'), `${id}.md`))) {
    const error = await fs.readFile(path.join(sub(project, 'failed'), `${id}.error.txt`), 'utf8').catch(() => '');
    return { project, id, status: 'failed', error };
  }
  if (await exists(path.join(sub(project, 'pending'), `${id}.md`))) {
    return { project, id, status: current === `${project}/${id}` ? 'running' : 'queued' };
  }
  return null;
}

module.exports = { enqueue, status, start, isRunning: () => workerRunning };
