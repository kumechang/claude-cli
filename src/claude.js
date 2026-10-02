'use strict';

const { spawn } = require('node:child_process');

/**
 * claude CLI を非対話モード(-p)で実行し、JSON 出力を返す。
 * シェルを介さず引数配列で渡すため、プロンプトによるコマンドインジェクションは起きない。
 */
// claude に渡す環境変数は最小限にする。サーバーの秘密情報(API_TOKEN, SMTP_PASS, GitHub トークン等)を
// claude(Bash ツール等)が読めないようにするため。ANTHROPIC_API_KEY も渡さない(サブスクリプション認証のみ使用)。
const PASS_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ', 'SHELL', 'CLAUDE_CODE_OAUTH_TOKEN', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'];
const claudeEnv = () => Object.fromEntries(PASS_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));

function runClaude(prompt, { bin, args, cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', '--output-format', 'json', ...args], {
      cwd,
      env: claudeEnv(),
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
