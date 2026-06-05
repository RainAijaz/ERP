const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const path = require("path");

let client = null;
let clientReady = false;

const initWhatsApp = () => {
  if (client) return;

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(__dirname, "..", "..", ".wwebjs_auth"),
    }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  client.on("qr", (qr) => {
    console.log("\n[WhatsApp] Scan this QR code in WhatsApp to connect:\n");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => {
    clientReady = true;
    console.log("[WhatsApp] Client ready — rate change notifications active");
  });

  client.on("auth_failure", (msg) => {
    console.error("[WhatsApp] Authentication failed:", msg);
    client = null;
    clientReady = false;
  });

  client.on("disconnected", (reason) => {
    console.warn("[WhatsApp] Disconnected:", reason);
    client = null;
    clientReady = false;
  });

  client.initialize().catch((err) => {
    console.error("[WhatsApp] Initialization error:", err.message);
    client = null;
    clientReady = false;
  });
};

const sendWhatsAppMessage = async (chatId, text) => {
  if (!chatId || !String(chatId).trim()) return;
  if (!clientReady || !client) {
    console.warn("[WhatsApp] Client not ready — skipping rate notification");
    return;
  }
  try {
    await client.sendMessage(chatId, text);
  } catch (err) {
    console.error("[WhatsApp] Failed to send message:", err.message);
  }
};

module.exports = { initWhatsApp, sendWhatsAppMessage };
