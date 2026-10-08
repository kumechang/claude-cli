'use strict';

const fs = require('node:fs');
const path = require('node:path');

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が未設定です`);
  return v;
};

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * 案件(project)定義。PROJECTS_FILE (既定 ./projects.json):
 * { "projects": { "<name>": {
 *     "workDir": "/srv/workspace/<name>",      claude を実行するディレクトリ
 *     "instructions": "成果物は ./outbox に…",   claude のシステムプロンプトに追記(--append-system-prompt)
 *     "claudeArgs": ["--allowedTools", "..."],  追加の claude 引数
 *     "outbox": "outbox",                       claude が「送信するデータ」を置く場所(workDir からの相対)
 *     "timeoutMs": 600000, "maxAttempts": 2, "retryDelayMs": 60000,
 *     "finalize": { "command": ["/path/send.sh", "args"], "env": {"K":"V"}, "timeoutMs": 600000 },
 *     "secretPatterns": ["追加の正規表現"],
 *     "returnResult": true,                     true なら GET /jobs/<id> の応答に result.text / error.message を含める(finalize 無しの案件向け)
 *     "tokenEnv": "XGROWTH_API_TOKEN",          この案件専用の Bearer トークンが入っている環境変数名(32文字以上)。全体の API_TOKEN も引き続き使える
 *     "retentionDays": 3                        done/failed の保持日数(超えたら自動削除。省略時は無期限)
 * } } }
 */
function loadProjects(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')).projects || {};
  const projects = {};
  for (const [name, p] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) throw new Error(`不正な案件名: ${name} (${NAME_RE})`);
    const workDir = path.resolve(p.workDir || process.cwd());
    if (p.finalize && !(Array.isArray(p.finalize.command) && p.finalize.command.length)) {
      throw new Error(`案件 ${name}: finalize.command は配列で指定してください`);
    }
    let token = null;
    if (p.tokenEnv) {
      token = process.env[p.tokenEnv] || '';
      if (token.length < 32) throw new Error(`案件 ${name}: 環境変数 ${p.tokenEnv} (案件専用トークン)が未設定、または32文字未満です`);
    }
    if (p.retentionDays !== undefined && !(Number(p.retentionDays) > 0)) throw new Error(`案件 ${name}: retentionDays は正の数で指定してください`);
    projects[name] = {
      name,
      token,
      returnResult: p.returnResult === true,
      retentionDays: p.retentionDays ? Number(p.retentionDays) : null,
      workDir,
      instructions: p.instructions || '',
      claudeArgs: p.claudeArgs || [],
      outboxDir: path.resolve(workDir, p.outbox || 'outbox'),
      timeoutMs: p.timeoutMs || Number(process.env.CLAUDE_TIMEOUT_MS || 10 * 60 * 1000),
      maxAttempts: p.maxAttempts || 2,
      retryDelayMs: p.retryDelayMs ?? 60 * 1000,
      finalize: p.finalize || null,
      secretPatterns: p.secretPatterns || [],
    };
  }
  if (!Object.keys(projects).length) throw new Error(`${file} に案件が1つもありません`);
  return projects;
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1', // 外部公開は Caddy(HTTPS)経由のみ。直接公開するなら HOST=0.0.0.0
  authToken: required('API_TOKEN'),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  queueDir: path.resolve(process.env.QUEUE_DIR || './queue'), // <queueDir>/<project>/{pending,done,failed}
  maxBodyBytes: 1024 * 1024,
  // claude を同時に動かす数(案件内は常に1件ずつ。案件が違えば並列)。1GB の VPS で不安定なら 1 に下げる
  maxConcurrency: Math.max(1, Number(process.env.CLAUDE_MAX_CONCURRENCY || 2)),
  projects: loadProjects(process.env.PROJECTS_FILE || './projects.json'),
  NAME_RE,
};
