'use strict';

const { sendMail } = require('./mailer');

/** 管理者(ADMIN_EMAIL)へメール。送信できたら true。失敗してもログに残すだけで例外は投げない。 */
async function notifyAdmin(subject, text) {
  const to = process.env.ADMIN_EMAIL;
  if (!to) {
    console.error('ADMIN_EMAIL 未設定のため通知メールを送れません:', subject);
    return false;
  }
  try {
    await sendMail({ to, subject: `[claude-cli-server] ${subject}`, text });
    return true;
  } catch (e) {
    console.error('通知メール送信失敗:', e.message);
    return false;
  }
}

module.exports = { notifyAdmin };
