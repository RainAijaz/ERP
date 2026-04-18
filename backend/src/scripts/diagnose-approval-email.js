require("dotenv").config();

const knex = require("../db/knex");
const { getActiveAdminEmails } = require("../utils/approval-notifications");
const { sendMail } = require("../utils/email");

const hasValue = (value) => String(value || "").trim().length > 0;

const mask = (value) => {
  const text = String(value || "");
  if (!text) return "(empty)";
  if (text.length <= 4) return "****";
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
};

const main = async () => {
  try {
    const smtpHost = process.env.SMTP_HOST;
    const smtpPort = process.env.SMTP_PORT || "587";
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    const emailFrom =
      process.env.EMAIL_FROM ||
      process.env.SMTP_FROM ||
      process.env.GMAIL_FROM ||
      "";

    const hasSmtp =
      hasValue(smtpHost) && hasValue(smtpUser) && hasValue(smtpPass);
    const hasGmail = hasValue(gmailUser) && hasValue(gmailPass);

    console.log("[diag] transport config");
    console.log(
      JSON.stringify(
        {
          hasSmtp,
          smtpHost: hasValue(smtpHost) ? String(smtpHost) : "(empty)",
          smtpPort: String(smtpPort),
          smtpUser: hasValue(smtpUser) ? mask(smtpUser) : "(empty)",
          smtpPassConfigured: hasValue(smtpPass),
          hasGmail,
          gmailUser: hasValue(gmailUser) ? mask(gmailUser) : "(empty)",
          gmailPassConfigured: hasValue(gmailPass),
          emailFrom: hasValue(emailFrom)
            ? String(emailFrom)
            : "(default transport user)",
        },
        null,
        2,
      ),
    );

    const recipients = await getActiveAdminEmails(knex);
    console.log("[diag] resolved admin recipients");
    console.log(
      JSON.stringify(
        {
          count: recipients.length,
          recipients,
        },
        null,
        2,
      ),
    );

    if (process.argv.includes("--send-test")) {
      if (!recipients.length) {
        console.log("[diag] skipped test mail: no admin recipients found");
      } else {
        const timestamp = new Date().toISOString();
        const result = await sendMail({
          to: recipients,
          subject: `[ERP DIAG] Approval Mail Test ${timestamp}`,
          text: `Approval email diagnostic test at ${timestamp}`,
          html: `<p>Approval email diagnostic test at <strong>${timestamp}</strong></p>`,
        });
        console.log("[diag] sendMail result");
        console.log(JSON.stringify(result || { sent: false }, null, 2));
      }
    }
  } catch (err) {
    console.error("[diag] failed", err?.message || err);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
};

main();
