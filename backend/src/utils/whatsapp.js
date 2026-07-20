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

// Callbacks fired once the client is connected. Lets other modules (e.g. the
// durable payment-notification retry queue) flush on reconnect without this
// file having to require knex — payment-notification.js already requires this
// module, so importing it back would be a circular dependency.
const readyHandlers = [];
const onWhatsAppReady = (fn) => {
  if (typeof fn === "function") readyHandlers.push(fn);
};

// Saving a payee as a WhatsApp contact also writes to the linked phone's own
// address book when this is on. Set WHATSAPP_SYNC_CONTACTS_TO_PHONE=0 to keep
// new contacts inside WhatsApp only.
const SYNC_CONTACTS_TO_PHONE =
  String(process.env.WHATSAPP_SYNC_CONTACTS_TO_PHONE || "1").trim() !== "0";

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
  for (let i = 0; i < toSend.length; i++) {
    if (!clientReady || !client) {
      // Disconnected mid-flush — put all remaining messages back
      const remaining = toSend.slice(i);
      const canAdd = MAX_QUEUE - pendingQueue.length;
      if (canAdd > 0) pendingQueue.unshift(...remaining.slice(0, canAdd));
      break;
    }
    const { chatId, text } = toSend[i];
    try {
      await client.sendMessage(chatId, text);
      console.log("[WhatsApp] ✓ Queued message sent to", chatId);
    } catch (err) {
      console.error("[WhatsApp] ✗ Failed to send queued message:", err.message);
      if (pendingQueue.length < MAX_QUEUE) pendingQueue.unshift({ chatId, text });
    }
  }
};

// Tear down the browser before dropping the client reference. Without this an
// init that fails *after* Chrome launched leaves an orphaned browser holding a
// lock on the session profile, and every later attempt dies with "The browser is
// already running for <userDataDir>" — a permanent reconnect loop.
const destroyClientQuietly = async (staleClient) => {
  if (!staleClient) return;
  try {
    await staleClient.destroy();
  } catch (err) {
    console.warn("[WhatsApp] Error destroying stale client:", err.message);
  }
};

const scheduleReconnect = (baseDelayMs = 15000) => {
  if (reconnectTimer) return;
  reconnectAttempts += 1;
  const delayMs = Math.min(baseDelayMs * reconnectAttempts, 300000);
  console.log(`[WhatsApp] Reconnecting in ${Math.round(delayMs / 1000)}s... (attempt ${reconnectAttempts})`);
  const staleClient = client;
  client = null;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await destroyClientQuietly(staleClient);
    initWhatsApp();
  }, delayMs);
};

// --no-zygote/--single-process keep Chrome's memory footprint down on the Linux
// VPS, but on Windows they break Chrome's frame handling: the client dies during
// startup with "Navigating frame was detached" and never reaches the QR step.
// Keep them off Windows only, so the production (Linux) launch is unchanged.
const buildPuppeteerArgs = () => {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
  ];
  if (process.platform !== "win32") {
    args.push("--no-zygote", "--single-process");
  }
  return args;
};

const initWhatsApp = () => {
  if (client) return;
  // Escape hatch for tests/CI: keep the messaging feature enabled (so callers
  // still record SENT/FAILED) but never launch the Puppeteer client, so no real
  // messages can be delivered. sendWhatsAppMessage then reports client_unavailable.
  if (process.env.WHATSAPP_CLIENT_DISABLED === "1") {
    console.log("[WhatsApp] client disabled via WHATSAPP_CLIENT_DISABLED=1");
    return;
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
      headless: true,
      args: buildPuppeteerArgs(),
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
    readyHandlers.forEach((fn) => {
      try {
        Promise.resolve(fn()).catch((err) =>
          console.error("[WhatsApp] ready handler error:", err?.message || err),
        );
      } catch (err) {
        console.error("[WhatsApp] ready handler error:", err?.message || err);
      }
    });
  });

  client.on("auth_failure", (msg) => {
    console.error("[WhatsApp] Authentication failed:", msg);
    clientReady = false;
    // Leave `client` set: scheduleReconnect takes ownership and destroys it, so
    // the browser holding the session profile is released before we re-init.
    scheduleReconnect(30000);
  });

  client.on("disconnected", (reason) => {
    console.warn("[WhatsApp] Disconnected:", reason);
    clientReady = false;
    if (reason === "LOGOUT") {
      const staleClient = client;
      client = null;
      destroyClientQuietly(staleClient);
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
    // Chrome may already be up even though initialize() rejected, so hand the
    // client to scheduleReconnect to be destroyed rather than dropping it here.
    scheduleReconnect(30000);
  });
};

// Returns a result object so callers that need to record delivery outcome can:
//   { ok: true }                      — handed to WhatsApp successfully
//   { ok: false, queued, reason }     — not delivered now (queued for retry or dropped)
// Existing callers ignore the return value, so their behavior is unchanged.
//
// `queue` (default true) controls the in-memory retry buffer. Payment
// notifications pass queue:false because they own a DURABLE per-row retry queue
// in erp.whatsapp_notification_log — buffering here as well would make both
// retry the same message and deliver it twice.
const sendWhatsAppMessage = async (chatId, text, { queue = true } = {}) => {
  if (!chatId || !String(chatId).trim()) {
    console.warn("[WhatsApp] sendMessage called with no chatId");
    return { ok: false, queued: false, reason: "no_chat_id" };
  }
  if (!clientReady || !client) {
    if (queue && pendingQueue.length < MAX_QUEUE) {
      pendingQueue.push({ chatId, text });
      console.log(`[WhatsApp] Client not ready — message queued (queue size: ${pendingQueue.length})`);
      return { ok: false, queued: true, reason: "client_unavailable" };
    }
    if (queue) console.warn("[WhatsApp] Queue full — dropping message to", chatId);
    return { ok: false, queued: false, reason: queue ? "queue_full" : "client_unavailable" };
  }
  try {
    await client.sendMessage(chatId, text);
    console.log("[WhatsApp] ✓ Message sent successfully to", chatId);
    return { ok: true };
  } catch (err) {
    console.error("[WhatsApp] ✗ Failed to send message:", err.message);
    if (queue && pendingQueue.length < MAX_QUEUE) {
      pendingQueue.push({ chatId, text });
      console.log(`[WhatsApp] Message queued for retry on reconnect (queue size: ${pendingQueue.length})`);
      return { ok: false, queued: true, reason: err.message || "send_error" };
    }
    return { ok: false, queued: false, reason: err.message || "send_error" };
  }
};

// Ask WhatsApp whether a plain MSISDN (e.g. "923001234567") is actually a
// registered user, and get the id to address it by. This matters because
// sendMessage() can resolve without throwing for a number that is not on
// WhatsApp — treating that as success would report a wrong number as delivered.
// Returns { ok: true, chatId } or { ok: false, reason }.
const resolveWhatsAppChatId = async (msisdn) => {
  const digits = String(msisdn || "").replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "no_phone" };
  if (!clientReady || !client) return { ok: false, reason: "client_unavailable" };
  try {
    const numberId = await client.getNumberId(digits);
    if (!numberId) return { ok: false, reason: "not_on_whatsapp" };
    return { ok: true, chatId: numberId._serialized };
  } catch (err) {
    return { ok: false, reason: err?.message || "resolve_error" };
  }
};

// Save a payee into the linked account's WhatsApp contacts (and, with
// syncToAddressbook, the phone's address book) so they show up by name instead
// of a bare number. Best-effort: never let a contact-save failure affect the
// message outcome. Returns { ok } / { ok: false, reason }.
const saveWhatsAppContact = async ({ msisdn, firstName, lastName = "" }) => {
  const digits = String(msisdn || "").replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "no_phone" };
  if (!clientReady || !client) return { ok: false, reason: "client_unavailable" };
  try {
    await client.saveOrEditAddressbookContact(
      digits,
      String(firstName || "").trim() || digits,
      String(lastName || "").trim(),
      SYNC_CONTACTS_TO_PHONE,
    );
    console.log("[WhatsApp] ✓ Saved contact", digits, firstName);
    return { ok: true };
  } catch (err) {
    console.error("[WhatsApp] ✗ Failed to save contact:", err.message);
    return { ok: false, reason: err.message || "save_contact_error" };
  }
};

module.exports = {
  initWhatsApp,
  sendWhatsAppMessage,
  resolveWhatsAppChatId,
  saveWhatsAppContact,
  onWhatsAppReady,
};
