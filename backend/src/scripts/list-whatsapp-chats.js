/**
 * Run this script once to find the WhatsApp group chat ID.
 * Copy the ID of your salesman group and paste it into .env as WHATSAPP_RATE_NOTIFY_CHAT_ID
 *
 * Usage: node src/scripts/list-whatsapp-chats.js
 */
require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const path = require("path");

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, "..", "..", ".wwebjs_auth"),
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  console.log("\nScan this QR code in WhatsApp:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  console.log("\nConnected! Fetching chats...\n");

  const chats = await client.getChats();
  const groups = chats.filter((c) => c.isGroup);

  if (!groups.length) {
    console.log("No groups found. Create a WhatsApp group for your salesmen first.");
  } else {
    console.log("=== WhatsApp Groups ===");
    groups.forEach((g) => {
      console.log(`Name : ${g.name}`);
      console.log(`ID   : ${g.id._serialized}`);
      console.log("-----");
    });
    console.log("\nCopy the ID of your salesman group and add to .env:");
    console.log("WHATSAPP_RATE_NOTIFY_CHAT_ID=<paste-id-here>");
  }

  await client.destroy();
  process.exit(0);
});

client.on("auth_failure", () => {
  console.error("Auth failed. Delete .wwebjs_auth folder and try again.");
  process.exit(1);
});

client.initialize();
