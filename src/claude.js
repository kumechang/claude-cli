'use strict';

const { spawn } = require('node:child_process');

/**
 * claude CLI を非対話モード(-p)で実行し、JSON 出力を返す。
 * シェルを介さず引数配列で渡すため、プロンプトによるコマンドインジェクションは起きない。
 */
function runClaude(prompt, { bin, args, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', '--output-format', 'json', ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`claude がタイムアウトしました (${timeoutMs}ms)`));
      if (code !== 0) return reject(new Error(`claude が終了コード ${code} で失敗: ${stderr.trim() || stdout.trim()}`));
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* JSON でなければ生テキストとして扱う */
      }
      resolve({ text: json?.result ?? stdout, raw: json ?? stdout });
    });
    child.stdin.end(prompt); // プロンプトは stdin 経由(長さ制限・エスケープ問題を回避)
  });
}

module.exports = { runClaude };
