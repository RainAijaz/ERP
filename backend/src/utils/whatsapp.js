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

// whatsapp-web.js MessageAck states.
const ACK_ERROR = -1; // WhatsApp itself rejected the send
const ACK_SERVER = 1; // has left this device and reached WhatsApp's servers

// How long to wait for a just-sent message to leave the device before treating
// it as undelivered. Generous on purpose (see watchForAck).
const ACK_CONFIRM_TIMEOUT_MS = Math.max(
  2000,
  Number(process.env.WHATSAPP_ACK_TIMEOUT_MS ?? 15000),
);

// Pending delivery-ack waiters, correlated by chat id + exact message body.
//
// There is deliberately no message id here. Verified against whatsapp-web.js
// 1.34.7 on a live session: for the "@lid" chat ids that getNumberId() now
// returns, `client.sendMessage()` resolves to **undefined**, and the message_create
// / message_ack events carry `id._serialized === undefined`. So no message id is
// obtainable, and getMessageById() cannot be used at all (it throws
// "Cannot read properties of undefined (reading 'split')" on an undefined id).
//
// An id-based ack check therefore never confirmed anything: every message was
// recorded not_delivered and re-sent on the next sweep even though it really
// arrived. What message_ack DOES carry reliably is `to` (the chat id), `fromMe`,
// and the exact `body`, so waiters match on those.
//
// Caveat: a re-send of byte-identical text to the same chat can be satisfied by
// the earlier copy's ack. That still means that exact text reached that chat, so
// it is accepted rather than papered over with a synthetic id.
const ackWaiters = new Set();

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

  // Delivery-state updates for messages we sent. watchForAck() parks a waiter
  // before sending so it learns the new ack the moment WhatsApp reports it.
  client.on("message_ack", (msg, ack) => {
    if (!msg || msg.fromMe !== true) return;
    const to = String(msg.to || "");
    const body = String(msg.body || "");
    ackWaiters.forEach((waiter) => {
      if (waiter.chatId === to && waiter.body === body) waiter.notify(ack);
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

// client.sendMessage() resolves the moment WhatsApp Web ACCEPTS a message into
// its local outbox — which is BEFORE the message is actually transmitted. Under
// a burst of sends (a voucher paying many payees) WhatsApp silently keeps the
// later messages stuck at ACK_PENDING: sendMessage never throws, so trusting it
// would record a SENT that never reached anyone. So wait for WhatsApp to report
// the message reaching at least ACK_SERVER (proof it left this device); if it
// never does within the window, report it undelivered so the caller re-queues.
//
// The waiter MUST be armed before sendMessage() is called: the first ack lands a
// few hundred ms later, and since no message id is obtainable (see ackWaiters)
// there is no way to look the message up after the fact.
//
// Trade-off: if a message DID leave but its ack never arrives, we may re-queue
// and send it twice. A rare duplicate is far better than silently never
// delivering a payment confirmation.
const watchForAck = (chatId, body) => {
  let latest = null;
  let wake = null;
  const waiter = {
    chatId: String(chatId),
    body: String(body),
    notify: (ack) => {
      latest = Number(ack);
      if (wake) wake();
    },
  };
  ackWaiters.add(waiter);

  const wait = async (message, { timeoutMs = ACK_CONFIRM_TIMEOUT_MS } = {}) => {
    try {
      // Some chat types DO return a Message with a usable ack already set.
      const immediate = Number(message && message.ack);
      if (Number.isFinite(immediate) && immediate >= ACK_SERVER) {
        return { ok: true, ack: immediate, via: "immediate" };
      }

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (Number.isFinite(latest)) {
          if (latest >= ACK_SERVER) return { ok: true, ack: latest, via: "event" };
          if (latest === ACK_ERROR) {
            return { ok: false, reason: "ack_error", ack: latest, via: "event" };
          }
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return {
            ok: false,
            reason: "not_delivered",
            ack: Number.isFinite(latest) ? latest : null,
            via: "timeout",
          };
        }
        // Sleep until the deadline, but wake immediately when an ack arrives.
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, remaining);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
    } finally {
      ackWaiters.delete(waiter);
    }
  };

  return { wait };
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
//
// `confirmDelivery` (default false) makes the send wait for a real server ack
// before reporting success, closing the "false SENT" gap above. Only callers
// that persist the outcome (payment notifications) need it; the fire-and-forget
// rate-change notifier leaves it off so its behavior is unchanged.
const sendWhatsAppMessage = async (
  chatId,
  text,
  { queue = true, confirmDelivery = false } = {},
) => {
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
    // Armed before the send — the first ack can arrive within ~400ms, and there
    // is no message id to look the message up by afterwards.
    const ackWatch = confirmDelivery ? watchForAck(chatId, text) : null;
    const message = await client.sendMessage(chatId, text);

    let ackNote = "";
    if (ackWatch) {
      const acked = await ackWatch.wait(message);
      if (acked.ok) ackNote = ` (ack=${acked.ack} via ${acked.via})`;
      if (!acked.ok) {
        console.warn(
          `[WhatsApp] ✗ Message to ${chatId} not confirmed ` +
            `(ack=${acked.ack ?? "?"}, ${acked.reason}, via=${acked.via}) — treating as undelivered`,
        );
        if (queue && pendingQueue.length < MAX_QUEUE) {
          pendingQueue.push({ chatId, text });
          return { ok: false, queued: true, reason: acked.reason || "not_delivered" };
        }
        return { ok: false, queued: false, reason: acked.reason || "not_delivered" };
      }
    }

    // Keep the "sent successfully to <chatId>" prefix intact — the live delivery
    // suite matches on it to prove the resolved chat id was used.
    console.log(`[WhatsApp] ✓ Message sent successfully to ${chatId}${ackNote}`);
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
// Read back what WhatsApp actually stored — saveOrEditAddressbookContact
// resolves without error even when WhatsApp ignores the write, so a save that
// "succeeded" may not have bound a name to the chat. Returns the stored name and
// whether it's now a saved contact, or null if it couldn't be read.
const readBackContact = async (digits) => {
  try {
    const contact = await client.getContactById(`${digits}@c.us`);
    return {
      name: (contact && (contact.name || contact.pushname)) || null,
      isMyContact: !!(contact && contact.isMyContact),
    };
  } catch {
    return null;
  }
};

const saveWhatsAppContact = async ({ msisdn, firstName, lastName = "" }) => {
  const digits = String(msisdn || "").replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "no_phone" };
  if (!clientReady || !client) return { ok: false, reason: "client_unavailable" };

  const first = String(firstName || "").trim() || digits;
  const last = String(lastName || "").trim();

  // WhatsApp's addressbook save is inconsistent about the number format: some
  // accounts only bind the name when it's passed in E.164 (leading "+"), others
  // want bare digits. Try bare digits first (the documented form); if the read
  // back shows the contact still isn't saved, retry with the "+" form. We verify
  // rather than trust the no-throw so the logs reflect what really happened.
  const attempt = async (numberArg) => {
    try {
      await client.saveOrEditAddressbookContact(
        numberArg,
        first,
        last,
        SYNC_CONTACTS_TO_PHONE,
      );
    } catch (err) {
      return { ok: false, reason: err.message || "save_contact_error" };
    }
    return { ok: true, verified: await readBackContact(digits) };
  };

  let res = await attempt(digits);
  if (res.ok && !(res.verified && res.verified.isMyContact)) {
    const retry = await attempt(`+${digits}`);
    if (retry.ok) res = retry;
  }

  if (!res.ok) {
    console.error("[WhatsApp] ✗ Failed to save contact:", res.reason);
    return res;
  }
  const bound = res.verified && res.verified.isMyContact;
  const label = `${first} ${last}`.trim();
  console.log(
    `[WhatsApp] contact save ${digits} "${label}" — WhatsApp stored: ` +
      `name=${(res.verified && res.verified.name) || "(none)"} isMyContact=${bound ? "yes" : "NO"}`,
  );
  return { ok: true, verified: res.verified };
};

// Graceful teardown for process shutdown. The Puppeteer/Chrome child must be
// destroyed explicitly — if the process is SIGKILLed with Chrome still running,
// the orphan keeps a lock on the session profile and the NEXT start hangs in
// initialize() and never fires "ready" (all messages then queue forever). Clear
// the reconnect timer too so it can't relaunch a client mid-shutdown.
const shutdownWhatsApp = async () => {
  clientReady = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const staleClient = client;
  client = null;
  await destroyClientQuietly(staleClient);
};

module.exports = {
  initWhatsApp,
  sendWhatsAppMessage,
  resolveWhatsAppChatId,
  saveWhatsAppContact,
  onWhatsAppReady,
  shutdownWhatsApp,
};
