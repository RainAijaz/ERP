// Durable retry queue for WhatsApp payment notifications.
//
// A transient failure (WhatsApp disconnected, transport error) leaves a QUEUED
// row in erp.whatsapp_notification_log carrying the rendered message. This
// worker re-sends those rows once WhatsApp is back, with capped-exponential
// backoff, and gives up after RETRY_WINDOW_HOURS so a stuck item still surfaces
// on the dashboard alert instead of retrying silently forever.
//
// Unlike the in-memory buffer in whatsapp.js, this survives a server restart —
// which matters because these are payment confirmations to real people.

const {
  sendWhatsAppMessage,
  resolveWhatsAppChatId,
  saveWhatsAppContact,
} = require("./whatsapp");
const { isRetryable, CONTACT_SUFFIX_BY_KIND } = require("./payment-notification");

// Delay before attempt N+1 (minutes); the last value repeats until the window closes.
const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120, 240, 360];
const RETRY_WINDOW_HOURS = Number(process.env.WHATSAPP_RETRY_WINDOW_HOURS || 24);
const RETRY_INTERVAL_MS = Number(process.env.WHATSAPP_RETRY_INTERVAL_MS || 60000);
const BATCH_SIZE = 50;

const backoffMsForAttempt = (attempts) => {
  const idx = Math.min(
    Math.max(Number(attempts) || 1, 1) - 1,
    BACKOFF_MINUTES.length - 1,
  );
  return BACKOFF_MINUTES[idx] * 60 * 1000;
};

const isWindowExpired = (row) => {
  const started = new Date(row.created_at || Date.now()).getTime();
  return Date.now() - started > RETRY_WINDOW_HOURS * 60 * 60 * 1000;
};

// Process one queued row. Returns the resulting status for logging/tests.
const processRow = async ({ knex, row }) => {
  const attempts = (Number(row.attempts) || 0) + 1;
  const now = new Date();

  // Gave up: the retry window has closed. Becomes a permanent failure so it
  // shows on the alerts page for a human.
  if (isWindowExpired(row)) {
    await knex("erp.whatsapp_notification_log").where({ id: row.id }).update({
      status: "FAILED",
      failure_reason: "max_retries_exceeded",
      next_retry_at: null,
      last_attempt_at: now,
      attempts,
    });
    return "FAILED";
  }

  const reschedule = async (failureReason) => {
    await knex("erp.whatsapp_notification_log").where({ id: row.id }).update({
      status: "QUEUED",
      failure_reason: failureReason,
      attempts,
      last_attempt_at: now,
      next_retry_at: new Date(Date.now() + backoffMsForAttempt(attempts)),
    });
    return "QUEUED";
  };

  const failPermanently = async (failureReason) => {
    await knex("erp.whatsapp_notification_log").where({ id: row.id }).update({
      status: "FAILED",
      failure_reason: failureReason,
      next_retry_at: null,
      last_attempt_at: now,
      attempts,
    });
    return "FAILED";
  };

  // Re-resolve every time: the number may have joined WhatsApp since, and the
  // @lid form can change, so a stored chat id must never be reused.
  const resolved = await resolveWhatsAppChatId(row.phone_normalized);
  if (!resolved.ok) {
    return isRetryable(resolved.reason)
      ? reschedule(resolved.reason)
      : failPermanently(resolved.reason);
  }

  const result = await sendWhatsAppMessage(resolved.chatId, row.message_body, {
    queue: false,
  });
  if (!result || !result.ok) {
    const reason = (result && result.reason) || "send_error";
    return isRetryable(reason) ? reschedule(reason) : failPermanently(reason);
  }

  // Delivered. Save the contact if this is our first successful message to them.
  const alreadyMessaged = await knex("erp.whatsapp_notification_log")
    .where({
      recipient_kind: row.recipient_kind,
      recipient_id: row.recipient_id,
      status: "SENT",
    })
    .first();
  if (!alreadyMessaged) {
    await saveWhatsAppContact({
      msisdn: row.phone_normalized,
      firstName: row.recipient_name,
      lastName: CONTACT_SUFFIX_BY_KIND[row.recipient_kind] || "",
    }).catch(() => {});
  }

  await knex("erp.whatsapp_notification_log").where({ id: row.id }).update({
    status: "SENT",
    failure_reason: null,
    next_retry_at: null,
    last_attempt_at: now,
    attempts,
  });
  return "SENT";
};

// Send every queued notification that is due. Never throws.
//
// `ignoreBackoff` is for outage recovery on reconnect: after a long WhatsApp
// outage, every queued row carries a next_retry_at pushed hours into the future
// (capped backoff), so a plain sweep would leave them sitting even though the
// client is finally back. When set, we make the whole backlog due immediately
// and drain it in batches, rather than waiting out each row's stale backoff.
const retryQueuedWhatsAppNotifications = async ({ knex, ignoreBackoff = false }) => {
  const summary = { processed: 0, sent: 0, requeued: 0, failed: 0 };
  try {
    if (ignoreBackoff) {
      // Pull the whole backlog forward to "now"; the due-filter below then picks
      // it up. Rows are re-scheduled to the future as each is claimed, so a
      // failed send won't be re-attempted within this same run.
      await knex("erp.whatsapp_notification_log")
        .where({ status: "QUEUED" })
        .update({ next_retry_at: new Date() });
    }

    // One batch normally; on reconnect, loop so a backlog larger than BATCH_SIZE
    // is fully cleared. Capped so a persistently-requeuing set can't spin.
    const maxBatches = ignoreBackoff ? 20 : 1;
    for (let batch = 0; batch < maxBatches; batch++) {
      const due = await knex("erp.whatsapp_notification_log")
        .where({ status: "QUEUED" })
        .andWhere((qb) =>
          qb.whereNull("next_retry_at").orWhere("next_retry_at", "<=", new Date()),
        )
        .orderBy("created_at", "asc")
        .limit(BATCH_SIZE);
      if (!due.length) break;

      for (const row of due) {
        // Claim the row before sending so an overlapping tick can't double-send it.
        const claimed = await knex("erp.whatsapp_notification_log")
          .where({ id: row.id, status: "QUEUED" })
          .update({ next_retry_at: new Date(Date.now() + backoffMsForAttempt((row.attempts || 0) + 1)) });
        if (!claimed) continue;

        summary.processed += 1;
        try {
          const outcome = await processRow({ knex, row });
          if (outcome === "SENT") summary.sent += 1;
          else if (outcome === "QUEUED") summary.requeued += 1;
          else summary.failed += 1;
        } catch (err) {
          console.error("[WhatsApp] retry row error:", err?.message || err);
        }
      }
    }

    if (summary.processed) {
      console.log(
        `[WhatsApp] retry sweep — processed:${summary.processed} sent:${summary.sent} requeued:${summary.requeued} failed:${summary.failed}`,
      );
    }
  } catch (err) {
    console.error("[WhatsApp] retry sweep error:", err?.message || err);
  }
  return summary;
};

let timer = null;
let running = false;

// Periodic sweep. Also covers the restart case: queued rows outlive the process.
const startWhatsAppRetryWorker = ({ knex }) => {
  if (timer) return timer;
  timer = setInterval(async () => {
    if (running) return; // never let ticks overlap
    running = true;
    try {
      await retryQueuedWhatsAppNotifications({ knex });
    } finally {
      running = false;
    }
  }, RETRY_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  console.log(
    `[WhatsApp] payment retry worker started (every ${Math.round(RETRY_INTERVAL_MS / 1000)}s, giving up after ${RETRY_WINDOW_HOURS}h)`,
  );
  return timer;
};

const stopWhatsAppRetryWorker = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

module.exports = {
  retryQueuedWhatsAppNotifications,
  startWhatsAppRetryWorker,
  stopWhatsAppRetryWorker,
  backoffMsForAttempt,
  BACKOFF_MINUTES,
  RETRY_WINDOW_HOURS,
};
