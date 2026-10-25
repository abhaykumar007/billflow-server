// Minimal SMTP mailer. Configure SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.
// Without SMTP the message is logged (development) and `sent` is false.
const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    if (process.env.NODE_ENV !== 'production') console.log(`[mail:dev] to=${to} subject=${subject}\n${text}`);
    else console.warn('[mail] SMTP not configured; email not sent');
    return { sent: false };
  }
  await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
  return { sent: true };
}

module.exports = { sendMail };
