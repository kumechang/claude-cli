'use strict';

/**
 * 案件の「最後のデータ送信」。案件ごとに設定したコマンド(シェルスクリプト等)を、
 * 未実施プロンプトがなくなった後に1回だけ実行する。
 * - 実行前に outbox と今回の結果を機密情報チェック。検出したら送信せず管理者にメール(.dirty は残す)
 * - 成功したら .dirty を削除。失敗したら管理者にメールし .dirty を残す(次回のワーカー実行時に再試行)
 * - コマンドはシェルを介さず実行(引数は配列)。cwd=案件の workDir。
 *   環境変数: PROJECT_NAME PROJECT_DIR OUTBOX_DIR DONE_DIR RESULT_IDS(改行区切り) + finalize.env + サーバーの環境変数
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { scan } = require('./secrets');
const { notifyAdmin } = require('./notify');

function exec(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: out + String(e.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? -2 : code, out: timedOut ? `${out}\n(タイムアウト)` : out }); });
  });
}

async function runFinalize(project, queueRoot) {
  const dirtyFile = path.join(queueRoot, '.dirty');
  const doneDir = path.join(queueRoot, 'done');
  const ids = [...new Set((await fs.readFile(dirtyFile, 'utf8').catch(() => '')).split('\n').filter(Boolean))];

  if (!project.finalize) {
    await fs.unlink(dirtyFile).catch(() => {}); // 送信処理なしの案件
    return;
  }

  // 1. 機密情報チェック
  const findings = await scan({
    files: ids.map((id) => path.join(doneDir, `${id}.md`)),
    dirs: [project.outboxDir],
    extraPatterns: project.secretPatterns,
  });
  const blockedFile = path.join(queueRoot, '.blocked');
  if (findings.length) {
    const summary = [...new Set(findings.map((f) => `${path.relative(project.workDir, f.file)} … ${f.pattern}`))].sort().join('\n');
    const fingerprint = crypto.createHash('sha256').update(summary).digest('hex');
    const prev = await fs.readFile(blockedFile, 'utf8').catch(() => '');
    if (prev !== fingerprint) {
      await notifyAdmin(
        `[${project.name}] 機密情報の疑いがあるため送信を止めました`,
        `案件 ${project.name} の送信前チェックで、機密情報らしき内容を検出したため、送信していません(値は本メールに含めていません)。\n\n${summary}\n\n` +
          `内容を確認し、問題があるファイルを削除/修正してください。次にこの案件のプロンプトを実行するか、サービスを再起動すると、再チェックのうえ送信します。\n(誤検出の場合は、該当内容を書き換えるか、案件の secretPatterns/コードの検出パターンを見直してください)`
      );
      await fs.writeFile(blockedFile, fingerprint);
    }
    console.error(`[${project.name}] 機密情報の疑いで送信を中止`);
    return;
  }
  await fs.unlink(blockedFile).catch(() => {});

  // 2. 送信スクリプト実行
  const f = project.finalize;
  const res = await exec(f.command, {
    cwd: project.workDir,
    timeoutMs: f.timeoutMs || 10 * 60 * 1000,
    env: {
      ...process.env,
      ...(f.env || {}),
      PROJECT_NAME: project.name,
      PROJECT_DIR: project.workDir,
      OUTBOX_DIR: project.outboxDir,
      DONE_DIR: doneDir,
      RESULT_IDS: ids.join('\n'),
    },
  });
  await fs.appendFile(path.join(queueRoot, 'finalize.log'), `--- ${new Date().toISOString()} exit=${res.code} ids=${ids.length}\n${res.out}\n`);
  if (res.code === 0) {
    await fs.unlink(dirtyFile).catch(() => {});
    console.log(`[${project.name}] 送信処理 完了`);
  } else {
    await notifyAdmin(`[${project.name}] 送信処理に失敗しました`, `案件 ${project.name} の送信スクリプトが失敗しました (exit=${res.code})。\n次回のワーカー実行時(次のリクエスト受信時、またはサービス再起動時)に再試行します。\n\n--- 出力(末尾) ---\n${res.out.slice(-3000)}`);
  }
}

module.exports = { runFinalize };
