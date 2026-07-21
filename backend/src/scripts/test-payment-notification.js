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
require.cache[waPath] = {
  id: waPath,
  filename: waPath,
  loaded: true,
  exports: {
    initWhatsApp: () => {},
    // Stand in for WhatsApp's number lookup: 92300000000x is treated as a
    // well-formed number that is NOT registered on WhatsApp.
    resolveWhatsAppChatId: async (msisdn) => {
      const digits = String(msisdn || "").replace(/\D/g, "");
      if (digits.startsWith("9230000000")) return { ok: false, reason: "not_on_whatsapp" };
      return { ok: true, chatId: `${digits}@c.us` };
    },
    sendWhatsAppMessage: async (chatId, text) => {
      sent.push({ chatId, text });
      return { ok: true };
    },
  },
};

const knex = require("../db/knex");
const { sendVoucherPaymentNotifications } = require("../utils/payment-notification");

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

  const mkParty = async (name, partyType, phone1) => {
    const [row] = await knex("erp.parties")
      .insert({ code: `${TAG}_${name}`, name: `${TAG} ${name}`, party_type: partyType, phone1, created_by: user.id })
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
  const supplierValid = await mkParty("SupplierValid", "SUPPLIER", "0300-1112223"); // -> SENT (aggregated)
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

  if (svMsg) console.log("\n--- Sample message ---\n" + svMsg.text + "\n----------------------");
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
