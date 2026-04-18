// email.js
// Purpose: Provides email sending utilities using nodemailer.
// Supports SMTP env config and Gmail app-password fallback.

const nodemailer = require("nodemailer");

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
};

let warnedMissingConfig = false;

const createSmtpTransporter = () => {
  const host = String(process.env.SMTP_HOST || "").trim();
  const portRaw = Number(process.env.SMTP_PORT || 0);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 587;
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "").trim();
  const secure = toBool(process.env.SMTP_SECURE, port === 465);
  const from =
    String(process.env.EMAIL_FROM || process.env.SMTP_FROM || "").trim() ||
    user;

  if (!host || !user || !pass) return null;

  return {
    mode: "smtp",
    from,
    transporter: nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    }),
  };
};

const createGmailTransporter = () => {
  const user = String(process.env.GMAIL_USER || "").trim();
  const pass = String(process.env.GMAIL_APP_PASSWORD || "").trim();
  const from =
    String(process.env.EMAIL_FROM || process.env.GMAIL_FROM || "").trim() ||
    user;

  if (!user || !pass) return null;

  return {
    mode: "gmail",
    from,
    transporter: nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    }),
  };
};

const getTransporter = () => {
  const smtp = createSmtpTransporter();
  if (smtp) return smtp;

  const gmail = createGmailTransporter();
  if (gmail) return gmail;

  if (!warnedMissingConfig) {
    warnedMissingConfig = true;
    console.warn(
      "[email] mail transport not configured. Set SMTP_HOST/SMTP_USER/SMTP_PASS or GMAIL_USER/GMAIL_APP_PASSWORD.",
    );
  }

  return null;
};

const sendMail = async ({ to, subject, html, text }) => {
  const transportContext = getTransporter();
  if (!transportContext) {
    return null;
  }

  await transportContext.transporter.sendMail({
    from: transportContext.from,
    to,
    subject,
    text,
    html,
  });

  return { sent: true, mode: transportContext.mode };
};

module.exports = { sendMail };
