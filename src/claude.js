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
      detached: true, // 独立したプロセスグループにして、タイムアウト時に子プロセスごと止められるようにする
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* 既に終了 */ } };

    const timer = setTimeout(() => {
      // 子プロセスが出力の口を握ったままでも待たずに、すぐ失敗として返す(呼び出し側の待ち時間より前に確実に決着させる)
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5000).unref();
      done(reject, new Error(`claude がタイムアウトしました (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => done(reject, e));
    child.on('close', (code) => {
      if (code !== 0) return done(reject, new Error(`claude が終了コード ${code} で失敗: ${stderr.trim() || stdout.trim()}`));
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* JSON でなければ生テキストとして扱う */
      }
      done(resolve, { text: json?.result ?? stdout, raw: json ?? stdout });
    });
    child.stdin.on('error', () => {}); // 子が先に終了した場合の EPIPE を無視
    child.stdin.end(prompt); // プロンプトは stdin 経由(長さ制限・エスケープ問題を回避)
  });
}

module.exports = { runClaude };
