const express = require("express");
const knex = require("../../db/knex");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { setCookie } = require("../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../middleware/core/ui-notice");
const { toLocalDateOnly } = require("../../utils/date-only");
const { createVoucher, updateVoucher, deleteVoucher } = require("../../services/financial/voucher-service");

const toLines = (body) => {
  if (Array.isArray(body?.lines)) return body.lines;
  if (typeof body?.lines_json === "string" && body.lines_json.trim()) {
    try {
      const parsed = JSON.parse(body.lines_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }
  return [];
};

const setNotice = (res, message, sticky = false) => {
  if (!message) return;
  setCookie(
    res,
    UI_NOTICE_COOKIE,
    JSON.stringify({
      message,
      sticky,
      autoClose: !sticky,
    }),
    { path: "/", maxAge: 30, sameSite: "Lax" }
  );
};

const loadOptions = async (req, voucherTypeCode) => {
  let accountsQuery = knex("erp.accounts as a")
    .leftJoin("erp.account_posting_classes as apc", "apc.id", "a.posting_class_id")
    .leftJoin("erp.account_groups as ag", "ag.id", "a.subgroup_id")
    .select("a.id", "a.code", "a.name", "apc.code as posting_class_code", "apc.is_active as posting_class_active", "ag.account_type")
    .where({ "a.is_active": true })
    .andWhere(function allowMissingOrActivePostingClass() {
      this.whereNull("a.posting_class_id").orWhere("apc.is_active", true);
    });
  let partiesQuery = knex("erp.parties as p").select("p.id", "p.code", "p.name").where({ "p.is_active": true });
  let laboursQuery = knex("erp.labours as l")
    .select(
      "l.id",
      "l.code",
      "l.name",
      "l.dept_id",
      knex.raw(
        `(SELECT COALESCE(string_agg(ld.dept_id::text, ',' ORDER BY ld.dept_id), '')
          FROM erp.labour_department ld
          WHERE ld.labour_id = l.id) as dept_ids_csv`,
      ),
    )
    .whereRaw("lower(l.status)='active'");
  let employeesQuery = knex("erp.employees as e")
    .select("e.id", "e.code", "e.name", "e.department_id")
    .whereRaw("lower(e.status)='active'");

  accountsQuery = accountsQuery.whereExists(function whereAccountBranchMap() {
    this.select(1).from("erp.account_branch as ab").whereRaw("ab.account_id = a.id").andWhere("ab.branch_id", req.branchId);
  });
  partiesQuery = partiesQuery.where(function wherePartyScope() {
    this.where("p.branch_id", req.branchId).orWhereExists(function wherePartyBranchMap() {
      this.select(1).from("erp.party_branch as pb").whereRaw("pb.party_id = p.id").andWhere("pb.branch_id", req.branchId);
    });
  });
  laboursQuery = laboursQuery.whereExists(function whereLabourBranchMap() {
    this.select(1).from("erp.labour_branch as lb").whereRaw("lb.labour_id = l.id").andWhere("lb.branch_id", req.branchId);
  });
  employeesQuery = employeesQuery.whereExists(function whereEmployeeBranchMap() {
    this.select(1).from("erp.employee_branch as eb").whereRaw("eb.employee_id = e.id").andWhere("eb.branch_id", req.branchId);
  });

  const [accounts, parties, labours, employees, departments] = await Promise.all([
    accountsQuery.orderBy("a.name", "asc"),
    partiesQuery.orderBy("p.name", "asc"),
    laboursQuery.orderBy("l.name", "asc"),
    employeesQuery.orderBy("e.name", "asc"),
    knex("erp.departments as d").select("d.id", "d.name").where({ is_active: true }).orderBy("d.name", "asc"),
  ]);

  const normalizedVoucherTypeCode = String(voucherTypeCode || "").toUpperCase();
  const headerAccounts = (() => {
    if (normalizedVoucherTypeCode === "BANK_VOUCHER") {
      return accounts.filter((row) => String(row.posting_class_code || "").toLowerCase() === "bank");
    }
    if (normalizedVoucherTypeCode === "CASH_VOUCHER") {
      return accounts.filter((row) => {
        const code = String(row.posting_class_code || "").toLowerCase();
        return code === "cash";
      });
    }
    return accounts;
  })();

  return { accounts, headerAccounts, parties, labours, employees, departments };
};

const loadRecent = async (req, voucherTypeCode) => {
  let query = knex("erp.voucher_header")
    .select("id", "voucher_no", "voucher_date", "status", "remarks", "created_at")
    .where({ voucher_type_code: voucherTypeCode })
    .whereNot({ status: "REJECTED" })
    .orderBy("id", "desc")
    .limit(20);

  const rows = await query.where({ branch_id: req.branchId });
  return rows.map((row) => ({
    ...row,
    voucher_date: toLocalDateOnly(row.voucher_date),
  }));
};

const parseVoucherNo = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const asNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const toDateOnly = toLocalDateOnly;

const getAutoSettlementDateFromRemarks = (remarks) => {
  const text = String(remarks || "");
  const structured = text.match(/D:(\d{4}-\d{2}-\d{2})/);
  if (structured) return structured[1];
  const anyDate = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (anyDate) return anyDate[1];
  const legacy = text.match(/^\[AUTO_BANK_SETTLEMENT\]\s*(\d{4}-\d{2}-\d{2})/);
  return legacy ? legacy[1] : "";
};

const backfillAutoBankSourceMeta = async ({ req, header, lines }) => {
  if (!header || !lines?.length) return lines;
  const isAutoBank =
    String(header.voucher_type_code || "").toUpperCase() === "BANK_VOUCHER" &&
    String(header.remarks || "").startsWith("[AUTO_BANK_SETTLEMENT]");
  if (!isAutoBank) return lines;

  const missing = lines.filter((line) => asNum(line?.meta?.source_voucher_id) <= 0);
  if (!missing.length) return lines;

  const sourceDates = [...new Set([toDateOnly(header.voucher_date), getAutoSettlementDateFromRemarks(header.remarks)].filter(Boolean))];

  let sourceQuery = knex("erp.voucher_header as vh")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .select(
      "vh.id as source_voucher_id",
      "vh.voucher_no as source_voucher_no",
      "vh.voucher_type_code as source_voucher_type_code",
      "vl.id as source_line_id",
      "vl.account_id as source_account_id",
      "vl.amount as source_amount",
      knex.raw("COALESCE((vl.meta->>'department_id')::int, 0) as source_department_id"),
    )
    .whereIn("vh.voucher_type_code", ["CASH_VOUCHER", "JOURNAL_VOUCHER"])
    .where({ "vh.branch_id": header.branch_id, "vh.status": "APPROVED" })
    .orderBy("vh.voucher_no", "asc")
    .orderBy("vl.line_no", "asc");

  if (sourceDates.length) {
    sourceQuery = sourceQuery.andWhere(function whereVoucherDate() {
      sourceDates.forEach((dateValue) => {
        this.orWhereRaw("date(vh.voucher_date) = date(?)", [dateValue]);
      });
    });
  }

  sourceQuery = sourceQuery.where({ "vh.branch_id": req.branchId });
  const sourceRows = await sourceQuery;
  if (!sourceRows.length) return lines;

  const usedSourceLineIds = new Set();
  const updates = [];

  for (const line of missing) {
    const lineMeta = line.meta && typeof line.meta === "object" ? { ...line.meta } : {};
    const lineAccountId = asNum(line.account_id);
    const lineAmount = asNum(line.amount);
    const lineDept = asNum(lineMeta.department_id);

    const match =
      sourceRows.find(
        (src) =>
          !usedSourceLineIds.has(asNum(src.source_line_id)) &&
          asNum(src.source_account_id) === lineAccountId &&
          asNum(src.source_amount) === lineAmount &&
          (lineDept <= 0 || asNum(src.source_department_id) === lineDept),
      ) ||
      sourceRows.find(
        (src) =>
          !usedSourceLineIds.has(asNum(src.source_line_id)) &&
          asNum(src.source_account_id) === lineAccountId &&
          asNum(src.source_amount) === lineAmount,
      );

    if (!match) continue;

    usedSourceLineIds.add(asNum(match.source_line_id));
    lineMeta.source_voucher_id = asNum(match.source_voucher_id);
    lineMeta.source_voucher_type_code = String(match.source_voucher_type_code || "");
    lineMeta.source_voucher_no = asNum(match.source_voucher_no);
    lineMeta.source_line_id = asNum(match.source_line_id);
    updates.push({ lineId: asNum(line.id), meta: lineMeta });
    line.meta = lineMeta;
  }

  return lines;
};

const applyVoucherScope = (query, req) => {
  return query.where({ branch_id: req.branchId });
};

const getVoucherSeriesStats = async ({ req, voucherTypeCode }) => {
  const base = () => applyVoucherScope(knex("erp.voucher_header").where({ voucher_type_code: voucherTypeCode }), req);
  const [latestAny, latestActive] = await Promise.all([
    base().max({ value: "voucher_no" }).first(),
    base().whereNot({ status: "REJECTED" }).max({ value: "voucher_no" }).first(),
  ]);
  return {
    latestVoucherNo: Number(latestAny?.value || 0),
    latestActiveVoucherNo: Number(latestActive?.value || 0),
  };
};

const getVoucherNeighbours = async ({ req, voucherTypeCode, cursorNo }) => {
  const normalized = Number(cursorNo || 0);
  if (!Number.isInteger(normalized) || normalized <= 0) return { prevVoucherNo: null, nextVoucherNo: null };
  const base = () => applyVoucherScope(knex("erp.voucher_header").where({ voucher_type_code: voucherTypeCode }), req);
  const [prevRow, nextRow] = await Promise.all([
    base().where("voucher_no", "<", normalized).max({ value: "voucher_no" }).first(),
    base().where("voucher_no", ">", normalized).min({ value: "voucher_no" }).first(),
  ]);
  return {
    prevVoucherNo: Number(prevRow?.value || 0) || null,
    nextVoucherNo: Number(nextRow?.value || 0) || null,
  };
};

const loadVoucherDetails = async ({ req, voucherTypeCode, voucherNo }) => {
  const targetNo = parseVoucherNo(voucherNo);
  if (!targetNo) return null;

  let headerQuery = knex("erp.voucher_header as vh")
    .select("vh.id", "vh.branch_id", "vh.voucher_type_code", "vh.voucher_no", "vh.voucher_date", "vh.header_account_id", "vh.status", "vh.remarks", "vh.created_at")
    .where({ "vh.voucher_type_code": voucherTypeCode, "vh.voucher_no": targetNo });

  headerQuery = headerQuery.where({ "vh.branch_id": req.branchId });
  const header = await headerQuery.first();
  if (!header) return null;

  const lines = await knex("erp.voucher_line as vl")
    .select(
      "vl.id",
      "vl.line_no",
      "vl.line_kind",
      "vl.account_id",
      "vl.party_id",
      "vl.labour_id",
      "vl.employee_id",
      "a.code as account_code",
      "a.name as account_name",
      "p.code as party_code",
      "p.name as party_name",
      "l.code as labour_code",
      "l.name as labour_name",
      "e.code as employee_code",
      "e.name as employee_name",
      "vl.reference_no",
      "vl.meta"
    )
    .leftJoin("erp.accounts as a", "a.id", "vl.account_id")
    .leftJoin("erp.parties as p", "p.id", "vl.party_id")
    .leftJoin("erp.labours as l", "l.id", "vl.labour_id")
    .leftJoin("erp.employees as e", "e.id", "vl.employee_id")
    .where({ "vl.voucher_header_id": header.id })
    .orderBy("vl.line_no", "asc");

  if (process.env.ENABLE_BANK_SOURCE_BACKFILL_ON_READ === "1") {
    await backfillAutoBankSourceMeta({ req, header, lines });
  }

  const sourceVoucherIds = [...new Set(
    lines
      .map((line) => Number(line?.meta?.source_voucher_id || 0))
      .filter((id) => Number.isInteger(id) && id > 0),
  )];
  let sourceVoucherMap = new Map();
  let sourceHeaderAccountMap = new Map();
  if (sourceVoucherIds.length) {
    const sourceRows = await knex("erp.voucher_header")
      .select("id", "voucher_no", "voucher_type_code")
      .whereIn("id", sourceVoucherIds);
    sourceVoucherMap = new Map(sourceRows.map((row) => [Number(row.id), row]));

    const sourceHeaderRows = await knex("erp.voucher_header as vh")
      .leftJoin("erp.accounts as ha", "ha.id", "vh.header_account_id")
      .select("vh.id", "vh.header_account_id", "ha.code as header_account_code", "ha.name as header_account_name")
      .whereIn("vh.id", sourceVoucherIds);
    sourceHeaderAccountMap = new Map(sourceHeaderRows.map((row) => [Number(row.id), row]));
  }

  return {
    ...header,
    voucher_date: toDateOnly(header.voucher_date),
    lines: lines.map((line) => {
      const sourceVoucherId = Number(line?.meta?.source_voucher_id || 0);
      const sourceType = String(
        line?.meta?.source_voucher_type_code ||
          sourceVoucherMap.get(sourceVoucherId)?.voucher_type_code ||
          "",
      ).toUpperCase();
      const isAutoBankLine = String(header?.remarks || "").startsWith("[AUTO_BANK_SETTLEMENT]");
      const isSameAsBankHeader = Number(line.account_id || 0) > 0 && Number(line.account_id || 0) === Number(header?.header_account_id || 0);
      const sourceHeader = sourceHeaderAccountMap.get(sourceVoucherId);
      const shouldDisplayCashHeaderContra =
        isAutoBankLine &&
        sourceType === "CASH_VOUCHER" &&
        isSameAsBankHeader &&
        Number(sourceHeader?.header_account_id || 0) > 0;

      const resolvedAccountId = shouldDisplayCashHeaderContra
        ? Number(sourceHeader?.header_account_id || 0)
        : (Number(line.account_id || 0) || null);
      const displayCode = shouldDisplayCashHeaderContra
        ? (sourceHeader?.header_account_code || line.account_code || line.party_code || line.labour_code || line.employee_code || "")
        : (line.account_code || line.party_code || line.labour_code || line.employee_code || "");
      const displayName = shouldDisplayCashHeaderContra
        ? (sourceHeader?.header_account_name || line.account_name || line.party_name || line.labour_name || line.employee_name || "")
        : (line.account_name || line.party_name || line.labour_name || line.employee_name || "");

      return {
      id: line.id,
      line_no: line.line_no,
      line_kind: shouldDisplayCashHeaderContra ? "ACCOUNT" : line.line_kind,
      account_id: resolvedAccountId,
      party_id: line.party_id || null,
      labour_id: line.labour_id || null,
      employee_id: line.employee_id || null,
      code: displayCode,
      account_name: displayName,
      description: line.meta?.description || "",
      department_id: line.meta?.department_id || null,
      bank_status: String(line.meta?.bank_status || "PENDING").toUpperCase(),
      reference_no: line.reference_no || line.meta?.reference_no || "",
      source_voucher_id: Number(line.meta?.source_voucher_id || 0) || null,
      source_voucher_type_code: line.meta?.source_voucher_type_code || sourceVoucherMap.get(Number(line?.meta?.source_voucher_id || 0))?.voucher_type_code || null,
      source_voucher_no: Number(line.meta?.source_voucher_no || sourceVoucherMap.get(Number(line?.meta?.source_voucher_id || 0))?.voucher_no || 0) || null,
      source_line_id: Number(line.meta?.source_line_id || 0) || null,
      source_line_no: Number(line.meta?.source_line_no || 0) || null,
      direction_version: Number(line.meta?.direction_version || 1),
      debit: Number(line.meta?.debit || 0),
      credit: Number(line.meta?.credit || 0),
    };
    }),
  };
};

const createFinancialVoucherRouter = ({ titleKey, voucherTypeCode, scopeKey, routeView, subtitleKey, accountLabelKey, receiptLabelKey, paymentLabelKey, receiptKey, paymentKey }) => {
  const router = express.Router();

  router.get("/", requirePermission("VOUCHER", scopeKey, "view"), async (req, res, next) => {
    try {
      const forceNew = String(req.query.new || "").trim() === "1";
      const forceView = String(req.query.view || "").trim() === "1";
      const requestedVoucherNo = parseVoucherNo(req.query.voucher_no);
      const [options, rows, stats] = await Promise.all([
        loadOptions(req, voucherTypeCode),
        loadRecent(req, voucherTypeCode),
        getVoucherSeriesStats({ req, voucherTypeCode }),
      ]);
      const latestVoucherNo = stats.latestVoucherNo;
      const latestActiveVoucherNo = stats.latestActiveVoucherNo;
      const latestVisibleVoucherNo = latestActiveVoucherNo || latestVoucherNo || null;
      if (!forceNew && !forceView) {
        return res.redirect(`${req.baseUrl}?new=1`);
      }

      const selectedNo = forceNew ? null : requestedVoucherNo || latestVisibleVoucherNo;
      const selectedVoucher = await loadVoucherDetails({ req, voucherTypeCode, voucherNo: selectedNo });
      const currentCursorNo = forceNew
        ? latestVoucherNo + 1
        : requestedVoucherNo || Number(selectedVoucher?.voucher_no || latestVisibleVoucherNo || latestVoucherNo || 0);
      const { prevVoucherNo, nextVoucherNo } = await getVoucherNeighbours({
        req,
        voucherTypeCode,
        cursorNo: currentCursorNo,
      });
      const seriesNos = latestVoucherNo > 0 ? [latestVoucherNo] : [];

      return res.render("base/layouts/main", {
        title: `${res.locals.t(titleKey)} - ${res.locals.t("financial")}`,
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: routeView,
        t: res.locals.t,
        options,
        rows,
        selectedVoucher,
        prevVoucherNo,
        nextVoucherNo,
        seriesNos,
        basePath: req.baseUrl,
        scopeKey,
        voucherTypeCode,
        titleKey,
        subtitleKey,
        accountLabelKey,
        receiptLabelKey,
        paymentLabelKey,
        receiptKey,
        paymentKey,
      });
    } catch (err) {
      console.error("Error in FinancialVoucherPageService:", err);
      return next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const voucherId = Number(req.body?.voucher_id || 0) || null;
      const headerAccountId = Number(req.body?.header_account_id || 0) || null;
      const voucherDate = String(req.body?.voucher_date || "").trim();
      const remarks = String(req.body?.remarks || "").trim();
      const lines = toLines(req.body);
      if (!voucherDate) {
        setNotice(res, res.locals.t("error_required_fields"), true);
        return res.redirect(req.baseUrl);
      }

      const saved = voucherId
        ? await updateVoucher({
            req,
            voucherId,
            voucherTypeCode,
            voucherDate,
            remarks,
            lines,
            scopeKey,
            headerAccountId,
          })
        : await createVoucher({
            req,
            voucherTypeCode,
            voucherDate,
            remarks,
            lines,
            scopeKey,
            headerAccountId,
          });

      if (saved.queuedForApproval) {
        const msg = saved.permissionReroute
          ? res.locals.t("approval_sent") || "Change submitted for Administrator approval."
          : res.locals.t("approval_submitted");
        setNotice(res, msg, true);
      } else {
        setNotice(res, res.locals.t("saved_successfully"));
      }

      return res.redirect(`${req.baseUrl}?new=1`);
    } catch (err) {
      console.error("Error in FinancialVoucherSaveService:", err);
      setNotice(res, res.locals.t("generic_error"), true);
      return next(err);
    }
  });

  router.post("/delete", async (req, res, next) => {
    try {
      const voucherId = Number(req.body?.voucher_id || 0);
      if (!Number.isInteger(voucherId) || voucherId <= 0) {
        setNotice(res, res.locals.t("error_invalid_id"), true);
        return res.redirect(req.baseUrl);
      }

      const saved = await deleteVoucher({
        req,
        voucherId,
        voucherTypeCode,
        scopeKey,
      });

      if (saved.queuedForApproval) {
        const msg = saved.permissionReroute
          ? res.locals.t("approval_sent") || "Change submitted for Administrator approval."
          : res.locals.t("approval_submitted");
        setNotice(res, msg, true);
      } else {
        setNotice(res, res.locals.t("deleted_successfully") || "Deleted successfully.");
      }

      return res.redirect(req.baseUrl);
    } catch (err) {
      console.error("Error in FinancialVoucherDeleteService:", err);
      setNotice(res, res.locals.t("generic_error"), true);
      return next(err);
    }
  });

  return router;
};

module.exports = {
  createFinancialVoucherRouter,
};
