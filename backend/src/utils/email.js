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
