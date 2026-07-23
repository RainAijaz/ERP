// Per-person WhatsApp payment notifications.
//
// When an approved CASH or JOURNAL voucher pays money OUT to a supplier, labour,
// or employee (their voucher line carries a debit while cash/bank is credited),
// we message that person in Urdu confirming the amount paid, then persist the
// outcome (SENT / FAILED) to erp.whatsapp_notification_log so failures surface on
// the dashboard alert and the admin failures page.
//
// This is fire-and-observe: it must never throw into the approval flow, so the
// whole thing is wrapped in try/catch and failures are logged, not raised.

const {
  sendWhatsAppMessage,
  resolveWhatsAppChatId,
  saveWhatsAppContact,
} = require("./whatsapp");
const { normalizePkMobileToChatId } = require("./phone-format");

const TARGET_VOUCHER_TYPES = new Set(["CASH_VOUCHER", "JOURNAL_VOUCHER"]);

// Saved contacts get a suffix so an ERP-created contact is recognisable in the
// phone book and doesn't get confused with a personal contact of the same name.
const CONTACT_SUFFIX_BY_KIND = {
  SUPPLIER: "(ERP Supplier)",
  LABOUR: "(ERP Labour)",
  EMPLOYEE: "(ERP Employee)",
};

// Failures that retrying can never fix — the master record needs a human to
// correct it, so these are recorded FAILED and surface on the alerts page.
// Anything else (WhatsApp down, transport/resolve error) is transient and gets
// queued for automatic retry.
const PERMANENT_REASONS = new Set([
  "no_phone",
  "invalid_phone",
  "not_on_whatsapp",
  "no_chat_id",
]);
const isRetryable = (reason) => !PERMANENT_REASONS.has(String(reason || ""));

// First backoff step; the worker owns the rest of the schedule.
const FIRST_RETRY_DELAY_MS = 60 * 1000;

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const getLineMeta = (line) =>
  line && line.meta && typeof line.meta === "object" ? line.meta : {};

// Combine the English and Urdu names as "English (اردو)". When only one side
// exists, use whichever is present; never emit an empty "()".
const buildDisplayName = (name, nameUr) => {
  const en = String(name || "").trim();
  const ur = String(nameUr || "").trim();
  if (en && ur) return `${en} (${ur})`;
  return en || ur || "";
};

const formatAmount = (value) => `Rs. ${toNumber(value).toLocaleString("en-PK")}`;

const formatVoucherDate = (voucherDate) => {
  const d = voucherDate ? new Date(voucherDate) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return safe.toLocaleDateString("en-PK", {
    timeZone: "Asia/Karachi",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
};

// Build the Urdu payment message for one payee. `details` is an array of
// { description, amount } for each paid line so a payee with multiple lines gets
// an itemized breakdown; the detail row is omitted when no description exists.
// The voucher number is deliberately NOT included — it is internal and only kept
// on the notification log for staff to trace against.
const buildMessage = ({ name, total, details, voucherDate }) => {
  const lines = [
    "🔔 *ادائیگی کی اطلاع*",
    `محترم/محترمہ ${name || "-"}`,
    `آپ کو ${formatAmount(total)} کی رقم ادا کر دی گئی ہے۔`,
  ];

  const described = details.filter((d) => String(d.description || "").trim());
  if (described.length === 1) {
    lines.push(`📝 تفصیل: ${described[0].description}`);
  } else if (described.length > 1) {
    lines.push("📝 تفصیل:");
    described.forEach((d) => {
      lines.push(`   • ${d.description} — ${formatAmount(d.amount)}`);
    });
  }

  lines.push(`📅 ${formatVoucherDate(voucherDate)}`);
  return lines.join("\n");
};

// Resolve the payee master info for the lines of one recipient kind and message
// each payee, logging SENT/FAILED. `rows` are the paid lines for that kind,
// already grouped by recipient id downstream.
const sendVoucherPaymentNotifications = async ({ knex, voucherId }) => {
  try {
    const id = Number(voucherId);
    if (!Number.isInteger(id) || id <= 0) return;

    const header = await knex("erp.voucher_header")
      .select(
        "id",
        "voucher_type_code",
        "voucher_no",
        "branch_id",
        "voucher_date",
        "status",
      )
      .where({ id })
      .first();

    if (!header) return;
    if (String(header.status).toUpperCase() !== "APPROVED") return;
    const typeCode = String(header.voucher_type_code || "").toUpperCase();
    if (!TARGET_VOUCHER_TYPES.has(typeCode)) return;

    const lines = await knex("erp.voucher_line")
      .select("party_id", "labour_id", "employee_id", "amount", "reference_no", "meta")
      .where({ voucher_header_id: id })
      .whereRaw(
        "(party_id IS NOT NULL OR labour_id IS NOT NULL OR employee_id IS NOT NULL)",
      );

    // A payee is being *paid* when their line carries a debit (money out to them,
    // cash/bank credited). Group paid lines by (kind, recipient id).
    const groups = new Map(); // key -> { kind, id, details: [], total }
    for (const line of lines) {
      const meta = getLineMeta(line);
      const debit = toNumber(line.debit ?? meta.debit);
      if (!(debit > 0)) continue;

      let kind = null;
      let recipientId = null;
      if (line.party_id) {
        kind = "SUPPLIER"; // filtered to SUPPLIER/BOTH parties below
        recipientId = Number(line.party_id);
      } else if (line.labour_id) {
        kind = "LABOUR";
        recipientId = Number(line.labour_id);
      } else if (line.employee_id) {
        kind = "EMPLOYEE";
        recipientId = Number(line.employee_id);
      }
      if (!kind || !recipientId) continue;

      const key = `${kind}:${recipientId}`;
      const entry = groups.get(key) || { kind, id: recipientId, details: [], total: 0 };
      entry.total += debit;
      entry.details.push({
        description: meta.description || meta.narration || line.reference_no || "",
        amount: debit,
      });
      groups.set(key, entry);
    }

    if (!groups.size) return;

    // Load master info (name + phone) for each kind in bulk.
    const partyIds = [];
    const labourIds = [];
    const employeeIds = [];
    for (const { kind, id: rid } of groups.values()) {
      if (kind === "SUPPLIER") partyIds.push(rid);
      else if (kind === "LABOUR") labourIds.push(rid);
      else if (kind === "EMPLOYEE") employeeIds.push(rid);
    }

    const [partyRows, labourRows, employeeRows] = await Promise.all([
      partyIds.length
        ? knex("erp.parties")
            .select("id", "name", "name_ur", "party_type", "phone1", "phone2")
            .whereIn("id", partyIds)
        : [],
      labourIds.length
        ? knex("erp.labours")
            .select("id", "name", "name_ur", "phone")
            .whereIn("id", labourIds)
        : [],
      employeeIds.length
        ? knex("erp.employees")
            .select("id", "name", "name_ur", "phone")
            .whereIn("id", employeeIds)
        : [],
    ]);

    const partyById = new Map(partyRows.map((r) => [Number(r.id), r]));
    const labourById = new Map(labourRows.map((r) => [Number(r.id), r]));
    const employeeById = new Map(employeeRows.map((r) => [Number(r.id), r]));

    const logRows = [];

    for (const entry of groups.values()) {
      let name = "";
      let nameUr = "";
      let phoneRaw = "";

      if (entry.kind === "SUPPLIER") {
        const p = partyById.get(entry.id);
        // Only notify actual suppliers (skip pure customers).
        if (!p) continue;
        const ptype = String(p.party_type || "").toUpperCase();
        if (ptype !== "SUPPLIER" && ptype !== "BOTH") continue;
        name = p.name || "";
        nameUr = p.name_ur || "";
        phoneRaw = p.phone1 || p.phone2 || "";
      } else if (entry.kind === "LABOUR") {
        const l = labourById.get(entry.id);
        if (!l) continue;
        name = l.name || "";
        nameUr = l.name_ur || "";
        phoneRaw = l.phone || "";
      } else if (entry.kind === "EMPLOYEE") {
        const e = employeeById.get(entry.id);
        if (!e) continue;
        name = e.name || "";
        nameUr = e.name_ur || "";
        phoneRaw = e.phone || "";
      }

      // Show the Urdu name in brackets after the English one, e.g.
      // "Ahmed (احمد)" — used for the saved WhatsApp contact and the failures
      // list. Falls back to the English name alone when no Urdu name is set.
      const displayName = buildDisplayName(name, nameUr);

      const baseRow = {
        voucher_header_id: header.id,
        voucher_type_code: typeCode,
        voucher_no: toNumber(header.voucher_no) || null,
        branch_id: header.branch_id || null,
        recipient_kind: entry.kind,
        recipient_id: entry.id,
        recipient_name: displayName || null,
        phone_raw: phoneRaw || null,
        amount: entry.total,
      };

      const { chatId, normalized, reason } = normalizePkMobileToChatId(phoneRaw);
      if (!chatId) {
        // Bad/missing number — permanent, never queued.
        logRows.push({
          ...baseRow,
          phone_normalized: null,
          status: "FAILED",
          failure_reason: reason || "invalid_phone",
        });
        continue;
      }

      // Render the message up front so a transient failure can queue the exact
      // text for a later retry rather than losing it.
      const message = buildMessage({
        name: displayName,
        total: entry.total,
        details: entry.details,
        voucherDate: header.voucher_date,
      });

      // Queue a transient failure (WhatsApp down / transport error) so the
      // worker re-sends it; record a permanent one as FAILED for a human.
      const queueOrFail = (failureReason) => {
        const retryable = isRetryable(failureReason);
        logRows.push({
          ...baseRow,
          phone_normalized: normalized,
          message_body: retryable ? message : null,
          status: retryable ? "QUEUED" : "FAILED",
          failure_reason: failureReason,
          attempts: 1,
          last_attempt_at: new Date(),
          next_retry_at: retryable ? new Date(Date.now() + FIRST_RETRY_DELAY_MS) : null,
        });
      };

      // The number looks valid — now confirm WhatsApp actually knows it, and let
      // WhatsApp tell us how to address it. Skipping this would report a
      // well-formed but non-WhatsApp number as delivered.
      const resolved = await resolveWhatsAppChatId(normalized);
      if (!resolved.ok) {
        queueOrFail(resolved.reason);
        continue;
      }

      // queue:false — the DB row above is the single owner of retries for
      // payment notifications, so the in-memory buffer must not also hold a copy.
      const result = await sendWhatsAppMessage(resolved.chatId, message, {
        queue: false,
      });
      if (result && result.ok) {
        // First time we've successfully messaged this payee: save them as a
        // contact so they appear by name rather than as an unknown number.
        // Only on the first send, so a manually corrected contact name is not
        // overwritten later. Never affects the SENT outcome.
        const alreadyMessaged = await knex("erp.whatsapp_notification_log")
          .where({ recipient_kind: entry.kind, recipient_id: entry.id, status: "SENT" })
          .first();
        if (!alreadyMessaged) {
          await saveWhatsAppContact({
            msisdn: normalized,
            firstName: displayName,
            lastName: CONTACT_SUFFIX_BY_KIND[entry.kind] || "",
          }).catch(() => {});
        }
        logRows.push({
          ...baseRow,
          phone_normalized: normalized,
          status: "SENT",
          failure_reason: null,
          attempts: 1,
          last_attempt_at: new Date(),
        });
      } else {
        queueOrFail((result && result.reason) || "send_error");
      }
    }

    if (logRows.length) {
      await knex("erp.whatsapp_notification_log").insert(logRows);
    }
  } catch (err) {
    console.error("[WhatsApp] payment notification error:", err?.message || err);
  }
};

module.exports = {
  sendVoucherPaymentNotifications,
  PERMANENT_REASONS,
  isRetryable,
  CONTACT_SUFFIX_BY_KIND,
};
