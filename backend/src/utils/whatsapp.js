const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const qrcodeImage = require("qrcode");
const path = require("path");

let client = null;
let clientReady = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

// Connection-state breadcrumbs for the admin page (see getWhatsAppStatus).
let lastQrAt = null;
let lastReadyAt = null;
let lastDisconnectReason = null;

// The in-memory outbox for fire-and-forget sends — in practice the rate-change
// and new-article broadcasts to the sales group. Payment notifications stay out
// of it deliberately (they pass queue:false and own durable rows in
// erp.whatsapp_notification_log), so this queue and that table never hold the
// same message.
//
// Entries carry an id and a timestamp so the admin page can list them and drop
// one — or all — before a reconnect flushes the backlog at the group. Nothing
// persists this: a restart empties it, which is itself a valid escape hatch.
const pendingQueue = [];
const MAX_QUEUE = 200;
let pendingSeq = 0;
// Overflow past MAX_QUEUE is lost silently, and a long outage is exactly when
// someone is on this page wondering what became of the missing broadcasts.
let droppedCount = 0;

// Ids cancelled from the admin page. A flush already in progress has spliced its
// batch out of pendingQueue, so removing the entry there cannot stop it — the
// loop consults these before every send instead. That is the case that matters
// most: "Cancel all" pressed seconds after a reconnect, mid-blast.
const cancelledPendingIds = new Set();
let pendingCancelWatermark = 0;

const isPendingCancelled = (entry) =>
  entry.id <= pendingCancelWatermark || cancelledPendingIds.has(entry.id);

// Returns false when the queue is full, so callers keep their existing
// "dropping message" branch.
const enqueuePending = (chatId, text) => {
  if (pendingQueue.length >= MAX_QUEUE) {
    droppedCount += 1;
    return false;
  }
  pendingSeq += 1;
  pendingQueue.push({ id: pendingSeq, chatId, text, queuedAt: new Date() });
  return true;
};

const listPendingMessages = () =>
  pendingQueue.map(({ id, chatId, text, queuedAt }) => ({
    id,
    chatId,
    text,
    queuedAt,
  }));

// Cancels by id even when the entry is no longer in the queue: an in-flight
// flush is holding it, and the watermark/id set is how that copy gets stopped.
const cancelPendingMessage = (id) => {
  const target = Number(id);
  if (!Number.isInteger(target) || target <= 0) return false;
  cancelledPendingIds.add(target);
  const index = pendingQueue.findIndex((entry) => entry.id === target);
  if (index === -1) return false;
  pendingQueue.splice(index, 1);
  return true;
};

// Everything queued so far, including any batch a flush is midway through.
const clearPendingMessages = () => {
  pendingCancelWatermark = pendingSeq;
  const cleared = pendingQueue.length;
  pendingQueue.length = 0;
  droppedCount = 0;
  return cleared;
};

// whatsapp-web.js MessageAck states.
const ACK_ERROR = -1; // WhatsApp itself rejected the send
const ACK_SERVER = 1; // has left this device and reached WhatsApp's servers

// How long to wait for a just-sent message to leave the device before treating
// it as undelivered. Generous on purpose (see watchForAck).
const ACK_CONFIRM_TIMEOUT_MS = Math.max(
  2000,
  Number(process.env.WHATSAPP_ACK_TIMEOUT_MS ?? 15000),
);

// Send circuit breaker.
//
// WhatsApp treats a burst of refused sends as spam behaviour, and the account
// pays for it — up to having the linked device logged out. Before this, a bug
// that made every send look undelivered could keep the retry worker re-sending
// to the same unreachable numbers for 24h with nothing stopping it (exactly what
// happened 2026-07-25: one line received seven copies).
//
// So: count CONSECUTIVE sends that WhatsApp itself refused or never confirmed
// (ack_error / not_delivered). Past the limit, stop sending for a cooldown. Any
// confirmed delivery proves we are healthy and resets the counter. Callers get
// `cooldown`, which is retryable but — like client_unavailable — deliberately
// does not consume a delivery attempt.
const FAILURE_STREAK_LIMIT = Math.max(
  1,
  Number(process.env.WHATSAPP_FAILURE_STREAK_LIMIT ?? 5),
);
const COOLDOWN_MS =
  Math.max(1, Number(process.env.WHATSAPP_COOLDOWN_MINUTES ?? 60)) * 60 * 1000;
const BREAKER_REASONS = new Set(["ack_error", "not_delivered"]);

let failureStreak = 0;
let cooldownUntil = 0;

const cooldownRemainingMs = () => Math.max(0, cooldownUntil - Date.now());
const isCoolingDown = () => cooldownRemainingMs() > 0;

// Called with the outcome of every attempt that actually reached WhatsApp.
const recordSendOutcome = (reason) => {
  if (!reason) {
    failureStreak = 0;
    cooldownUntil = 0;
    return;
  }
  if (!BREAKER_REASONS.has(reason)) return; // transport blips aren't spam signals
  failureStreak += 1;
  if (failureStreak >= FAILURE_STREAK_LIMIT && !isCoolingDown()) {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    console.error(
      `[WhatsApp] Circuit breaker OPEN — ${failureStreak} consecutive refused sends. ` +
        `Pausing all sends for ${Math.round(COOLDOWN_MS / 60000)} minute(s) to protect the account.`,
    );
  }
};

// Snapshot for the admin page. `disabled` distinguishes "switched off on purpose"
// from "should be connected but isn't", which the failures page could not tell
// apart — so an unlinked session looked identical to a blocked account.
const getWhatsAppStatus = () => ({
  ready: Boolean(clientReady && client),
  disabled: String(process.env.WHATSAPP_CLIENT_DISABLED || "").trim() === "1",
  coolingDown: isCoolingDown(),
  cooldownUntil: isCoolingDown() ? new Date(cooldownUntil) : null,
  failureStreak,
  lastQrAt,
  lastReadyAt,
  lastDisconnectReason,
  // In-memory outbox (group broadcasts). Distinct from the durable queued-row
  // count the page gets from the database.
  pendingQueued: pendingQueue.length,
  pendingDropped: droppedCount,
});

const isWhatsAppReady = () => Boolean(clientReady && client);

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
      if (remaining.length > Math.max(canAdd, 0)) {
        droppedCount += remaining.length - Math.max(canAdd, 0);
      }
      break;
    }
    // Cancelled after this batch was spliced out — the whole point of the
    // watermark. Without this check, cancelling during the reconnect blast
    // would empty the queue while the messages already in hand still went out.
    if (isPendingCancelled(toSend[i])) {
      console.log("[WhatsApp] Skipping cancelled queued message to", toSend[i].chatId);
      continue;
    }
    const { chatId, text } = toSend[i];
    try {
      await client.sendMessage(chatId, text);
      console.log("[WhatsApp] ✓ Queued message sent to", chatId);
    } catch (err) {
      console.error("[WhatsApp] ✗ Failed to send queued message:", err.message);
      if (pendingQueue.length < MAX_QUEUE) pendingQueue.unshift(toSend[i]);
      else droppedCount += 1;
    }
  }
  // Safe to forget these now: anything cancelled was either skipped above or had
  // already been spliced out of the queue. Keeping the set would leak ids for
  // the life of the process.
  cancelledPendingIds.clear();
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
    lastQrAt = new Date();
    console.log("\n[WhatsApp] Scan this QR code in WhatsApp to connect:\n");
    writeQrSnapshot(qr).catch((err) => {
      console.error("[WhatsApp] Failed to write QR snapshot:", err.message);
    });
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => {
    clientReady = true;
    lastReadyAt = new Date();
    lastDisconnectReason = null;
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
      if (waiter.matches(to) && waiter.body === body) waiter.notify(ack);
    });
  });

  client.on("auth_failure", (msg) => {
    console.error("[WhatsApp] Authentication failed:", msg);
    clientReady = false;
    lastDisconnectReason = `auth_failure: ${msg}`;
    // Leave `client` set: scheduleReconnect takes ownership and destroys it, so
    // the browser holding the session profile is released before we re-init.
    scheduleReconnect(30000);
  });

  client.on("disconnected", (reason) => {
    console.warn("[WhatsApp] Disconnected:", reason);
    clientReady = false;
    lastDisconnectReason = String(reason || "disconnected");
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
// `chatIds` is every id that identifies the SAME recipient — send to the "@c.us"
// form and WhatsApp reports the ack under the "@lid" (confirmed live 2026-07-28:
// a "@c.us" send timed out with no ack, and the -1 for it surfaced under the lid).
// Matching only the id we addressed therefore always timed out, burning the full
// 15s and then sending a duplicate to the next form. Accept the ack from any
// equivalent id.
const watchForAck = (chatIds, body) => {
  let latest = null;
  let wake = null;
  const ids = new Set(
    (Array.isArray(chatIds) ? chatIds : [chatIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const waiter = {
    matches: (to) => ids.has(String(to)),
    body: String(body),
    notify: (ack) => {
      latest = Number(ack);
      if (wake) wake();
    },
  };
  ackWaiters.add(waiter);

  // Drop the waiter without waiting. Needed when sendMessage() throws: wait() is
  // never reached, so its finally-block cleanup never runs and the waiter would
  // sit in the Set forever — leaking, and able to satisfy a later byte-identical
  // message to the same chat with a stale ack.
  const cancel = () => ackWaiters.delete(waiter);

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

  return { wait, cancel };
};

// One send attempt against one specific chat id. `ackIds` are all ids that mean
// this same recipient, since the ack can surface under any of them. Never throws.
const attemptSend = async (chatId, text, confirmDelivery, ackIds) => {
  // Armed before the send — the first ack can arrive within ~400ms, and there
  // is no message id to look the message up by afterwards.
  const ackWatch = confirmDelivery ? watchForAck(ackIds || [chatId], text) : null;
  let message;
  try {
    message = await client.sendMessage(chatId, text);
  } catch (err) {
    if (ackWatch) ackWatch.cancel();
    console.error(`[WhatsApp] ✗ Failed to send to ${chatId}:`, err.message);
    return { ok: false, reason: err.message || "send_error" };
  }

  if (!ackWatch) return { ok: true, note: "" };

  const acked = await ackWatch.wait(message);
  if (acked.ok) return { ok: true, note: ` (ack=${acked.ack} via ${acked.via})` };

  console.warn(
    `[WhatsApp] ✗ Message to ${chatId} not confirmed ` +
      `(ack=${acked.ack ?? "?"}, ${acked.reason}, via=${acked.via}) — treating as undelivered`,
  );
  return { ok: false, reason: acked.reason || "not_delivered" };
};

// Returns a result object so callers that need to record delivery outcome can:
//   { ok: true, chatId }              — handed to WhatsApp successfully
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
//
// `alternateChatIds` are other addressing forms for the SAME person, tried in
// order only when the preferred one yields no delivery confirmation.
const sendWhatsAppMessage = async (
  chatId,
  text,
  { queue = true, confirmDelivery = false, alternateChatIds = [] } = {},
) => {
  if (!chatId || !String(chatId).trim()) {
    console.warn("[WhatsApp] sendMessage called with no chatId");
    return { ok: false, queued: false, reason: "no_chat_id" };
  }
  if (!clientReady || !client) {
    if (queue && enqueuePending(chatId, text)) {
      console.log(`[WhatsApp] Client not ready — message queued (queue size: ${pendingQueue.length})`);
      return { ok: false, queued: true, reason: "client_unavailable" };
    }
    if (queue) console.warn("[WhatsApp] Queue full — dropping message to", chatId);
    return { ok: false, queued: false, reason: queue ? "queue_full" : "client_unavailable" };
  }

  // Breaker open: WhatsApp has been refusing our sends, so stop hitting it. The
  // durable queue holds these rows without spending an attempt on them.
  if (isCoolingDown()) {
    return {
      ok: false,
      queued: false,
      reason: "cooldown",
      cooldownUntil: new Date(cooldownUntil),
    };
  }

  // Try the preferred id, then any alternate addressing form for the same person
  // (see resolveWhatsAppChatId: the "@lid" and "@c.us" forms of one number are
  // not interchangeable, and which one WhatsApp Web can actually route to
  // depends on what it already has cached locally). Only attempted when the
  // first form produced no delivery confirmation, so a working send never
  // becomes two messages.
  const targets = [];
  for (const id of [chatId, ...(Array.isArray(alternateChatIds) ? alternateChatIds : [])]) {
    const trimmed = String(id || "").trim();
    if (trimmed && !targets.includes(trimmed)) targets.push(trimmed);
  }

  let last = { ok: false, reason: "send_error" };
  for (let i = 0; i < targets.length; i++) {
    // Re-checked each lap: an ack=-1 mid-ladder can trip the breaker, and there
    // is no point walking the remaining addressing forms once it is open.
    if (!clientReady || !client || isCoolingDown()) break;
    const target = targets[i];
    last = await attemptSend(target, text, confirmDelivery, targets);
    // Only a delivery-confirming send can clear or trip the breaker: without
    // confirmDelivery an "ok" means nothing more than "handed to the outbox".
    if (confirmDelivery) recordSendOutcome(last.ok ? null : last.reason);
    if (last.ok) {
      // Keep the "sent successfully to <chatId>" prefix intact — the live delivery
      // suite matches on it to prove the resolved chat id was used.
      console.log(`[WhatsApp] ✓ Message sent successfully to ${target}${last.note || ""}`);
      return { ok: true, chatId: target };
    }
    // ack=-1 is WhatsApp refusing this specific message, not a routing miss. The
    // forms all resolve to the same underlying chat, so re-sending to another one
    // would only deliver a duplicate if it worked — and the evidence is it doesn't.
    if (last.reason === "ack_error") break;
    if (i + 1 < targets.length) {
      console.warn(
        `[WhatsApp] retrying with alternate addressing form ${targets[i + 1]} ` +
          `(${target} failed: ${last.reason})`,
      );
    }
  }

  if (queue && enqueuePending(chatId, text)) {
    console.log(`[WhatsApp] Message queued for retry on reconnect (queue size: ${pendingQueue.length})`);
    return { ok: false, queued: true, reason: last.reason || "send_error" };
  }
  return { ok: false, queued: false, reason: last.reason || "send_error" };
};

const serializeWid = (wid) => {
  if (!wid) return null;
  if (typeof wid === "string") return wid.trim() || null;
  return wid._serialized || null;
};

// Force WhatsApp Web to learn BOTH identifiers for a user — the "@lid" and the
// phone-number "@c.us" wid — and cache the mapping between them locally.
//
// This is the crux of the "only sends if I already have a conversation" bug.
// Since WhatsApp's LID migration, getNumberId() hands back a "@lid" id. A "@lid"
// is only routable when the local store already holds its phone-number binding,
// which it does for anyone you have an existing chat with — and does NOT for a
// number you have never messaged. Priming here creates that binding up front.
// Best-effort: older whatsapp-web.js builds have no such API.
const primeContactIds = async (userId) => {
  if (!userId || typeof client.getContactLidAndPhone !== "function") return {};
  try {
    const pairs = await client.getContactLidAndPhone([userId]);
    const pair = Array.isArray(pairs) ? pairs[0] : pairs;
    return pair && typeof pair === "object" ? pair : {};
  } catch (err) {
    console.warn("[WhatsApp] lid/phone priming failed for", userId, "-", err.message);
    return {};
  }
};

// Can WhatsApp Web actually materialise a chat for this id?
// true = yes, false = definitively no, null = could not tell.
//
// Worth checking before sending, because client.sendMessage() does NOT throw
// when it cannot: internally it does `getChat(id)` and, on a miss, bails with
// `if (!chat) return null` — so the call resolves to undefined, no message is
// ever created, no ack is ever emitted, and the send silently evaporates.
// getChatById() runs that same lookup (and creates the chat when it can).
//
// FAIL OPEN on a throw. getChatById() has been observed on a live 1.34.7 session
// throwing a minified internal error for every id, working numbers included —
// so treating a throw as "unaddressable" would block sends that do work today.
// A throw means "no information", and the send is attempted regardless.
const canAddressChat = async (chatId) => {
  if (!chatId) return false;
  try {
    return !!(await client.getChatById(chatId));
  } catch (err) {
    console.warn(
      `[WhatsApp] chat lookup inconclusive for ${chatId} (${err.message}) — sending anyway`,
    );
    return null;
  }
};

// Ask WhatsApp whether a plain MSISDN (e.g. "923001234567") is actually a
// registered user, and get the id to address it by. This matters because
// sendMessage() can resolve without throwing for a number that is not on
// WhatsApp — treating that as success would report a wrong number as delivered.
//
// Returns { ok: true, chatId, chatIds } or { ok: false, reason }. `chatIds` is
// every addressing form worth trying, best first; sendWhatsAppMessage falls
// through them if the preferred one produces no delivery ack.
const resolveWhatsAppChatId = async (msisdn) => {
  const digits = String(msisdn || "").replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "no_phone" };
  if (!clientReady || !client) return { ok: false, reason: "client_unavailable" };
  try {
    // Still the existence gate: proves the number is a real WhatsApp account
    // before we address it in any form.
    const numberId = await client.getNumberId(digits);
    if (!numberId) return { ok: false, reason: "not_on_whatsapp" };
    const resolvedId = serializeWid(numberId);

    const { lid, pn } = await primeContactIds(resolvedId || `${digits}@c.us`);

    // Phone-number form first. WhatsApp Web can always build a chat from a "@c.us"
    // wid (findOrCreateLatestChat), including for someone never messaged before;
    // a "@lid" only works once its mapping is cached. The hand-built "@c.us" is a
    // last resort and is safe here *only* because getNumberId() already proved the
    // account exists — building one unchecked is what used to report wrong numbers
    // as delivered.
    const candidates = [];
    const consider = (id) => {
      const s = serializeWid(id);
      if (s && !candidates.includes(s)) candidates.push(s);
    };
    consider(pn);
    if (resolvedId && resolvedId.endsWith("@c.us")) consider(resolvedId);
    consider(`${digits}@c.us`);
    consider(resolvedId);
    consider(lid);

    // Stop at the first id WhatsApp can actually open a chat for; the untried
    // remainder stays as fallbacks for the send ladder. Probing lazily matters:
    // getChatById() *creates* the chat when it can, so probing every form would
    // leave a stray empty conversation for each one.
    let addressable = [];
    let inconclusive = false;
    for (let i = 0; i < candidates.length; i++) {
      const verdict = await canAddressChat(candidates[i]);
      if (verdict === null) inconclusive = true;
      if (verdict) {
        addressable = candidates.slice(i);
        break;
      }
    }

    // Give up only when every form was probed and cleanly rejected. If any probe
    // was inconclusive we still try to send — the ack is the real arbiter, and
    // refusing here would turn a working number into a queued no-op.
    if (!addressable.length) {
      if (!inconclusive) {
        console.warn(
          `[WhatsApp] ${digits} is on WhatsApp but no chat could be opened ` +
            `(tried ${candidates.join(", ") || "nothing"})`,
        );
        // Transient, so the caller re-queues rather than marking the payee
        // permanently failed.
        return { ok: false, reason: "chat_unavailable" };
      }
      addressable = candidates;
    }
    if (!addressable.length) return { ok: false, reason: "no_chat_id" };

    return { ok: true, chatId: addressable[0], chatIds: addressable };
  } catch (err) {
    return { ok: false, reason: err?.message || "resolve_error" };
  }
};

// Explain, for one number, exactly how this session can (or cannot) address it.
// Answers "why does it only work for people I already chat with?" with evidence
// rather than inference: whether a chat already existed, what getNumberId()
// returns, whether the lid<->phone binding could be primed, and which addressing
// forms WhatsApp will actually open a chat for. Read-only apart from the chat
// materialisation getChatById() does. Sends nothing.
const diagnoseWhatsAppNumber = async (msisdn) => {
  const digits = String(msisdn || "").replace(/\D/g, "");
  const out = { input: msisdn, digits };
  if (!digits) return { ...out, error: "no_phone" };
  if (!clientReady || !client) return { ...out, error: "client_unavailable" };

  try {
    const contact = await readBackContact(digits);
    out.savedContact = contact ? contact.isMyContact : null;
    out.contactName = contact ? contact.name : null;
  } catch {
    out.savedContact = null;
  }

  try {
    const numberId = await client.getNumberId(digits);
    out.getNumberId = serializeWid(numberId) || null;
    out.isLid = !!(out.getNumberId && out.getNumberId.endsWith("@lid"));
  } catch (err) {
    out.getNumberId = `error: ${err.message}`;
  }

  const primed = await primeContactIds(out.getNumberId || `${digits}@c.us`);
  out.primedPn = primed.pn || null;
  out.primedLid = primed.lid || null;

  // Does a conversation already exist? This is the variable the user observed.
  // Must check BOTH wids: since the LID migration chats are keyed by "@lid", so
  // looking only under the "@c.us" wid reports "no conversation" for every
  // number, including ones with a live thread.
  try {
    const ids = [`${digits}@c.us`, out.primedLid, out.getNumberId].filter(
      (id) => id && !String(id).startsWith("error:"),
    );
    out.chatAlreadyInStore = await client.pupPage.evaluate((chatIds) => {
      const Chat = window.require("WAWebCollections").Chat;
      const factory = window.require("WAWebWidFactory");
      return chatIds.some((id) => {
        try {
          return !!Chat.get(factory.createWid(id));
        } catch {
          return false;
        }
      });
    }, ids);
  } catch (err) {
    out.chatAlreadyInStore = `error: ${err.message}`;
  }

  out.addressable = {};
  for (const form of [primed.pn, `${digits}@c.us`, out.getNumberId, primed.lid]) {
    const id = serializeWid(form);
    if (!id || id in out.addressable) continue;
    out.addressable[id] = await canAddressChat(id);
  }

  out.resolved = await resolveWhatsAppChatId(digits);
  return out;
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
  diagnoseWhatsAppNumber,
  onWhatsAppReady,
  shutdownWhatsApp,
  isWhatsAppReady,
  getWhatsAppStatus,
  listPendingMessages,
  cancelPendingMessage,
  clearPendingMessages,
};
