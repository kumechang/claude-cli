'use strict';

/**
 * claude CLI の認証ヘルスチェック。
 * `claude auth status` はローカルの状態しか見ず、失効/無効化したトークンを検出できないため、
 * 実際に最小のプロンプトを投げて確認する(HEALTHCHECK_ARGS で軽量モデル指定など可)。
 *
 * - 起動時と HEALTHCHECK_INTERVAL_MS(既定 30 分)ごとに実行
 * - 正常→異常に変わった時に管理者(ADMIN_EMAIL)へメール。異常が続く間は HEALTHCHECK_REMIND_MS(既定 24h)ごとに再通知
 * - 異常→正常に戻った時に復旧メール
 * - 認証が異常の間は jobs のワーカーを止め、プロンプトは pending に残す(復旧後に自動再開)
 */

const config = require('./config');
const { runClaude } = require('./claude');
const { sendMail } = require('./mailer');

const AUTH_RE = /not logged in|please run .*login|\/login|unauthori[sz]ed|authenticat|invalid api key|invalid.*(token|credential)|token.*(expired|revoked|invalid)|\b401\b|\b403\b|oauth/i;
const isAuthError = (msg) => AUTH_RE.test(String(msg));

const state = { ok: true, kind: null, error: null, checkedAt: null, failingSince: null, notifiedAt: null };
let timer = null;
let onRecover = () => {};
let checking = null;

const env = (k, d) => process.env[k] ?? d;

async function notify(subject, text) {
  const to = env('ADMIN_EMAIL');
  if (!to) return console.error('ADMIN_EMAIL 未設定のため通知メールを送れません:', subject);
  try {
    await sendMail({ to, subject, text });
  } catch (e) {
    console.error('通知メール送信失敗:', e.message);
    return false;
  }
  return true;
}

/** 失敗を記録(ヘルスチェック・ジョブ実行どちらからも呼ぶ)。 */
async function reportFailure(error) {
  const now = Date.now();
  const kind = isAuthError(error) ? 'auth' : 'error';
  const first = state.ok;
  Object.assign(state, { ok: false, kind, error: String(error).slice(0, 2000), checkedAt: new Date(now).toISOString() });
  if (first) state.failingSince = state.checkedAt;
  const remind = now - (state.notifiedAt || 0) >= Number(env('HEALTHCHECK_REMIND_MS', 24 * 3600 * 1000));
  if (first || remind) {
    const title = kind === 'auth' ? 'claude CLI の認証が切れています' : 'claude CLI のヘルスチェックに失敗しました';
    const sent = await notify(
      `[claude-cli-server] ${title}`,
      `${title}。\n\n発生: ${state.failingSince}\n原因:\n${state.error}\n\n` +
        (kind === 'auth' ? 'サーバーで `claude auth login` をやり直してください。それまで案件のプロンプトは pending に溜まり、復旧後に自動で再開します。\n' : '')
    );
    if (sent) state.notifiedAt = now;
  }
}

async function check() {
  if (checking) return checking; // 多重実行防止
  checking = (async () => {
    try {
      await runClaude('Reply with: ok', {
        bin: config.claudeBin,
        args: env('HEALTHCHECK_ARGS', '').split(' ').filter(Boolean),
        cwd: process.cwd(),
        timeoutMs: Number(env('HEALTHCHECK_TIMEOUT_MS', 120000)),
      });
      const recovered = !state.ok;
      const since = state.failingSince;
      Object.assign(state, { ok: true, kind: null, error: null, checkedAt: new Date().toISOString(), failingSince: null, notifiedAt: null });
      if (recovered) {
        await notify('[claude-cli-server] claude CLI が復旧しました', `ヘルスチェックに成功しました。異常発生: ${since}\n保留中のプロンプトの処理を再開します。`);
        onRecover();
      }
    } catch (e) {
      await reportFailure(e.message);
    } finally {
      checking = null;
    }
    return state;
  })();
  return checking;
}

function start({ recover } = {}) {
  onRecover = recover || onRecover;
  const every = Number(env('HEALTHCHECK_INTERVAL_MS', 30 * 60 * 1000));
  if (every <= 0) return; // 0 で無効化
  check();
  timer = setInterval(check, every);
  timer.unref();
}

const stop = () => clearInterval(timer);
const snapshot = () => ({ ...state });
/** 認証が壊れていると判明している間は新規ジョブを実行しない。 */
const canRun = () => !(state.ok === false && state.kind === 'auth');

module.exports = { start, stop, check, reportFailure, snapshot, canRun, isAuthError };
