/*
 * Multi-payee WhatsApp delivery probe — reproduces "only 1 payee got the message".
 *
 * The existing live suite (tests/e2e/whatsapp-live-delivery.spec.js) only ever
 * pays ONE payee per voucher, so the failure mode the user keeps hitting — a
 * cash voucher paying several people where only the first one receives it — has
 * never been exercised end-to-end. This script does exactly that, against a
 * REAL linked WhatsApp client.
 *
 * Two modes:
 *
 *   node src/scripts/probe-multi-payee-whatsapp.js --probe
 *     Lookups only. Calls client.getNumberId() for every number, first
 *     back-to-back with no delay, then spaced by WHATSAPP_SEND_SPACING_MS.
 *     SENDS NOTHING — safe to run any time. Tells us whether the "throttled
 *     getNumberId returns null -> not_on_whatsapp" theory is real.
 *
 *   node src/scripts/probe-multi-payee-whatsapp.js --voucher
 *     Seeds throwaway labours + ONE approved cash voucher paying all of them,
 *     runs the real sendVoucherPaymentNotifications(), prints the resulting
 *     whatsapp_notification_log rows, then optionally drains the retry queue.
 *     This DELIVERS REAL MESSAGES to the numbers below.
 *
 * Everything it creates is deleted again in the cleanup step.
 */
require("dotenv").config();

const knex = require("../db/knex");
const {
  initWhatsApp,
  onWhatsAppReady,
  resolveWhatsAppChatId,
  shutdownWhatsApp,
} = require("../utils/whatsapp");
const {
  sendVoucherPaymentNotifications,
  SEND_SPACING_MS,
  sleep,
} = require("../utils/payment-notification");
const {
  retryQueuedWhatsAppNotifications,
} = require("../utils/payment-notification-retry");
const { normalizePkMobileToChatId } = require("../utils/phone-format");

// The numbers under test (as given). Stored on throwaway labour records so no
// real master data is touched.
const PHONES = [
  "03114673188",
  "03254808004",
  "03254808005",
  "03174297700",
  "03219475956",
];

const TAG = `WAPROBE${Date.now()}`;
const AMOUNT_BASE = 100;

const mode = process.argv.includes("--voucher")
  ? "voucher"
  : process.argv.includes("--probe")
    ? "probe"
    : "probe";

// Both voucher types the notifier acts on, so a pass proves the multi-payee path
// end-to-end for each (they differ in how the money-out amount reaches meta.debit).
const VOUCHER_TYPES = ["CASH_VOUCHER", "JOURNAL_VOUCHER"];

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...args) => console.log(`[${stamp()}]`, ...args);

// initWhatsApp() resolves immediately; the client is only usable after "ready".
const waitForReady = (timeoutMs = 120000) =>
  new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    onWhatsAppReady(() => finish(true));
    setTimeout(() => finish(false), timeoutMs);
    initWhatsApp();
  });

// ---------------------------------------------------------------------------
// Probe: are back-to-back getNumberId() calls actually throttled?
// ---------------------------------------------------------------------------
const runProbe = async () => {
  const msisdns = PHONES.map((p) => {
    const { normalized, reason } = normalizePkMobileToChatId(p);
    if (!normalized) log(`  !! ${p} does not normalize: ${reason}`);
    return { raw: p, msisdn: normalized };
  }).filter((x) => x.msisdn);

  for (const round of [
    { name: `ROUND 1 — back-to-back, NO delay`, delay: 0 },
    { name: `ROUND 2 — spaced ${SEND_SPACING_MS}ms apart`, delay: SEND_SPACING_MS },
  ]) {
    log(`\n=== ${round.name} ===`);
    let i = 0;
    for (const { raw, msisdn } of msisdns) {
      if (i > 0 && round.delay) await sleep(round.delay);
      i += 1;
      const t0 = Date.now();
      const res = await resolveWhatsAppChatId(msisdn);
      const ms = Date.now() - t0;
      log(
        `  ${String(i).padStart(2)}. ${raw} -> ` +
          (res.ok ? `OK ${res.chatId}` : `FAIL ${res.reason}`) +
          `  (${ms}ms)`,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// Voucher: the real end-to-end multi-payee path
// ---------------------------------------------------------------------------
// Create the throwaway payees once; both vouchers pay the same 5 people.
const seedPayees = async () => {
  const labourIds = [];
  for (let i = 0; i < PHONES.length; i++) {
    const [row] = await knex("erp.labours")
      .insert({
        code: `${TAG}_${i + 1}`,
        name: `${TAG} Payee ${i + 1}`,
        name_ur: `ٹیسٹ ${i + 1}`,
        phone: PHONES[i],
        status: "active",
      })
      .returning(["id"]);
    labourIds.push(Number(row.id || row));
  }
  return labourIds;
};

const seedVoucher = async ({ typeCode, labourIds, user, branchId }) => {
  // Park the test voucher well above the real numbering series.
  const maxRow = await knex("erp.voucher_header")
    .where({ branch_id: branchId, voucher_type_code: typeCode })
    .max("voucher_no as m")
    .first();
  const voucherNo = Math.max(Number(maxRow?.m || 0), 990000) + 1;

  const [vh] = await knex("erp.voucher_header")
    .insert({
      voucher_type_code: typeCode,
      voucher_no: voucherNo,
      branch_id: branchId,
      voucher_date: knex.fn.now(),
      status: "APPROVED",
      created_by: user.id,
      approved_by: user.id,
      approved_at: knex.fn.now(),
      remarks: `${TAG} multi-payee WhatsApp probe (${typeCode})`,
    })
    .returning(["id"]);
  const voucherId = Number(vh.id || vh);

  await knex("erp.voucher_line").insert(
    labourIds.map((labourId, i) => ({
      voucher_header_id: voucherId,
      line_no: i + 1,
      line_kind: "LABOUR",
      labour_id: labourId,
      qty: 0,
      rate: AMOUNT_BASE + i,
      amount: AMOUNT_BASE + i,
      meta: {
        // Both cash and journal payment lines carry the money-out amount in
        // meta.debit — that is what the notifier reads (there is no `debit`
        // column on voucher_line).
        debit: AMOUNT_BASE + i,
        credit: 0,
        description: `TEST MESSAGE - PLEASE IGNORE (${typeCode})`,
        ...(typeCode === "CASH_VOUCHER" ? { direction_version: 2 } : { vr_type: "adjustment" }),
      },
    })),
  );

  log(`seeded ${typeCode} #${voucherNo} (id ${voucherId}) paying ${labourIds.length} payees on branch ${branchId}`);
  return { voucherId, voucherNo };
};

const showRows = async (voucherId, heading) => {
  const rows = await knex("erp.whatsapp_notification_log")
    .where({ voucher_header_id: voucherId })
    .orderBy("id");
  log(`\n=== ${heading} — ${rows.length} log row(s) for ${PHONES.length} payees ===`);
  rows.forEach((r) => {
    log(
      `  ${String(r.recipient_name || "").padEnd(28)} ${String(r.phone_raw).padEnd(12)} ` +
        `${String(r.status).padEnd(7)} ${String(r.failure_reason || "-").padEnd(22)} attempts=${r.attempts ?? 0}`,
    );
  });
  const byStatus = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  log(`  summary: ${JSON.stringify(byStatus)}  (missing rows: ${PHONES.length - rows.length})`);
  return rows;
};

const cleanup = async ({ voucherIds = [], labourIds = [] }) => {
  const safe = async (fn) => {
    try {
      await fn();
    } catch (e) {
      console.error("[cleanup]", e.message);
    }
  };
  if (voucherIds.length) {
    await safe(() => knex("erp.whatsapp_notification_log").whereIn("voucher_header_id", voucherIds).del());
    await safe(() => knex("erp.voucher_line").whereIn("voucher_header_id", voucherIds).del());
    await safe(() => knex("erp.voucher_header").whereIn("id", voucherIds).del());
  }
  if (labourIds.length) {
    await safe(() => knex("erp.labour_branch").whereIn("labour_id", labourIds).del());
    await safe(() => knex("erp.labours").whereIn("id", labourIds).del());
  }
  log("cleanup done");
};

const runVoucher = async () => {
  const created = { voucherIds: [], labourIds: [] };
  const results = [];
  try {
    const user = await knex("erp.users").orderBy("id").first();
    if (!user) throw new Error("no users in erp.users");
    const branchId = (await knex("erp.branches").orderBy("id").first())?.id;
    if (!branchId) throw new Error("no branches");

    created.labourIds = await seedPayees();

    for (const typeCode of VOUCHER_TYPES) {
      log(`\n############ ${typeCode} ############`);
      const { voucherId, voucherNo } = await seedVoucher({
        typeCode,
        labourIds: created.labourIds,
        user,
        branchId,
      });
      created.voucherIds.push(voucherId);

      log(`=== running sendVoucherPaymentNotifications (spacing=${SEND_SPACING_MS}ms) ===`);
      const t0 = Date.now();
      await sendVoucherPaymentNotifications({ knex, voucherId });
      log(`notifier finished in ${Date.now() - t0}ms`);

      let rows = await showRows(voucherId, `${typeCode} — AFTER FIRST PASS`);

      if (rows.some((r) => r.status === "QUEUED")) {
        log(`=== draining retry queue (queued rows exist) ===`);
        const summary = await retryQueuedWhatsAppNotifications({ knex, ignoreBackoff: true });
        log(`retry sweep: ${JSON.stringify(summary)}`);
        rows = await showRows(voucherId, `${typeCode} — AFTER RETRY SWEEP`);
      }

      results.push({
        typeCode,
        voucherNo,
        sent: rows.filter((r) => r.status === "SENT").length,
        queued: rows.filter((r) => r.status === "QUEUED").length,
        failed: rows.filter((r) => r.status === "FAILED").length,
        missing: PHONES.length - rows.length,
      });
    }

    log(`\n================ FINAL VERDICT ================`);
    results.forEach((r) =>
      log(
        `  ${r.typeCode.padEnd(15)} #${r.voucherNo}  ` +
          `SENT ${r.sent}/${PHONES.length}  QUEUED ${r.queued}  FAILED ${r.failed}  NO-ROW ${r.missing}`,
      ),
    );
    // A payee legitimately ends FAILED when WhatsApp cannot reach their number, so
    // "everyone delivered" is the wrong bar. What must hold is that every payee got
    // a row with a DEFINITE outcome: no payee silently missing, and nothing left
    // QUEUED (a stuck QUEUED row is the bug — it re-sends for 24h and is hidden
    // from the failures page).
    const stuck = results.filter((r) => r.queued > 0 || r.missing > 0);
    log(
      stuck.length
        ? `  => FAIL: ${stuck.map((r) => r.typeCode).join(", ")} left rows QUEUED or missing`
        : "  => PASS: every payee resolved to a definite SENT/FAILED on both voucher types" +
            " (FAILED = WhatsApp cannot reach that number; fix it in master data)",
    );
  } finally {
    await cleanup(created);
  }
};

(async () => {
  log(`mode=${mode}  spacing=${SEND_SPACING_MS}ms  ackTimeout=${process.env.WHATSAPP_ACK_TIMEOUT_MS || 15000}ms`);
  if (process.env.WHATSAPP_CLIENT_DISABLED === "1") {
    console.error("WHATSAPP_CLIENT_DISABLED=1 — unset it, this probe needs a real client");
    process.exit(1);
  }

  log("connecting WhatsApp client (scan http://localhost:3000/whatsapp-qr if it asks)...");
  const ready = await waitForReady();
  if (!ready) {
    console.error("WhatsApp client never reached ready — aborting");
    await shutdownWhatsApp();
    await knex.destroy();
    process.exit(1);
  }
  log("client ready");

  try {
    if (mode === "probe") await runProbe();
    else await runVoucher();
  } catch (err) {
    console.error("probe failed:", err);
  } finally {
    await shutdownWhatsApp();
    await knex.destroy();
    process.exit(0);
  }
})();
