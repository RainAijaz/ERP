// email.js
// Purpose: Provides email sending utilities using nodemailer and Gmail credentials from environment variables.
// Used for sending notifications, alerts, and approval emails from the ERP system.
//
// Exports:
// - sendMail: Sends an email with the given parameters (to, subject, html, text).

const nodemailer = require("nodemailer");

const getTransporter = () => {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
};

const sendMail = async ({ to, subject, html, text }) => {
  const transporter = getTransporter();
  if (!transporter) return;

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to,
    subject,
    text,
    html,
  });
};

module.exports = { sendMail };
