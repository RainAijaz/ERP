const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const qrcodeImage = require("qrcode");
const path = require("path");

let client = null;
let clientReady = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

const pendingQueue = [];
const MAX_QUEUE = 200;

const SESSION_PATH = path.join(__dirname, "..", "..", ".wwebjs_auth");
const QR_OUTPUT_FILE = path.join(__dirname, "..", "..", "public", "whatsapp-qr.png");

const writeQrSnapshot = async (qr) => {
  try {
    await qrcodeImage.toFile(QR_OUTPUT_FILE, qr, {
      margin: 1,
      scale: 8,
      errorCorrectionLevel: "M",
    });
  } catch (err) {
    console.error("[WhatsApp] Failed to write QR snapshot:", err.message);
  }
};

const flushPendingQueue = async () => {
  if (!clientReady || !client || !pendingQueue.length) return;
  console.log(`[WhatsApp] Flushing ${pendingQueue.length} queued message(s)...`);
  const toSend = pendingQueue.splice(0, pendingQueue.length);
  for (const { chatId, text } of toSend) {
    try {
      await client.sendMessage(chatId, text);
      console.log("[WhatsApp] ✓ Queued message sent to", chatId);
    } catch (err) {
      console.error("[WhatsApp] ✗ Failed to send queued message:", err.message);
      // Put back so it retries on the next reconnect
      if (pendingQueue.length < MAX_QUEUE) pendingQueue.unshift({ chatId, text });
    }
  }
};

const scheduleReconnect = (baseDelayMs = 15000) => {
  if (reconnectTimer) return;
  reconnectAttempts += 1;
  const delayMs = Math.min(baseDelayMs * reconnectAttempts, 300000);
  console.log(`[WhatsApp] Reconnecting in ${Math.round(delayMs / 1000)}s... (attempt ${reconnectAttempts})`);
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
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-extensions",
      ],
    },
    webVersionCache: {
      type: "local",
      path: path.join(__dirname, "..", "..", ".wwebjs_cache"),
    },
  });

  client.on("qr", (qr) => {
    console.log("\n[WhatsApp] Scan this QR code in WhatsApp to connect:\n");
    writeQrSnapshot(qr).catch((err) => {
      console.error("[WhatsApp] Failed to write QR snapshot:", err.message);
    });
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => {
    clientReady = true;
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    console.log("[WhatsApp] Client ready — rate change notifications active");
    flushPendingQueue().catch((err) => {
      console.error("[WhatsApp] Error flushing pending queue:", err.message);
    });
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
  if (!chatId || !String(chatId).trim()) {
    console.warn("[WhatsApp] sendMessage called with no chatId");
    return;
  }
  if (!clientReady || !client) {
    if (pendingQueue.length < MAX_QUEUE) {
      pendingQueue.push({ chatId, text });
      console.log(`[WhatsApp] Client not ready — message queued (queue size: ${pendingQueue.length})`);
    } else {
      console.warn("[WhatsApp] Queue full — dropping message to", chatId);
    }
    return;
  }
  try {
    await client.sendMessage(chatId, text);
    console.log("[WhatsApp] ✓ Rate notification sent successfully to group");
  } catch (err) {
    console.error("[WhatsApp] ✗ Failed to send message:", err.message);
    if (pendingQueue.length < MAX_QUEUE) {
      pendingQueue.push({ chatId, text });
      console.log(`[WhatsApp] Message queued for retry on reconnect (queue size: ${pendingQueue.length})`);
    }
  }
};

module.exports = { initWhatsApp, sendWhatsAppMessage };
