/*
 * Integration test for the WhatsApp payment-notification engine.
 *
 * Runs the REAL `sendVoucherPaymentNotifications` against the REAL database
 * (validating the actual SQL/schema), but stubs the WhatsApp transport so NO
 * real message is ever delivered. Seeds a cash voucher paying several parties,
 * asserts the SENT/FAILED log rows + Urdu message content, then cleans up.
 *
 *   npm run test:payment-notification
 */
require("dotenv").config();
const path = require("path");

// --- Stub ./whatsapp BEFORE the service requires it (no real sends) ---
const waPath = require.resolve(path.join(__dirname, "..", "utils", "whatsapp.js"));
const sent = [];
const savedContacts = [];
const inMemoryQueued = []; // anything the transport buffered itself (must stay empty)
// Flip to simulate WhatsApp being disconnected.
const transport = { offline: false };

require.cache[waPath] = {
  id: waPath,
  filename: waPath,
  loaded: true,
  exports: {
    initWhatsApp: () => {},
    onWhatsAppReady: () => {},
    // Stand in for WhatsApp's number lookup: 92300000000x is treated as a
    // well-formed number that is NOT registered on WhatsApp.
    resolveWhatsAppChatId: async (msisdn) => {
      const digits = String(msisdn || "").replace(/\D/g, "");
      if (transport.offline) return { ok: false, reason: "client_unavailable" };
      if (digits.startsWith("9230000000")) return { ok: false, reason: "not_on_whatsapp" };
      return { ok: true, chatId: `${digits}@c.us` };
    },
    sendWhatsAppMessage: async (chatId, text, { queue = true } = {}) => {
      if (transport.offline) {
        // Mirror the real module: it only buffers when queue !== false.
        if (queue) inMemoryQueued.push({ chatId, text });
        return { ok: false, queued: queue, reason: "client_unavailable" };
      }
      sent.push({ chatId, text });
      return { ok: true };
    },
    saveWhatsAppContact: async ({ msisdn, firstName, lastName }) => {
      savedContacts.push({ msisdn, firstName, lastName });
      return { ok: true };
    },
  },
};

const knex = require("../db/knex");
const { sendVoucherPaymentNotifications } = require("../utils/payment-notification");
const {
  retryQueuedWhatsAppNotifications,
} = require("../utils/payment-notification-retry");

let failures = 0;
const check = (name, cond) => {
  const ok = Boolean(cond);
  console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}`);
  if (!ok) failures += 1;
};

const TAG = `PN_TEST_${Date.now()}`;
const created = { partyIds: [], labourIds: [], employeeIds: [], voucherId: null };

(async () => {
  const branch = await knex("erp.branches").select("id").orderBy("id", "asc").first();
  const user = await knex("erp.users").select("id").orderBy("id", "asc").first();
  if (!branch || !user) {
    console.error("No branch/user in DB — cannot run test");
    process.exit(1);
  }

  const mkParty = async (name, partyType, phone1, nameUr) => {
    const [row] = await knex("erp.parties")
      .insert({ code: `${TAG}_${name}`, name: `${TAG} ${name}`, name_ur: nameUr || null, party_type: partyType, phone1, created_by: user.id })
      .returning(["id"]);
    const id = Number(row.id || row);
    created.partyIds.push(id);
    return id;
  };
  const mkLabour = async (name, phone) => {
    const [row] = await knex("erp.labours").insert({ code: `${TAG}_${name}`, name: `${TAG} ${name}`, phone }).returning(["id"]);
    const id = Number(row.id || row);
    created.labourIds.push(id);
    return id;
  };
  const mkEmployee = async (name, phone) => {
    const [row] = await knex("erp.employees").insert({ code: `${TAG}_${name}`, name: `${TAG} ${name}`, phone }).returning(["id"]);
    const id = Number(row.id || row);
    created.employeeIds.push(id);
    return id;
  };

  // --- Seed master rows with known phones ---
  const supplierValid = await mkParty("SupplierValid", "SUPPLIER", "0300-1112223", "سپلائر"); // -> SENT (aggregated); has Urdu name
  const supplierNoPhone = await mkParty("SupplierNoPhone", "SUPPLIER", null); // -> FAILED no_phone
  const supplierNotOnWa = await mkParty("SupplierNotOnWa", "SUPPLIER", "0300-0000001"); // valid format, not a WhatsApp user
  const supplierCredit = await mkParty("SupplierCredit", "BOTH", "03004445556"); // credit only -> NO row
  const customer = await mkParty("Customer", "CUSTOMER", "03005556667"); // customer -> NO row
  const labour = await mkLabour("Labour", "021-7654321"); // landline -> FAILED invalid_phone
  const employee = await mkEmployee("Employee", "0321-9998887"); // -> SENT

  // --- Seed an APPROVED cash voucher paying them ---
  const maxRow = await knex("erp.voucher_header").max("voucher_no as max").first();
  const voucherNo = Number(maxRow?.max || 0) + 1;
  const [vh] = await knex("erp.voucher_header")
    .insert({
      voucher_type_code: "CASH_VOUCHER",
      voucher_no: voucherNo,
      branch_id: branch.id,
      voucher_date: knex.fn.now(),
      status: "APPROVED",
      created_by: user.id,
      approved_by: user.id,
      approved_at: knex.fn.now(),
    })
    .returning(["id"]);
  const voucherId = Number(vh.id || vh);
  created.voucherId = voucherId;

  const line = (line_no, kind, ref, debit, credit, description) => ({
    voucher_header_id: voucherId,
    line_no,
    line_kind: kind,
    party_id: kind === "PARTY" ? ref : null,
    labour_id: kind === "LABOUR" ? ref : null,
    employee_id: kind === "EMPLOYEE" ? ref : null,
    amount: debit || credit || 0,
    meta: JSON.stringify({ debit: debit || 0, credit: credit || 0, description: description || "" }),
  });

  await knex("erp.voucher_line").insert([
    line(1, "PARTY", supplierValid, 5000, 0, "Cloth purchase"),
    line(2, "PARTY", supplierValid, 1500, 0, "Buttons"), // aggregates -> 6500
    line(3, "PARTY", supplierNoPhone, 800, 0, "Payment"),
    line(4, "PARTY", supplierCredit, 0, 700, "Received"), // credit only -> skipped
    line(5, "PARTY", customer, 300, 0, "Refund"), // customer -> skipped
    line(6, "LABOUR", labour, 900, 0, "Wages"),
    line(7, "EMPLOYEE", employee, 1200, 0, "Salary"),
    line(8, "PARTY", supplierNotOnWa, 400, 0, "Transport"),
  ]);

  // --- Run the real notifier ---
  await sendVoucherPaymentNotifications({ knex, voucherId });

  // --- Read back the log ---
  const logs = await knex("erp.whatsapp_notification_log")
    .where({ voucher_header_id: voucherId })
    .orderBy("recipient_kind", "asc");
  const byName = (needle) => logs.find((r) => String(r.recipient_name || "").includes(needle));

  console.log(`\nSeeded voucher #${voucherNo} (id ${voucherId}); ${logs.length} log row(s), ${sent.length} message(s) sent.\n`);

  const sv = byName("SupplierValid");
  check("SupplierValid logged", !!sv);
  check("SupplierValid status SENT", sv && sv.status === "SENT");
  check("SupplierValid amount aggregated to 6500", sv && Number(sv.amount) === 6500);
  check("SupplierValid phone normalized to 923001112223", sv && sv.phone_normalized === "923001112223");

  const snp = byName("SupplierNoPhone");
  check("SupplierNoPhone status FAILED/no_phone", snp && snp.status === "FAILED" && snp.failure_reason === "no_phone");

  const lab = byName("Labour");
  check("Labour status FAILED/invalid_phone", lab && lab.status === "FAILED" && lab.failure_reason === "invalid_phone");

  const emp = byName("Employee");
  check("Employee status SENT", emp && emp.status === "SENT");
  check("Employee amount 1200", emp && Number(emp.amount) === 1200);

  const nowa = byName("SupplierNotOnWa");
  check("Valid-format number that isn't a WhatsApp user -> FAILED/not_on_whatsapp",
    nowa && nowa.status === "FAILED" && nowa.failure_reason === "not_on_whatsapp");
  check("Non-WhatsApp number was NOT reported as sent", !sent.some((m) => m.chatId.startsWith("9230000000")));

  check("Customer NOT notified (skipped)", !byName("Customer"));
  check("SupplierCredit NOT notified (credit-only line skipped)", !byName("SupplierCredit"));
  check("Exactly 5 log rows (2 SENT + 3 FAILED)", logs.length === 5);
  check("Exactly 2 messages sent", sent.length === 2);

  const svMsg = sent.find((m) => m.chatId === "923001112223@c.us");
  check("SupplierValid message sent to correct chat id", !!svMsg);
  check("Message is Urdu payment notice", svMsg && svMsg.text.includes("ادائیگی کی اطلاع"));
  check("Message states amount paid (6,500)", svMsg && svMsg.text.includes("6,500"));
  check("Message lists both line descriptions", svMsg && svMsg.text.includes("Cloth purchase") && svMsg.text.includes("Buttons"));
  check("Message does NOT expose the voucher number", svMsg && !svMsg.text.includes(`#${voucherNo}`) && !svMsg.text.includes("واؤچر"));
  check("Message greeting shows Urdu name in brackets", svMsg && svMsg.text.includes("SupplierValid (سپلائر)"));

  // --- Contact saving: first message only ---
  check("Contact saved for each newly-messaged payee (2)", savedContacts.length === 2);
  const svContact = savedContacts.find((c) => c.msisdn === "923001112223");
  check("Contact saved with the payee's name", svContact && svContact.firstName.includes("SupplierValid"));
  check("Contact name includes Urdu name in brackets", svContact && svContact.firstName.includes("(سپلائر)"));
  check("Contact tagged by kind", svContact && svContact.lastName === "(ERP Supplier)");
  check("No contact saved for failed sends", !savedContacts.some((c) => c.msisdn.startsWith("9230000000")));

  // Re-running must NOT re-save contacts (they now have a prior SENT row).
  savedContacts.length = 0;
  sent.length = 0;
  await sendVoucherPaymentNotifications({ knex, voucherId });
  check("Second run re-sends but does NOT re-save contacts", sent.length === 2 && savedContacts.length === 0);

  if (svMsg) console.log("\n--- Sample message ---\n" + svMsg.text + "\n----------------------");
  if (svContact) console.log(`--- Sample contact --- ${svContact.firstName} ${svContact.lastName}  (${svContact.msisdn})`);

  // ============================================================
  // Durable retry queue
  // ============================================================
  console.log("\n=== retry queue ===");

  // Clear this voucher's log so the queue scenarios start clean.
  await knex("erp.whatsapp_notification_log").where({ voucher_header_id: voucherId }).del();
  sent.length = 0;
  savedContacts.length = 0;
  inMemoryQueued.length = 0;

  // --- WhatsApp offline: transient failures must be QUEUED, not dropped ---
  transport.offline = true;
  await sendVoucherPaymentNotifications({ knex, voucherId });
  transport.offline = false;

  const afterOffline = await knex("erp.whatsapp_notification_log").where({ voucher_header_id: voucherId });
  const queued = afterOffline.filter((r) => r.status === "QUEUED");
  const permanent = afterOffline.filter((r) => r.status === "FAILED");

  // 3 queue while offline: the two deliverable payees plus the not-on-WhatsApp
  // one (offline masks the lookup, so it is transient until we can check again).
  check("Offline: payees with good numbers are QUEUED, not dropped", queued.length === 3);
  check("Queued rows carry the rendered message for retry", queued.every((r) => (r.message_body || "").includes("ادائیگی کی اطلاع")));
  check("Queued rows have a future next_retry_at", queued.every((r) => r.next_retry_at && new Date(r.next_retry_at) > new Date(Date.now() - 1000)));
  check("Nothing was SENT while offline", sent.length === 0);
  check("No duplicate copy left in the in-memory transport queue", inMemoryQueued.length === 0);
  check("Permanent failures (bad number) are NOT queued", permanent.length > 0 && permanent.every((r) => r.next_retry_at === null));

  // --- WhatsApp back: the worker delivers the queued messages ---
  await knex("erp.whatsapp_notification_log")
    .where({ voucher_header_id: voucherId, status: "QUEUED" })
    .update({ next_retry_at: new Date(Date.now() - 60000) }); // make them due now
  const sweep = await retryQueuedWhatsAppNotifications({ knex });

  const afterRetry = await knex("erp.whatsapp_notification_log").where({ voucher_header_id: voucherId });
  check("Worker sent the queued messages once reconnected", sweep.sent === 2 && sent.length === 2);
  check("Queued rows became SENT", afterRetry.filter((r) => r.status === "SENT").length === 2);
  // Reconnecting lets us finally check the number: it is not a WhatsApp user,
  // so the worker stops retrying it instead of looping for 24h.
  check(
    "Retry reclassifies not-on-WhatsApp as permanent",
    afterRetry.some((r) => r.status === "FAILED" && r.failure_reason === "not_on_whatsapp"),
  );
  check("Delivered rows clear next_retry_at", afterRetry.filter((r) => r.status === "SENT").every((r) => r.next_retry_at === null));
  check("Queued first message still saves the contact", savedContacts.length === 2);
  check("Each queued message delivered exactly once (no duplicate)", new Set(sent.map((m) => m.chatId)).size === sent.length);

  // --- Give-up: a row older than the retry window becomes a permanent failure ---
  await knex("erp.whatsapp_notification_log").where({ voucher_header_id: voucherId }).del();
  transport.offline = true;
  await sendVoucherPaymentNotifications({ knex, voucherId });
  transport.offline = false;
  await knex("erp.whatsapp_notification_log")
    .where({ voucher_header_id: voucherId, status: "QUEUED" })
    .update({
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000), // older than the 24h window
      next_retry_at: new Date(Date.now() - 60000),
    });
  await retryQueuedWhatsAppNotifications({ knex });

  const afterGiveUp = await knex("erp.whatsapp_notification_log").where({ voucher_header_id: voucherId });
  const expired = afterGiveUp.filter((r) => r.failure_reason === "max_retries_exceeded");
  check("After 24h the worker gives up and marks FAILED", expired.length === 3);
  check("Given-up rows stop retrying (next_retry_at cleared)", expired.every((r) => r.status === "FAILED" && r.next_retry_at === null));

  // Given-up rows must now be visible to the dashboard alert query.
  const alertCount = await knex("erp.whatsapp_notification_log")
    .where({ voucher_header_id: voucherId, status: "FAILED" })
    .whereNull("resolved_at")
    .count("* as c")
    .first();
  check("Given-up rows surface in the dashboard alert count", Number(alertCount.c) >= 2);
})()
  .catch((e) => {
    console.error("Test error:", e);
    failures += 1;
  })
  .finally(async () => {
    // Cleanup
    try {
      if (created.voucherId) {
        await knex("erp.whatsapp_notification_log").where({ voucher_header_id: created.voucherId }).del();
        await knex("erp.voucher_line").where({ voucher_header_id: created.voucherId }).del();
        await knex("erp.voucher_header").where({ id: created.voucherId }).del();
      }
      if (created.partyIds.length) await knex("erp.parties").whereIn("id", created.partyIds).del();
      if (created.labourIds.length) await knex("erp.labours").whereIn("id", created.labourIds).del();
      if (created.employeeIds.length) await knex("erp.employees").whereIn("id", created.employeeIds).del();
    } catch (e) {
      console.error("Cleanup error:", e.message);
    }
    await knex.destroy();
    console.log(`\n${failures === 0 ? "ALL PASSED ✓" : failures + " CHECK(S) FAILED ✗"}`);
    process.exit(failures === 0 ? 0 : 1);
  });
