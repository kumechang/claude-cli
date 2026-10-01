'use strict';

/**
 * 結果処理ハンドラのレジストリ。新しい処理(メール送信など)は
 * src/handlers/<type>.js を作り、下に1行足すだけ。
 *   async function handler({ project, id, prompt, result, markdown, options }) -> meta(JSON)
 * 失敗しても他のハンドラと実行結果には影響しない(エラーは meta に記録)。
 */
const registry = {
  github: require('./github'),
};

async function runHandlers(project, ctx) {
  const out = [];
  for (const options of project.handlers) {
    const entry = { type: options.type };
    try {
      const h = registry[options.type];
      if (!h) throw new Error(`未知のハンドラ: ${options.type}`);
      entry.result = await h({ ...ctx, project, options });
    } catch (e) {
      entry.error = e.message;
      console.error(`[${project.name}] handler ${options.type} failed for ${ctx.id}:`, e.message);
    }
    out.push(entry);
  }
  return out;
}

const validate = (projects) => {
  for (const p of Object.values(projects))
    for (const h of p.handlers)
      if (!registry[h.type]) throw new Error(`案件 ${p.name}: 未知のハンドラ "${h.type}"`);
};

module.exports = { runHandlers, validate, registry };
