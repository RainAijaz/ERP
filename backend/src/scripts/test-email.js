require("dotenv").config();
const { sendMail } = require("../utils/email");

const to = process.env.TEST_EMAIL_TO || process.env.GMAIL_USER;

if (!to) {
  console.error("Set TEST_EMAIL_TO or GMAIL_USER to send a test email.");
  process.exit(1);
}

sendMail({
  to,
  subject: "ERP test email",
  text: "This is a test email from ERP.",
  html: "<p>This is a test email from ERP.</p>",
})
  .then(() => {
    console.log(`Test email sent to ${to}.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
