/**
 * 案件の「最後のデータ送信」。未実施プロンプトがなくなった後、結果が出た各プロンプト(id)について、
 * 案件ごとに設定したコマンド(シェルスクリプト等)を実行する。送信先(リポジトリ等)はプロンプトに書かれ、
 * claude が outbox/<id>/ 内に書き出した指示ファイルを、スクリプトが読む。
 * - 実行前に outbox/<id>/ と結果を機密情報チェック。検出したら送信せず管理者にメール(.dirty に残す)
 * - 失敗したら管理者にメールし、次回のワーカー実行時に再試行(finalize.maxAttempts 回まで。既定3)
 * - コマンドはシェルを介さず実行(引数は配列)。cwd=案件の workDir。
 *   環境変数: PROJECT_NAME PROJECT_DIR RESULT_ID OUTBOX_DIR(=outbox/<id>) DONE_DIR + finalize.env + サーバーの環境変数
 * .dirty の形式: 1行1件 "<id>\t<失敗回数>"
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
  const entries = new Map(); // id -> 失敗回数
  for (const line of (await fs.readFile(dirtyFile, 'utf8').catch(() => '')).split('\n')) {
    const [id, n] = line.split('\t');
    if (id) entries.set(id, Number(n || 0));
  }
  const save = async () => {
    if (!entries.size) await fs.unlink(dirtyFile).catch(() => {});
    else await fs.writeFile(dirtyFile, [...entries].map(([id, n]) => `${id}\t${n}`).join('\n') + '\n');
  };

  if (!project.finalize) {
    entries.clear(); // 送信処理なしの案件
    return save();
  }
  const f = project.finalize;
  const maxAttempts = f.maxAttempts || 3;

  for (const [id, fails] of [...entries]) {
    const outbox = path.join(project.outboxDir, id);

    // 1. 機密情報チェック
    const findings = await scan({ files: [path.join(doneDir, `${id}.md`)], dirs: [outbox], extraPatterns: project.secretPatterns });
    const blockedFile = path.join(queueRoot, `.blocked-${id}`);
    if (findings.length) {
      const summary = [...new Set(findings.map((x) => `${path.relative(project.workDir, x.file)} … ${x.pattern}`))].sort().join('\n');
      const fingerprint = crypto.createHash('sha256').update(summary).digest('hex');
      if ((await fs.readFile(blockedFile, 'utf8').catch(() => '')) !== fingerprint) {
        await notifyAdmin(
          `[${project.name}] 機密情報の疑いがあるため送信を止めました`,
          `案件 ${project.name} (id: ${id}) の送信前チェックで、機密情報らしき内容を検出したため、送信していません(値は本メールに含めていません)。\n\n${summary}\n\n` +
            `内容を確認し、問題があるファイルを ${outbox} から削除/修正してください。次にこの案件のプロンプトを実行するか、サービスを再起動すると、再チェックのうえ送信します。\n` +
            `送信しない場合は、queue/${project.name}/.dirty からこの id の行を消してください。(誤検出の場合は、該当内容を書き換えるか、検出パターンを見直してください)`
        );
        await fs.writeFile(blockedFile, fingerprint);
      }
      console.error(`[${project.name}] ${id}: 機密情報の疑いで送信を中止`);
      continue;
    }
    await fs.unlink(blockedFile).catch(() => {});

    // 2. 送信スクリプト実行
    const res = await exec(f.command, {
      cwd: project.workDir,
      timeoutMs: f.timeoutMs || 10 * 60 * 1000,
      env: { ...process.env, ...(f.env || {}), PROJECT_NAME: project.name, PROJECT_DIR: project.workDir, RESULT_ID: id, OUTBOX_DIR: outbox, DONE_DIR: doneDir },
    });
    await fs.appendFile(path.join(queueRoot, 'finalize.log'), `--- ${new Date().toISOString()} id=${id} exit=${res.code}\n${res.out}\n`);
    if (res.code === 0) {
      entries.delete(id);
      console.log(`[${project.name}] ${id}: 送信処理 完了`);
    } else if (fails + 1 >= maxAttempts) {
      entries.delete(id);
      await notifyAdmin(`[${project.name}] 送信処理が失敗し続けたため諦めました`, `案件 ${project.name} (id: ${id}) の送信スクリプトが ${maxAttempts} 回失敗しました (exit=${res.code})。自動再試行は終了します。\nデータは ${outbox} に残っています。手動で送信してください。\n\n--- 出力(末尾) ---\n${res.out.slice(-3000)}`);
    } else {
      entries.set(id, fails + 1);
      await notifyAdmin(`[${project.name}] 送信処理に失敗しました`, `案件 ${project.name} (id: ${id}) の送信スクリプトが失敗しました (exit=${res.code}, ${fails + 1}/${maxAttempts})。\n次回のワーカー実行時(次のリクエスト受信時、またはサービス再起動時)に再試行します。\n\n--- 出力(末尾) ---\n${res.out.slice(-3000)}`);
    }
  }
  await save();
}

module.exports = { runFinalize };
