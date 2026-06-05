const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const path = require("path");

let client = null;
let clientReady = false;
let reconnectTimer = null;

const SESSION_PATH = path.join(__dirname, "..", "..", ".wwebjs_auth");

const scheduleReconnect = (delayMs = 15000) => {
  if (reconnectTimer) return;
  console.log(`[WhatsApp] Reconnecting in ${delayMs / 1000}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    client = null;
    initWhatsApp();
  }, delayMs);
};

const initWhatsApp = () => {
  if (client) return;

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
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
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    console.log("[WhatsApp] Client ready — rate change notifications active");
  });

  client.on("auth_failure", (msg) => {
    console.error("[WhatsApp] Authentication failed:", msg);
    clientReady = false;
    client = null;
    scheduleReconnect(30000);
  });

  client.on("disconnected", (reason) => {
    console.warn("[WhatsApp] Disconnected:", reason);
    clientReady = false;
    client = null;
    if (reason === "LOGOUT") {
      console.error(
        "[WhatsApp] Session logged out. Delete .wwebjs_auth and restart to re-link.",
      );
    } else {
      scheduleReconnect(15000);
    }
  });

  client.initialize().catch((err) => {
    console.error("[WhatsApp] Initialization error:", err.message);
    clientReady = false;
    client = null;
    scheduleReconnect(30000);
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
    console.log("[WhatsApp] Rate notification sent to group");
  } catch (err) {
    console.error("[WhatsApp] Failed to send message:", err.message);
  }
};

module.exports = { initWhatsApp, sendWhatsAppMessage };
