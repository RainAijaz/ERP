// Retroactive commission recalculation.
//
// Commission is denormalized at voucher time, so a rate corrected today never
// reaches vouchers already posted. This service recomputes a date range and
// reports an old -> new diff before anything is written.
//
// Rules ARE effective-dated (and branch-scoped), and resolution happens per
// voucher against that voucher's own date and branch — so recomputing a range
// that spans a rate change reproduces each period at its own rate rather than
// flattening everything to the latest one. Backdating a rule's effective_from
// is what makes a recompute of that period produce different numbers.
//
// It is the single implementation behind both the CLI backfill script and the
// Recalculate modal on the Sales Commission screen.
//
// Two storage models are unified behind one preview row. The natural key is the
// same on both sides — (voucher, employee, commission_type):
//   LEDGER             -> erp.commission_ledger (BRANCH_SALE/TRANSFER/PRODUCTION_*)
//   SALES_VOUCHER_LINE -> SKU meta.commission + the auto EMPLOYEE voucher_line
//                         (SALESMAN_SALE, which never touches commission_ledger)
const knex = require("../../db/knex");
const {
  computeLedgerEntriesForBranch,
  normalizeTransferLinesForCommission,
  normalizeProductionLinesForCommission,
  planSalesmanCommissionRecomputeTx,
  applySalesmanCommissionWriteTx,
} = require("../sales/commission-service");

// PARTY is excluded by construction, not merely left unchecked: no calculator for
// it exists anywhere in the repo, so offering it would only ever report 0 rows.
const COMPUTABLE_TYPES = [
  "SALESMAN_SALE",
  "BRANCH_SALE",
  "TRANSFER",
  "PRODUCTION_FG",
  "PRODUCTION_SFG",
];

const LEDGER_TYPES = new Set([
  "BRANCH_SALE",
  "TRANSFER",
  "PRODUCTION_FG",
  "PRODUCTION_SFG",
]);

// PRODUCTION_FG covers both production voucher types: applyProductionToGenerated-
// VouchersTx posts FG stock for an FG-item line on a PROD_SFG voucher too.
const VOUCHER_TYPES_BY_COMMISSION_TYPE = {
  SALESMAN_SALE: ["SALES_VOUCHER"],
  BRANCH_SALE: ["SALES_VOUCHER"],
  TRANSFER: ["STN_OUT"],
  PRODUCTION_FG: ["DCV", "PROD_FG", "PROD_SFG"],
  PRODUCTION_SFG: ["DCV"],
};

const PRODUCTION_CATEGORY_BY_COMMISSION_TYPE = {
  PRODUCTION_FG: "FG",
  PRODUCTION_SFG: "SFG",
};

const MAX_RECALC_ROWS = 500;
const UNCHANGED_EPSILON = 0.005;

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundMoney = (value) =>
  Math.round((toNumber(value, 0) + Number.EPSILON) * 100) / 100;

const toPositiveIntOrNull = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const toDateOnly = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

const todayYmd = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
};

const toStringArray = (value) => {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return String(value).split(",");
};

const toBool = (value) =>
  value === true || value === "true" || value === "on" || value === "1" || value === 1;

const normalizeRecalcInput = (payload = {}) => {
  const requested = toStringArray(
    payload.commission_types ?? payload.commissionTypes ?? payload.commission_type,
  )
    .map((entry) => String(entry || "").trim().toUpperCase())
    .filter((entry) => COMPUTABLE_TYPES.includes(entry));
  const commissionTypes = requested.length ? [...new Set(requested)] : [...COMPUTABLE_TYPES];

  const fromDate = toDateOnly(payload.from_date ?? payload.fromDate);
  const toDate = toDateOnly(payload.to_date ?? payload.toDate);

  // Reversed ranges are corrected rather than rejected — the same courtesy the
  // HR reports extend, and the user is picking odd cycle boundaries by hand.
  const orderedFrom = fromDate && toDate && fromDate > toDate ? toDate : fromDate;
  const orderedTo = fromDate && toDate && fromDate > toDate ? fromDate : toDate;

  const allowedBranchIds = Array.isArray(payload.allowedBranchIds)
    ? payload.allowedBranchIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
    : [];

  return {
    commissionTypes,
    fromDate: orderedFrom,
    toDate: orderedTo,
    dateRangeCorrected: Boolean(fromDate && toDate && fromDate > toDate),
    employeeId: toPositiveIntOrNull(payload.employee_id ?? payload.employeeId),
    clearOrphans: toBool(payload.clear_orphans ?? payload.clearOrphans),
    allowedBranchIds,
  };
};

const buildBackdatedRuleRecalcInput = ({
  effectiveFrom,
  effectiveTo = null,
  employeeId,
  commissionType,
  allowedBranchIds = [],
} = {}) => {
  const from = toDateOnly(effectiveFrom);
  const today = todayYmd();
  if (!from || from >= today) return null;

  const normalizedType = String(commissionType || "")
    .trim()
    .toUpperCase();
  if (!COMPUTABLE_TYPES.includes(normalizedType)) return null;

  const toFromRule = toDateOnly(effectiveTo);
  const to = toFromRule && toFromRule < today ? toFromRule : today;
  if (to < from) return null;

  return normalizeRecalcInput({
    commission_types: [normalizedType],
    from_date: from,
    to_date: to,
    employee_id: employeeId,
    clear_orphans: false,
    allowedBranchIds,
  });
};

const backdatedRuleKey = (input) =>
  [
    input?.employeeId || "",
    (input?.commissionTypes || []).join(","),
    input?.fromDate || "",
    input?.toDate || "",
    (input?.allowedBranchIds || []).join(","),
  ].join("|");

const applyAutomaticBackdatedRecalc = async ({
  trx,
  ruleChanges = [],
  allowedBranchIds = [],
  userId = null,
  source = "commission-rule-save",
  t = (key) => key,
} = {}) => {
  if (!trx || !Array.isArray(ruleChanges) || !ruleChanges.length) {
    return {
      attempted: 0,
      writes: 0,
      skippedOverLimit: 0,
      inputs: [],
      results: [],
    };
  }

  const inputByKey = new Map();
  ruleChanges.forEach((change) => {
    const input = buildBackdatedRuleRecalcInput({
      effectiveFrom: change?.effective_from ?? change?.effectiveFrom,
      effectiveTo: change?.effective_to ?? change?.effectiveTo,
      employeeId: change?.employee_id ?? change?.employeeId,
      commissionType: change?.commission_type ?? change?.commissionType,
      allowedBranchIds,
    });
    if (!input) return;
    inputByKey.set(backdatedRuleKey(input), input);
  });

  const inputs = [...inputByKey.values()];
  const summary = {
    attempted: inputs.length,
    writes: 0,
    skippedOverLimit: 0,
    inputs: inputs.map((input) => ({
      from_date: input.fromDate,
      to_date: input.toDate,
      employee_id: input.employeeId,
      commission_types: input.commissionTypes,
    })),
    results: [],
  };

  for (const input of inputs) {
    const plan = await buildRecalcPlan({
      db: trx,
      input,
      t,
    });
    const writes = plan.rows.filter((row) => row.will_write);
    if (!writes.length) {
      summary.results.push({
        from_date: input.fromDate,
        to_date: input.toDate,
        employee_id: input.employeeId,
        commission_types: input.commissionTypes,
        writes: 0,
        skipped_over_limit: false,
      });
      continue;
    }
    if (plan.over_limit) {
      summary.skippedOverLimit += 1;
      summary.results.push({
        from_date: input.fromDate,
        to_date: input.toDate,
        employee_id: input.employeeId,
        commission_types: input.commissionTypes,
        writes: writes.length,
        skipped_over_limit: true,
      });
      continue;
    }

    const result = await applyRecalcPlan({
      trx,
      rows: plan.rows,
      provenance: {
        at: new Date().toISOString(),
        by: userId,
        source,
        from_date: input.fromDate,
        to_date: input.toDate,
        automatic: true,
      },
    });
    summary.writes += writes.length;
    summary.results.push({
      from_date: input.fromDate,
      to_date: input.toDate,
      employee_id: input.employeeId,
      commission_types: input.commissionTypes,
      writes: writes.length,
      skipped_over_limit: false,
      result,
    });
  }

  return summary;
};

const summarizeBackdatedRuleInputs = ({
  ruleChanges = [],
  allowedBranchIds = [],
} = {}) => {
  if (!Array.isArray(ruleChanges) || !ruleChanges.length) return [];
  const inputByKey = new Map();
  ruleChanges.forEach((change) => {
    const input = buildBackdatedRuleRecalcInput({
      effectiveFrom: change?.effective_from ?? change?.effectiveFrom,
      effectiveTo: change?.effective_to ?? change?.effectiveTo,
      employeeId: change?.employee_id ?? change?.employeeId,
      commissionType: change?.commission_type ?? change?.commissionType,
      allowedBranchIds,
    });
    if (!input) return;
    inputByKey.set(backdatedRuleKey(input), input);
  });
  return [...inputByKey.values()];
};

const scheduleAutomaticBackdatedRecalc = ({
  ruleChanges = [],
  allowedBranchIds = [],
} = {}) => {
  const inputs = summarizeBackdatedRuleInputs({ ruleChanges, allowedBranchIds });
  return {
    queued: false,
    disabled: true,
    attempted: inputs.length,
    inputs: inputs.map((input) => ({
      from_date: input.fromDate,
      to_date: input.toDate,
      employee_id: input.employeeId,
      commission_types: input.commissionTypes,
    })),
  };
};

const rowKey = (voucherId, employeeId, commissionType) =>
  `${Number(voucherId)}:${Number(employeeId)}:${commissionType}`;

// Empty allowedBranchIds means "unrestricted" — the convention used throughout
// the report services, and admins always resolve to empty.
const applyBranchScope = (query, allowedBranchIds, column = "vh.branch_id") => {
  if (allowedBranchIds.length) return query.whereIn(column, allowedBranchIds);
  return query;
};

const loadEligibleVouchers = ({ db, voucherTypeCodes, input }) => {
  const query = db("erp.voucher_header as vh")
    .select(
      "vh.id",
      "vh.voucher_no",
      "vh.voucher_type_code",
      "vh.branch_id",
      db.raw("to_char(vh.voucher_date, 'YYYY-MM-DD') as voucher_date"),
    )
    .whereIn("vh.voucher_type_code", voucherTypeCodes)
    .andWhere("vh.status", "APPROVED")
    // Inclusive on both ends: a 26th-to-25th salary cycle must contain vouchers
    // dated exactly on either boundary.
    .andWhere("vh.voucher_date", ">=", input.fromDate)
    .andWhere("vh.voucher_date", "<=", input.toDate)
    .orderBy("vh.voucher_date", "asc")
    .orderBy("vh.id", "asc");
  return applyBranchScope(query, input.allowedBranchIds);
};

const loadSkuLines = (db, voucherId) =>
  db("erp.voucher_line")
    .select("id", "line_kind", "sku_id", "qty", "uom_id", "rate", "amount", "meta", "line_no")
    .where({ voucher_header_id: voucherId, line_kind: "SKU" });

const loadProductionOutputs = (db, voucherId, category) =>
  db("erp.stock_ledger")
    .select("sku_id", "qty_pairs", "value")
    .where({ voucher_header_id: voucherId, direction: 1, category })
    .whereNotNull("sku_id")
    .orderBy("id", "asc");

const loadEmployeeNameMap = async ({ db, employeeIds, locale }) => {
  const ids = [...new Set(employeeIds.map((id) => Number(id)).filter(Boolean))];
  if (!ids.length) return new Map();
  const nameExpr = locale === "ur" ? "COALESCE(e.name_ur, e.name)" : "e.name";
  const rows = await db("erp.employees as e")
    .select("e.id", db.raw(`${nameExpr} as name`))
    .whereIn("e.id", ids);
  return new Map(rows.map((row) => [Number(row.id), row.name || `#${row.id}`]));
};

const resolveStatus = ({ previous, next }) => {
  const hasPrevious = previous !== null && previous !== undefined;
  const previousAmount = toNumber(previous, 0);
  const nextAmount = toNumber(next, 0);
  if (!hasPrevious || Math.abs(previousAmount) < UNCHANGED_EPSILON) {
    return Math.abs(nextAmount) < UNCHANGED_EPSILON ? "unchanged" : "new";
  }
  if (Math.abs(previousAmount - nextAmount) < UNCHANGED_EPSILON) return "unchanged";
  // Recompute yielded nothing where something is stored — usually because the rule
  // was deleted. Destructive to write, so it is opt-in.
  if (Math.abs(nextAmount) < UNCHANGED_EPSILON) return "cleared";
  return "changed";
};

const buildLedgerPlanRows = async ({ db, input, commissionType }) => {
  const voucherTypeCodes = VOUCHER_TYPES_BY_COMMISSION_TYPE[commissionType] || [];
  if (!voucherTypeCodes.length) return { rows: [], scanned: 0 };

  const vouchers = await loadEligibleVouchers({ db, voucherTypeCodes, input });
  if (!vouchers.length) return { rows: [], scanned: 0 };

  const voucherIds = vouchers.map((voucher) => Number(voucher.id));
  const existingRows = await db("erp.commission_ledger")
    .select("voucher_id", "employee_id", "total_amount")
    .where("commission_type", commissionType)
    .whereIn("voucher_id", voucherIds);
  const existingByKey = new Map(
    existingRows.map((row) => [
      rowKey(row.voucher_id, row.employee_id, commissionType),
      toNumber(row.total_amount, 0),
    ]),
  );

  const productionCategory = PRODUCTION_CATEGORY_BY_COMMISSION_TYPE[commissionType] || null;
  const rows = [];
  const seenKeys = new Set();

  for (const voucher of vouchers) {
    let lines;
    if (productionCategory) {
      const outputs = await loadProductionOutputs(db, Number(voucher.id), productionCategory);
      if (!outputs.length) continue;
      lines = normalizeProductionLinesForCommission(
        outputs.map((output, index) => ({
          line_kind: "SKU",
          sku_id: Number(output.sku_id),
          line_no: index + 1,
          qty: toNumber(output.qty_pairs, 0),
          total_pairs: toNumber(output.qty_pairs, 0),
          amount: toNumber(output.value, 0),
        })),
      );
    } else {
      const rawLines = await loadSkuLines(db, Number(voucher.id));
      if (!rawLines.length) continue;
      lines =
        commissionType === "TRANSFER"
          ? normalizeTransferLinesForCommission(rawLines)
          : rawLines;
    }

    const entries = await computeLedgerEntriesForBranch({
      trx: db,
      lines,
      branchId: Number(voucher.branch_id),
      commissionType,
      // Each voucher resolves against its OWN date, so a range that spans a rate
      // change recomputes each half at the rate that was in force then.
      voucherDate: voucher.voucher_date,
      t: (key) => key,
    });

    for (const entry of entries) {
      const employeeId = Number(entry.employee_id);
      if (input.employeeId && employeeId !== input.employeeId) continue;
      const key = rowKey(voucher.id, employeeId, commissionType);
      seenKeys.add(key);
      const previous = existingByKey.has(key) ? existingByKey.get(key) : null;
      const next = roundMoney(entry.total_amount);
      rows.push({
        storage: "LEDGER",
        voucher_id: Number(voucher.id),
        voucher_no: Number(voucher.voucher_no),
        voucher_type_code: voucher.voucher_type_code,
        voucher_date: voucher.voucher_date,
        branch_id: Number(voucher.branch_id),
        employee_id: employeeId,
        commission_type: commissionType,
        previous_rate: previous,
        new_rate: next,
        status: resolveStatus({ previous, next }),
        write: {
          storage: "LEDGER",
          voucher_id: Number(voucher.id),
          employee_id: employeeId,
          commission_type: commissionType,
          total_amount: next,
          lines_detail: entry.lines_detail || [],
        },
      });
    }
  }

  // Stored rows the recompute no longer produces at all.
  const voucherById = new Map(vouchers.map((voucher) => [Number(voucher.id), voucher]));
  for (const row of existingRows) {
    const employeeId = Number(row.employee_id);
    if (input.employeeId && employeeId !== input.employeeId) continue;
    const key = rowKey(row.voucher_id, employeeId, commissionType);
    if (seenKeys.has(key)) continue;
    const previous = toNumber(row.total_amount, 0);
    if (Math.abs(previous) < UNCHANGED_EPSILON) continue;
    const voucher = voucherById.get(Number(row.voucher_id));
    if (!voucher) continue;
    rows.push({
      storage: "LEDGER",
      voucher_id: Number(voucher.id),
      voucher_no: Number(voucher.voucher_no),
      voucher_type_code: voucher.voucher_type_code,
      voucher_date: voucher.voucher_date,
      branch_id: Number(voucher.branch_id),
      employee_id: employeeId,
      commission_type: commissionType,
      previous_rate: previous,
      new_rate: 0,
      status: "cleared",
      write: {
        storage: "LEDGER",
        voucher_id: Number(voucher.id),
        employee_id: employeeId,
        commission_type: commissionType,
        total_amount: 0,
        lines_detail: [],
      },
    });
  }

  return { rows, scanned: vouchers.length };
};

const buildSalesmanPlanRows = async ({ db, input, t }) => {
  const vouchers = await loadEligibleVouchers({
    db,
    voucherTypeCodes: VOUCHER_TYPES_BY_COMMISSION_TYPE.SALESMAN_SALE,
    input,
  });
  if (!vouchers.length) return { rows: [], scanned: 0 };

  const rows = [];
  for (const voucher of vouchers) {
    const planned = await planSalesmanCommissionRecomputeTx({
      db,
      voucherId: Number(voucher.id),
      t,
    });
    if (!planned) continue;
    if (input.employeeId && Number(planned.employee_id) !== input.employeeId) continue;

    const previous = planned.previous_amount;
    const next = roundMoney(planned.new_amount);
    const status = resolveStatus({ previous, next });
    if (status === "unchanged" && previous === null) continue;

    rows.push({
      storage: "SALES_VOUCHER_LINE",
      voucher_id: Number(voucher.id),
      voucher_no: Number(voucher.voucher_no),
      voucher_type_code: voucher.voucher_type_code,
      voucher_date: voucher.voucher_date,
      branch_id: Number(voucher.branch_id),
      employee_id: Number(planned.employee_id),
      commission_type: "SALESMAN_SALE",
      previous_rate: previous,
      new_rate: next,
      status,
      write: { storage: "SALES_VOUCHER_LINE", ...planned.write },
    });
  }
  return { rows, scanned: vouchers.length };
};

const buildRecalcPlan = async ({ db = knex, input, locale = "en", t = (key) => key }) => {
  if (!input?.fromDate || !input?.toDate) {
    return {
      filters: input,
      rows: [],
      orphans: [],
      counts: {
        scanned_vouchers: 0,
        vouchers: 0,
        rows: 0,
        new: 0,
        changed: 0,
        unchanged: 0,
        cleared: 0,
        writes: 0,
      },
      totals: { old_total: 0, new_total: 0, delta: 0 },
      over_limit: false,
      limit: MAX_RECALC_ROWS,
      missing_dates: true,
    };
  }

  let rows = [];
  // Tracked separately from row counts so "0 rows" can be told apart from "no
  // vouchers in range" — the former usually means no rules are configured.
  const scannedVoucherIds = new Set();
  let scannedTotal = 0;
  for (const commissionType of input.commissionTypes) {
    const next = LEDGER_TYPES.has(commissionType)
      ? await buildLedgerPlanRows({ db, input, commissionType })
      : await buildSalesmanPlanRows({ db, input, t });
    rows = rows.concat(next.rows);
    scannedTotal += next.scanned;
    next.rows.forEach((row) => scannedVoucherIds.add(row.voucher_id));
  }

  const nameMap = await loadEmployeeNameMap({
    db,
    employeeIds: rows.map((row) => row.employee_id),
    locale,
  });
  rows.forEach((row) => {
    row.employee_name = nameMap.get(Number(row.employee_id)) || `#${row.employee_id}`;
    // A cleared row is destructive, so it only writes when explicitly opted in.
    row.will_write =
      row.status === "cleared"
        ? Boolean(input.clearOrphans)
        : row.status === "new" || row.status === "changed";
  });

  rows.sort(
    (a, b) =>
      String(a.voucher_date).localeCompare(String(b.voucher_date)) ||
      a.voucher_id - b.voucher_id ||
      String(a.commission_type).localeCompare(String(b.commission_type)),
  );

  const orphans = rows.filter((row) => row.status === "cleared");
  const counts = {
    scanned_vouchers: scannedTotal,
    vouchers: new Set(rows.map((row) => row.voucher_id)).size,
    rows: rows.length,
    new: rows.filter((row) => row.status === "new").length,
    changed: rows.filter((row) => row.status === "changed").length,
    unchanged: rows.filter((row) => row.status === "unchanged").length,
    cleared: orphans.length,
    writes: rows.filter((row) => row.will_write).length,
  };

  const writable = rows.filter((row) => row.will_write);
  const totals = {
    old_total: roundMoney(writable.reduce((sum, row) => sum + toNumber(row.previous_rate, 0), 0)),
    new_total: roundMoney(writable.reduce((sum, row) => sum + toNumber(row.new_rate, 0), 0)),
  };
  totals.delta = roundMoney(totals.new_total - totals.old_total);

  return {
    filters: input,
    rows,
    orphans,
    counts,
    totals,
    over_limit: counts.writes > MAX_RECALC_ROWS,
    limit: MAX_RECALC_ROWS,
    missing_dates: false,
  };
};

const applyRecalcPlan = async ({ trx, rows = [], provenance = null }) => {
  const result = { ledgerRows: 0, salesVouchers: 0, skuLines: 0, inserted: 0, updated: 0 };

  for (const row of rows) {
    if (!row?.will_write) continue;
    const write = row.write || {};

    if (write.storage === "LEDGER") {
      const linesDetail = Array.isArray(write.lines_detail) ? write.lines_detail : [];
      await trx("erp.commission_ledger")
        .insert({
          voucher_id: write.voucher_id,
          employee_id: write.employee_id,
          commission_type: write.commission_type,
          total_amount: write.total_amount,
          lines_detail: JSON.stringify(
            provenance ? [...linesDetail, { commission_recalc: provenance }] : linesDetail,
          ),
        })
        .onConflict(["voucher_id", "employee_id", "commission_type"])
        .merge(["total_amount", "lines_detail"]);
      result.ledgerRows += 1;
      continue;
    }

    if (write.storage === "SALES_VOUCHER_LINE") {
      const applied = await applySalesmanCommissionWriteTx({ trx, write, provenance });
      result.salesVouchers += 1;
      result.skuLines += applied.skuLinesUpdated;
      if (applied.employeeLineAction === "inserted") result.inserted += 1;
      if (applied.employeeLineAction === "updated") result.updated += 1;
    }
  }

  return result;
};

// Feeds the guardrail panel: shows exactly which rules the recompute will use,
// including each rule's branch and effective window so an approver can see why
// a given voucher resolved to the rate it did.
const fetchActiveRulesForScope = async ({
  db = knex,
  employeeId = null,
  commissionTypes = COMPUTABLE_TYPES,
  locale = "en",
}) => {
  const types = commissionTypes.filter((type) => COMPUTABLE_TYPES.includes(type));
  if (!types.length) return [];
  const nameExpr = locale === "ur" ? "COALESCE(e.name_ur, e.name)" : "e.name";
  let query = db("erp.employee_commission_rules as ecr")
    .join("erp.employees as e", "e.id", "ecr.employee_id")
    .select(
      "ecr.id",
      "ecr.employee_id",
      db.raw(`${nameExpr} as employee_name`),
      "ecr.commission_type",
      "ecr.commission_basis",
      "ecr.apply_on",
      "ecr.sku_id",
      "ecr.subgroup_id",
      "ecr.group_id",
      "ecr.value",
      db.raw(`COALESCE(NULLIF(to_jsonb(ecr)->>'rate_type', ''), 'PER_PAIR') as rate_type`),
      db.raw(`to_jsonb(ecr)->>'branch_id' as branch_id`),
      db.raw(`to_char((to_jsonb(ecr)->>'effective_from')::date, 'YYYY-MM-DD') as effective_from`),
      db.raw(`to_char((to_jsonb(ecr)->>'effective_to')::date, 'YYYY-MM-DD') as effective_to`),
      db.raw(`(SELECT b.name FROM erp.branches b WHERE b.id = (to_jsonb(ecr)->>'branch_id')::bigint) as branch_name`),
    )
    .whereIn("ecr.commission_type", types)
    .andWhere("ecr.status", "active")
    .orderBy("ecr.employee_id", "asc")
    .orderBy("ecr.commission_type", "asc");
  if (employeeId) query = query.where("ecr.employee_id", employeeId);
  return query;
};

module.exports = {
  COMPUTABLE_TYPES,
  LEDGER_TYPES,
  VOUCHER_TYPES_BY_COMMISSION_TYPE,
  MAX_RECALC_ROWS,
  normalizeRecalcInput,
  buildBackdatedRuleRecalcInput,
  scheduleAutomaticBackdatedRecalc,
  buildRecalcPlan,
  applyRecalcPlan,
  applyAutomaticBackdatedRecalc,
  fetchActiveRulesForScope,
};
