'use strict';

/**
 * 案件ごとのフォルダキュー:
 *   queue/<project>/pending/<id>.md   未実施プロンプト
 *   queue/<project>/done/<id>.md|json|txt  実施済み(プロンプト+結果 / 生の出力 / 結果テキストそのまま)
 *   queue/<project>/failed/<id>.md    失敗(<id>.error.txt 付き)。再実行は pending/ に戻すだけ
 *   queue/<project>/.dirty            「送信待ちの結果がある」印(中身は完了した id の一覧)
 *
 * スケジューリング(案件ごとのレーン):
 *   - 同じ案件の中は 1 件ずつ(受付順)。案件が違えば並列に実行できる。
 *   - claude の同時実行数は CLAUDE_MAX_CONCURRENCY(既定 2)まで。長い案件のジョブに、短い案件が待たされないようにするため。
 *   - 案件の pending が空になったら、その案件の finalize(送信スクリプト)を 1 回実行する。
 *   - 認証切れの間は新しいジョブを始めず pending に残す(復旧後に再開)。
 *   - 保持期間(retentionDays)を過ぎた done/failed は自動で削除する。
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
const exists = (p) => fs.access(p).then(() => true, () => false);

const busy = new Set(); // いま処理中(ジョブ実行 or 送信処理)の案件
const currentJob = new Map(); // 案件 -> 実行中の id
const inflight = new Set();
let activeClaude = 0; // claude を動かしている数(ジョブ + ヘルスチェック)
let stopping = false;
let kicking = false;
let kickAgain = false;

async function enqueue(project, prompt) {
  const dir = sub(project, 'pending');
  await fs.mkdir(dir, { recursive: true });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const tmp = path.join(dir, `.${id}.tmp`);
  await fs.writeFile(tmp, prompt);
  await fs.rename(tmp, path.join(dir, `${id}.md`)); // 書き込み途中のファイルを拾わない
  kick();
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

/** 動かせるものを動かす。何度呼んでもよい(多重実行は 1 回にまとめる)。 */
async function kick() {
  if (kicking) { kickAgain = true; return; }
  kicking = true;
  try {
    do {
      kickAgain = false;
      if (stopping) return;
      const pending = await listPending();
      const hasPending = new Set(pending.map((p) => p.project));
      if (health.canRun()) {
        for (const { project, id } of pending) {
          if (activeClaude >= config.maxConcurrency) break;
          if (busy.has(project)) continue;
          run(project, () => { activeClaude++; return processOne(config.projects[project], id).finally(() => { activeClaude--; }); });
        }
      }
      // 未実施がなくなった案件は、結果のあるものを送信する
      for (const name of Object.keys(config.projects)) {
        if (busy.has(name) || hasPending.has(name)) continue;
        if (!(await exists(sub(name, '.dirty')))) continue;
        run(name, () => runFinalize(config.projects[name], sub(name, '')));
      }
    } while (kickAgain);
  } finally {
    kicking = false;
  }
}

/** 案件のレーンで fn を実行する(終わったら次を動かす)。 */
function run(project, fn) {
  busy.add(project);
  const p = Promise.resolve()
    .then(fn)
    .catch((e) => console.error(`[${project}] worker error:`, e))
    .finally(() => {
      busy.delete(project);
      currentJob.delete(project);
      inflight.delete(p);
      if (!busy.size) console.log('worker idle');
      kick();
    });
  inflight.add(p);
}

/** ヘルスチェック用: claude の枠が空いていれば 1 つ確保して解放関数を返す。空きがなければ null。 */
function tryReserve() {
  if (activeClaude >= config.maxConcurrency) return null;
  activeClaude++;
  let released = false;
  return () => { if (!released) { released = true; activeClaude--; kick(); } };
}

/** 案件の instructions に、このプロンプト専用の出力先(outbox/<id>/)を足したシステムプロンプト。 */
function systemPrompt(project, id) {
  // 送信処理(finalize)の無い案件は、ファイル出力の指示を付けない(結果を応答として返す用途)
  if (!project.finalize) return project.instructions;
  const out = path.relative(project.workDir, path.join(project.outboxDir, id)) || id;
  return [
    project.instructions,
    `【出力先】このタスクで外部へ送るファイルは、必ずカレントディレクトリからの相対パス ${out}/ 配下に出力すること(このディレクトリは自分で作成してよい)。`,
    '【送信先】プロンプトに「保存(push)先のリポジトリ・格納フォルダ」が書かれている場合は、' + `${out}/_target.json に {"repo":"owner/name","branch":"main","dir":"格納フォルダ"} の形式で書き出すこと(branch 省略時は main、dir は空でもよい)。` +
      '別ブランチ(例: inbox/2026-10-05)への保存が指示されていれば branch にそれを書く(無ければ自動で作成され、プルリクエストも自動で作られる)。' +
      'ベースブランチの指定があれば "base"、PR のタイトル/本文の指定があれば "pr_title"/"pr_body"、PR を作らないよう指示があれば "pr": false を加える。' +
      '既存のブランチについて「プルリクエストだけ作って」と指示された場合は、ファイルは作らず _target.json だけを書く。' +
      'リポジトリへの送信自体は行わないこと(後続の処理が _target.json を読んで送信する)。送信先の記載がなければ _target.json は作らない。',
    'パスワード・API キー・トークンなどの秘密情報は、出力ファイルに絶対に含めないこと。',
  ].filter(Boolean).join('\n\n');
}

async function processOne(project, id) {
  currentJob.set(project.name, id);
  const src = path.join(sub(project.name, 'pending'), `${id}.md`);
  const attemptsFile = path.join(sub(project.name, 'pending'), `${id}.attempts`);
  const prompt = await fs.readFile(src, 'utf8');
  const attempts = Number(await fs.readFile(attemptsFile, 'utf8').catch(() => 0)) + 1;
  try {
    const sys = systemPrompt(project, id);
    const result = await runClaude(prompt, {
      bin: config.claudeBin,
      args: [...project.claudeArgs, ...(sys ? ['--append-system-prompt', sys] : [])],
      cwd: project.workDir,
      timeoutMs: project.timeoutMs,
    });
    const markdown = `# Prompt\n\n${prompt}\n\n# Result\n\n${result.text}\n`;
    const done = sub(project.name, 'done');
    await fs.mkdir(done, { recursive: true });
    await fs.writeFile(path.join(done, `${id}.json`), JSON.stringify(result.raw, null, 2));
    await fs.writeFile(path.join(done, `${id}.txt`), result.text); // 結果テキストそのまま(加工なし)
    await fs.writeFile(path.join(done, `${id}.md`), markdown); // 完了の印(最後に書く)
    if (project.finalize) await fs.appendFile(sub(project.name, '.dirty'), `${id}\n`); // 送信待ちの印(unlink より先に書く)
    await fs.unlink(src); // 結果保存後に pending から除去 = 実施済みへ移動
    await fs.unlink(attemptsFile).catch(() => {});
  } catch (e) {
    if (health.isAuthError(e.message)) {
      // 認証切れ: 失敗扱いにせず pending に残し、管理者に通知する(以後、復旧まで新しいジョブは始めない)
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
    await fs.rename(src, path.join(failed, `${id}.md`)); // 完了の印(最後に)
    await fs.unlink(attemptsFile).catch(() => {});
    await notifyAdmin(`[${project.name}] プロンプトの実行に失敗しました`, `案件: ${project.name}\nid: ${id}\n試行回数: ${attempts}\n\n${e.message}\n\nqueue/${project.name}/failed/ に保存しました。再実行するには ${id}.md を pending/ に戻してください。`);
  }
}

const mtimeIso = (p) => fs.stat(p).then((s) => s.mtime.toISOString(), () => undefined);

/**
 * ジョブの状態。
 * 共通: { project, id, status, finishedAt? }(done / failed のとき finishedAt は ISO 8601)
 * 案件に returnResult: true を設定した場合: done に result.text、failed に error.message を含める。
 * それ以外の案件は従来どおり(failed の error は文字列)。
 */
async function status(project, id) {
  const cfg = config.projects[project];
  const doneMd = path.join(sub(project, 'done'), `${id}.md`);
  if (await exists(doneMd)) {
    const out = { project, id, status: 'done' };
    if (cfg.returnResult) {
      out.result = { text: await fs.readFile(path.join(sub(project, 'done'), `${id}.txt`), 'utf8').catch(() => '') };
    }
    out.finishedAt = await mtimeIso(doneMd);
    return out;
  }
  if (await exists(path.join(sub(project, 'failed'), `${id}.md`))) {
    const errFile = path.join(sub(project, 'failed'), `${id}.error.txt`);
    const message = await fs.readFile(errFile, 'utf8').catch(() => '');
    return { project, id, status: 'failed', error: cfg.returnResult ? { message } : message, finishedAt: await mtimeIso(errFile) };
  }
  if (await exists(path.join(sub(project, 'pending'), `${id}.md`))) {
    return { project, id, status: currentJob.get(project) === id ? 'running' : 'queued' };
  }
  return null;
}

/** 保持期間(retentionDays)を過ぎた done / failed のファイルを削除する。送信待ち(.dirty)の id は残す。 */
async function cleanup(now = Date.now()) {
  let removed = 0;
  for (const p of Object.values(config.projects)) {
    if (!p.retentionDays) continue;
    const limit = now - p.retentionDays * 24 * 3600 * 1000;
    const keep = new Set((await fs.readFile(sub(p.name, '.dirty'), 'utf8').catch(() => '')).split('\n').map((l) => l.split('\t')[0]).filter(Boolean));
    for (const dir of ['done', 'failed']) {
      for (const f of await fs.readdir(sub(p.name, dir)).catch(() => [])) {
        const id = f.split('.')[0];
        if (keep.has(id)) continue;
        const file = path.join(sub(p.name, dir), f);
        const st = await fs.stat(file).catch(() => null);
        if (st && st.mtimeMs < limit) { await fs.unlink(file).catch(() => {}); removed++; }
      }
    }
  }
  return removed;
}

let cleanupTimer = null;
function start() {
  kick();
  cleanup().catch((e) => console.error('cleanup error:', e));
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => cleanup().catch((e) => console.error('cleanup error:', e)), 3600 * 1000);
    cleanupTimer.unref();
  }
}

/** 実行中のものだけ完了を待って止める(デプロイ時の再起動で処理が途切れないように)。 */
async function shutdown() {
  stopping = true;
  clearInterval(cleanupTimer);
  while (inflight.size) await Promise.allSettled([...inflight]);
}

module.exports = { enqueue, status, start, kick, shutdown, cleanup, tryReserve, isRunning: () => busy.size > 0 };
