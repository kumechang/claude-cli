'use strict';

/**
 * 外部へ送る前の簡易な機密情報チェック(ヒューリスティック。完全ではない)。
 * 検出したら送信せず管理者にメールする。メール本文には「ファイル名 + 検出パターン名」だけを載せ、値は載せない。
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const PATTERNS = [
  ['秘密鍵', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['AWS アクセスキー', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub トークン', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['Anthropic キー/トークン', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI 形式のキー', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['Slack トークン', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API キー', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Bearer トークン', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/],
  ['認証情報らしい代入', /\b(?:api[_-]?key|secret|passw(?:or)?d|token|credential)s?\b["']?\s*[:=]\s*["']?[A-Za-z0-9/+_.=-]{16,}/i],
];

const MAX_BYTES = 2 * 1024 * 1024;

async function* walk(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** files(絶対パス) と dirs(再帰)を検査し、[{file, pattern}] を返す。 */
async function scan({ files = [], dirs = [], extraPatterns = [] }) {
  const all = [...PATTERNS, ...extraPatterns.map((r) => [`独自パターン ${r}`, new RegExp(r)])];
  const targets = [...files];
  for (const d of dirs) for await (const f of walk(d)) targets.push(f);
  const findings = [];
  for (const file of targets) {
    const buf = await fs.readFile(file).catch(() => null);
    if (!buf) continue;
    const text = buf.subarray(0, MAX_BYTES).toString('latin1'); // バイナリでも検査できるよう latin1
    for (const [name, re] of all) if (re.test(text)) findings.push({ file, pattern: name });
  }
  return findings;
}

module.exports = { scan };
