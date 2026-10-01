'use strict';

const { sendMail } = require('../mailer');

/** 結果をメール送信する。options: { to: "a@x.com,b@x.com", subject?: "..." } (SMTP 設定は mailer.js 参照) */
module.exports = async function email({ project, id, markdown, options: o }) {
  if (!o.to) throw new Error('email handler: "to" が必要です');
  await sendMail({ to: o.to, subject: o.subject || `[${project.name}] claude result ${id}`, text: markdown });
  return { to: o.to };
};
