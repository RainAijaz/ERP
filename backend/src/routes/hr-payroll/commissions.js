const express = require("express");
const knex = require("../../db/knex");
const { createHrMasterRouter, hydratePage, fetchRows } = require("./master-router");
const { toMoney, hasTwoDecimalsOrLess } = require("./validation");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const {
  handleScreenApproval,
} = require("../../middleware/approvals/screen-approval");
const { queueAuditLog } = require("../../utils/audit-log");
const { setCookie, parseCookies } = require("../../middleware/utils/cookies");
const {
  ALLOWED_SCOPE_FOR_BULK,
  deriveValueTypeFromBasis,
  normalizeBulkInput,
  buildBulkPreviewRows,
  applyBulkSkuRateUpsert,
  supersedeCommissionRule,
  normalizeRuleDate,
  todayYmd,
} = require("../../services/hr-payroll/commission-rules-service");
const {
  COMPUTABLE_TYPES,
  normalizeRecalcInput,
  buildRecalcPlan,
  applyRecalcPlan,
  fetchActiveRulesForScope,
  VOUCHER_TYPES_BY_COMMISSION_TYPE,
} = require("../../services/hr-payroll/commission-recalc-service");
// Registers the approvals preview renderer for RECALC_APPROVAL_MODE. Required
// for its side effect — the registry is a module-level array populated at boot.
require("../../utils/approval-previews/commission-recalc-preview-provider");
const {
  RECALC_APPROVAL_MODE,
} = require("../../utils/commission-recalc-approval");
const COMMISSION_BASIS_FIXED_PER_UNIT = "FIXED_PER_UNIT";
const COMMISSION_RATE_TYPES = new Set(["PER_DOZEN", "PER_PAIR"]);
const COMMISSION_TYPES = new Set([
  "SALESMAN_SALE",
  "BRANCH_SALE",
  "TRANSFER",
  "PARTY",
  "PRODUCTION_FG",
  "PRODUCTION_SFG",
]);
const getAllowedBranchIds = (req) => {
  if (req?.user?.isAdmin) return [];
  return Array.isArray(req?.branchScope)
    ? req.branchScope
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    : [];
};
const isEmployeeInScope = async ({ employeeId, req }) => {
  const normalizedEmployeeId = Number(employeeId || 0);
  if (!Number.isInteger(normalizedEmployeeId) || normalizedEmployeeId <= 0)
    return false;
  const allowedBranchIds = getAllowedBranchIds(req);
  if (!allowedBranchIds.length) return true;
  const row = await knex("erp.employee_branch as eb")
    .select("eb.employee_id")
    .where("eb.employee_id", normalizedEmployeeId)
    .whereIn("eb.branch_id", allowedBranchIds)
    .first();
  return Boolean(row);
};

// A rule that starts in the past does NOT retro-fix vouchers already posted:
// commission is denormalized at voucher time. Rather than silently rewriting
// them, count what is affected so the screen can offer the Recalculate preview
// with the range pre-filled. Returns null when nothing is backdated.
const buildBackdateNotice = async ({
  effectiveFrom,
  employeeId,
  commissionType,
}) => {
  const from = normalizeRuleDate(effectiveFrom);
  const today = todayYmd();
  if (!from || from >= today) return null;

  const voucherTypeCodes =
    VOUCHER_TYPES_BY_COMMISSION_TYPE[
      String(commissionType || "SALESMAN_SALE").trim().toUpperCase()
    ] || [];
  if (!voucherTypeCodes.length) return null;

  const row = await knex("erp.voucher_header")
    .whereIn("voucher_type_code", voucherTypeCodes)
    .andWhere("status", "APPROVED")
    .andWhere("voucher_date", ">=", from)
    .andWhere("voucher_date", "<=", today)
    .count({ total: "*" })
    .first();

  const affected = Number(row?.total || 0);
  if (!affected) return null;
  return {
    backdated: true,
    from_date: from,
    to_date: today,
    employee_id: employeeId ? Number(employeeId) : null,
    commission_type: commissionType,
    affected_vouchers: affected,
  };
};

const page = {
  titleKey: "sales_commission",
  descriptionKey: "sales_commission_description",
  table: "erp.employee_commission_rules",
  scopeKey: "hr_payroll.commissions",
  entityType: "EMPLOYEE",
  branchScoped: false,
  branchFilter: {
    mapTable: "erp.employee_branch",
    mapKey: "employee_id",
    entityKey: "employee_id",
    branchKey: "branch_id",
  },
  autoCodeFromName: false,
  defaults: {
    reverse_on_returns: true,
    rate_type: "PER_PAIR",
    status: "active",
    commission_type: "SALESMAN_SALE",
    effective_from: todayYmd(),
  },
  filterConfig: {
    primary: {
      key: "employee_id",
      label: "employees",
      dbColumn: "t.employee_id",
      fieldName: "employee_id",
    },
    secondary: {
      key: "branch_id",
      label: "branch",
      dbColumn: "t.branch_id",
      fieldName: "branch_id",
    },
    tertiary: {
      key: "reverse_on_returns",
      label: "reverse_on_returns",
      dbColumn: "t.reverse_on_returns",
      options: [
        { value: "true", label: "yes" },
        { value: "false", label: "no" },
      ],
    },
  },
  // Close-and-append keeps every rate ever set, so the list would grow without
  // bound. Superseded rows are hidden unless the user asks for them.
  applyExtraFilters: (query, { requestQuery = {} }) => {
    const showPast = String(requestQuery.show_past_rates || "") === "1";
    if (showPast) return query;
    return query.whereRaw(
      "(t.effective_to IS NULL OR t.effective_to >= CURRENT_DATE)",
    );
  },
  hideBranchFilter: true,
  joins: [
    { table: { e: "erp.employees" }, on: ["t.employee_id", "e.id"] },
    { table: { s: "erp.skus" }, on: ["t.sku_id", "s.id"] },
    { table: { sg: "erp.product_subgroups" }, on: ["t.subgroup_id", "sg.id"] },
    { table: { pg: "erp.product_groups" }, on: ["t.group_id", "pg.id"] },
    // For SKU rows: follow sku → variant → item to get the item's subgroup/group
    { table: { sv: "erp.variants" }, on: ["s.variant_id", "sv.id"] },
    { table: { si: "erp.items" }, on: ["sv.item_id", "si.id"] },
    { table: { ssg: "erp.product_subgroups" }, on: ["si.subgroup_id", "ssg.id"] },
    { table: { spg: "erp.product_groups" }, on: ["si.group_id", "spg.id"] },
    { table: { br: "erp.branches" }, on: ["t.branch_id", "br.id"] },
  ],
  extraSelect: (locale) => [
    locale === "ur"
      ? knex.raw("COALESCE(e.name_ur, e.name) as employee_name")
      : "e.name as employee_name",
    locale === "ur"
      ? knex.raw("COALESCE(sg.name_ur, sg.name) as subgroup_name")
      : "sg.name as subgroup_name",
    locale === "ur"
      ? knex.raw("COALESCE(pg.name_ur, pg.name) as group_name")
      : "pg.name as group_name",
    "s.sku_code as sku_code",
    knex.raw(
      `CASE
        WHEN t.apply_on='SKU' THEN COALESCE(s.sku_code, '')
        WHEN t.apply_on='SUBGROUP' THEN COALESCE(sg.name, '')
        WHEN t.apply_on='GROUP' THEN COALESCE(pg.name, '')
        ELSE 'ALL'
      END as selector_display`,
    ),
    "t.source_rule_id",
    // Item-level subgroup/group for SKU rows (to show scope in 3-level display)
    locale === "ur"
      ? knex.raw("COALESCE(ssg.name_ur, ssg.name) as sku_subgroup_name")
      : "ssg.name as sku_subgroup_name",
    locale === "ur"
      ? knex.raw("COALESCE(spg.name_ur, spg.name) as sku_group_name")
      : "spg.name as sku_group_name",
    knex.raw(
      "CASE WHEN lower(trim(t.status)) = 'active' THEN true ELSE false END as is_active",
    ),
    // NULL branch = every branch this employee is mapped to. The list must say
    // so rather than render an empty cell that reads as missing data.
    locale === "ur"
      ? knex.raw("COALESCE(br.name_ur, br.name) as branch_name")
      : knex.raw("br.name as branch_name"),
    knex.raw("t.branch_id as branch_id"),
    knex.raw("to_char(t.effective_from, 'YYYY-MM-DD') as effective_from"),
    knex.raw("to_char(t.effective_to, 'YYYY-MM-DD') as effective_to"),
    knex.raw(
      `CASE
        WHEN t.effective_to IS NOT NULL AND t.effective_to < CURRENT_DATE THEN false
        WHEN t.effective_from > CURRENT_DATE THEN false
        ELSE true
      END as is_in_force`,
    ),
  ],
  fetchPageData: async ({ allowedBranchIds, locale, filters, req }) => {
    const labelExpr =
      locale === "ur" ? "COALESCE(e.name_ur, e.name)" : "e.name";
    let query = knex("erp.employee_commission_rules as t")
      .join("erp.employees as e", "t.employee_id", "e.id")
      .select(
        "e.id as employee_id",
        knex.raw(`${labelExpr} as employee_name`),
        knex.raw("COUNT(t.id)::int as rule_count"),
      )
      .groupBy("e.id", "e.name", "e.name_ur");

    // Count only what the expanded rows will show, or the badge drifts upward
    // forever as close-and-append accumulates history.
    if (String(req?.query?.show_past_rates || "") !== "1") {
      query = query.whereRaw(
        "(t.effective_to IS NULL OR t.effective_to >= CURRENT_DATE)",
      );
    }

    const { primaryValues, primaryMode } = filters;
    if (primaryValues && primaryValues.length) {
      const ids = primaryValues
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length) {
        if (primaryMode === "exclude") {
          query = query.whereNotIn("t.employee_id", ids);
        } else {
          query = query.whereIn("t.employee_id", ids);
        }
      }
    }

    if (allowedBranchIds && allowedBranchIds.length) {
      query = query.whereExists(function () {
        this.select(1)
          .from("erp.employee_branch as eb")
          .whereRaw("eb.employee_id = t.employee_id")
          .whereIn("eb.branch_id", allowedBranchIds);
      });
    }

    const groupSummary = await query.orderByRaw(`${labelExpr} asc`);
    return { rows: [], extra: { groupSummary } };
  },
  columns: [
    { key: "id", label: "id" },
    { key: "employee_name", label: "employees" },
    { key: "commission_type", label: "commission_type" },
    { key: "sku_code", label: "skus" },
    { key: "branch_name", label: "branch" },
    { key: "value", label: "rate_value" },
    { key: "effective_from", label: "effective_from" },
    { key: "effective_to", label: "effective_to" },
    { key: "reverse_on_returns", label: "reverse_on_returns" },
  ],
  fields: [
    {
      name: "employee_id",
      label: "employees",
      type: "select",
      multiple: true,
      required: true,
      optionsResolver: async ({ knex, locale, req }) => {
        const labelExpr =
          locale === "ur" ? "COALESCE(e.name_ur, e.name)" : "e.name";
        const allowedBranchIds = getAllowedBranchIds(req);
        let query = knex("erp.employees as e")
          .select("e.id as value", knex.raw(`${labelExpr} as label`))
          .whereRaw("lower(trim(e.status)) = 'active'");
        if (allowedBranchIds.length) {
          query = query.whereExists(function branchScope() {
            this.select(1)
              .from("erp.employee_branch as eb")
              .whereRaw("eb.employee_id = e.id")
              .whereIn("eb.branch_id", allowedBranchIds);
          });
        }
        const rows = await query.orderByRaw(`${labelExpr} asc`);
        return rows.map((row) => ({ value: row.value, label: row.label }));
      },
    },
    {
      name: "commission_type",
      label: "commission_type",
      type: "select",
      required: true,
      options: [
        { value: "SALESMAN_SALE",  label: "commission_type_salesman_sale" },
        { value: "BRANCH_SALE",    label: "commission_type_branch_sale" },
        { value: "TRANSFER",       label: "commission_type_transfer" },
        { value: "PARTY",          label: "commission_type_party" },
        { value: "PRODUCTION_FG",  label: "commission_type_production_fg" },
        { value: "PRODUCTION_SFG", label: "commission_type_production_sfg" },
      ],
    },
    {
      name: "apply_on",
      label: "apply_on",
      type: "select",
      required: true,
      options: [
        { value: "SKU", label: "apply_on_sku" },
        { value: "SUBGROUP", label: "apply_on_subgroup" },
        { value: "GROUP", label: "apply_on_group" },
      ],
    },
    {
      name: "sku_id",
      label: "sku",
      type: "select",
      multiple: true,
      showWhen: { field: "apply_on", values: ["SKU"] },
      optionsQuery: {
        table: "erp.skus as s",
        valueKey: "id",
        labelKey: "sku_code",
        select: ["s.id as id", "s.sku_code", "i.name as item_name"],
        joins: [
          { table: { v: "erp.variants" }, on: ["s.variant_id", "v.id"] },
          { table: { i: "erp.items" }, on: ["v.item_id", "i.id"] },
        ],
        whereRaw: "i.item_type = 'FG'",
        orderBy: "s.sku_code",
      },
      labelFormat: (row) =>
        `${row.sku_code}${row.item_name ? ` - ${row.item_name}` : ""}`,
    },
    {
      name: "subgroup_id",
      label: "product_subgroups",
      type: "select",
      multiple: true,
      showWhen: { field: "apply_on", values: ["SUBGROUP"] },
      optionsQuery: {
        table: "erp.product_subgroups",
        valueKey: "id",
        labelKey: "name",
        whereRaw:
          "EXISTS (SELECT 1 FROM erp.items i WHERE i.subgroup_id = erp.product_subgroups.id AND i.item_type = 'FG')",
        orderBy: "name",
      },
    },
    {
      name: "group_id",
      label: "product_groups",
      type: "select",
      multiple: true,
      showWhen: { field: "apply_on", values: ["GROUP"] },
      optionsQuery: {
        table: "erp.product_groups",
        valueKey: "id",
        labelKey: "name",
        whereRaw:
          "EXISTS (SELECT 1 FROM erp.items i WHERE i.group_id = erp.product_groups.id AND i.item_type = 'FG')",
        orderBy: "name",
      },
    },
    {
      // Blank = every branch this employee is mapped to. A branch-pinned rule
      // outranks a blank one, which is how one salesman earns a different rate
      // at different branches.
      name: "branch_id",
      label: "branch",
      type: "select",
      required: false,
      placeholderLabel: "all_employee_branches",
      optionsQuery: {
        table: "erp.branches",
        valueKey: "id",
        labelKey: "name",
        orderBy: "name",
      },
    },
    {
      name: "effective_from",
      label: "effective_from",
      type: "date",
      required: true,
    },
    {
      name: "effective_to",
      label: "effective_to",
      type: "date",
      required: false,
      hint: "effective_to_hint",
    },
    {
      name: "rate_type",
      label: "rate_type",
      type: "select",
      required: true,
      options: [
        { value: "PER_DOZEN", label: "rate_type_per_dozen" },
        { value: "PER_PAIR", label: "rate_type_per_pair" },
      ],
    },
    {
      name: "value",
      label: "rate_value",
      type: "number",
      min: 0,
      step: "0.01",
      required: true,
    },
    {
      name: "status",
      label: "status",
      type: "select",
      required: true,
      options: [
        { value: "active", label: "active" },
        { value: "inactive", label: "inactive" },
      ],
    },
    {
      name: "reverse_on_returns",
      label: "reverse_on_returns",
      type: "checkbox",
    },
  ],
  sanitizeValues: (values) => ({
    ...values,
    commission_type:
      COMMISSION_TYPES.has(String(values.commission_type || "").trim().toUpperCase())
        ? String(values.commission_type).trim().toUpperCase()
        : "SALESMAN_SALE",
    rate_type:
      String(values.rate_type || "")
        .trim()
        .toUpperCase() || "PER_PAIR",
    value: values.value == null ? null : String(values.value).trim(),
    status:
      String(values.status || "")
        .trim()
        .toLowerCase() === "inactive"
        ? "inactive"
        : "active",
    commission_basis: COMMISSION_BASIS_FIXED_PER_UNIT,
    value_type: deriveValueTypeFromBasis(COMMISSION_BASIS_FIXED_PER_UNIT),
    reverse_on_returns: values.reverse_on_returns !== false,
    effective_from: normalizeRuleDate(values.effective_from),
    effective_to: normalizeRuleDate(values.effective_to),
  }),
  validateValues: async ({ values, req, isUpdate, id }) => {
    const normalizeSelection = (rawValue) => {
      if (Array.isArray(rawValue))
        return rawValue
          .map((entry) => String(entry || "").trim())
          .filter(Boolean);
      if (rawValue && typeof rawValue === "object")
        return Object.values(rawValue)
          .map((entry) => String(entry || "").trim())
          .filter(Boolean);
      const single = String(rawValue || "").trim();
      return single ? [single] : [];
    };

    const firstSelection = (rawValue) => {
      const list = normalizeSelection(rawValue);
      return list.length ? list[0] : null;
    };

    if (!COMMISSION_TYPES.has(String(values.commission_type || "").trim().toUpperCase()))
      return req.res.locals.t("error_invalid_commission_type");
    const applyOn = new Set(["SKU", "SUBGROUP", "GROUP"]);
    if (!applyOn.has(values.apply_on))
      return req.res.locals.t("error_invalid_apply_on");
    if (!isUpdate && ALLOWED_SCOPE_FOR_BULK.has(values.apply_on)) {
      return req.res.locals.t("error_group_subgroup_only_for_bulk_commission");
    }
    values.commission_basis = COMMISSION_BASIS_FIXED_PER_UNIT;
    const derivedValueType = deriveValueTypeFromBasis(
      COMMISSION_BASIS_FIXED_PER_UNIT,
    );
    if (!derivedValueType) return req.res.locals.t("error_invalid_value_type");
    values.value_type = derivedValueType;
    if (
      !COMMISSION_RATE_TYPES.has(
        String(values.rate_type || "")
          .trim()
          .toUpperCase(),
      )
    )
      return req.res.locals.t("error_invalid_rate_type");
    if (values.status !== "active" && values.status !== "inactive")
      return req.res.locals.t("error_invalid_status");
    if (
      values.value == null ||
      Number(values.value) < 0 ||
      !hasTwoDecimalsOrLess(values.value)
    )
      return req.res.locals.t("error_invalid_rate_value");
    if (Number(values.value) > 99999999.99)
      return req.res.locals.t("error_invalid_rate_value");

    values.employee_id = firstSelection(values.employee_id);
    values.sku_id = firstSelection(values.sku_id);
    values.subgroup_id = firstSelection(values.subgroup_id);
    values.group_id = firstSelection(values.group_id);
    values.branch_id = firstSelection(values.branch_id);

    if (values.effective_from === undefined || values.effective_to === undefined)
      return req.res.locals.t("error_invalid_date");
    if (!values.effective_from)
      return {
        field: "effective_from",
        message: req.res.locals.t("error_effective_from_required"),
      };
    if (
      values.effective_to &&
      values.effective_to < values.effective_from
    )
      return {
        field: "effective_to",
        message: req.res.locals.t("error_invalid_date_range"),
      };

    if (!values.employee_id) return req.res.locals.t("error_required_fields");

    // Blank branch = every branch this employee is mapped to; a named branch
    // must be one the user is allowed to see AND one the employee works at,
    // otherwise the rule could never fire.
    if (values.branch_id) {
      const allowedBranchIds = getAllowedBranchIds(req);
      if (
        allowedBranchIds.length &&
        !allowedBranchIds.map(String).includes(String(values.branch_id))
      )
        return {
          field: "branch_id",
          message: req.res.locals.t("error_branch_out_of_scope"),
        };
      const mapped = await knex("erp.employee_branch")
        .where({
          employee_id: Number(values.employee_id || 0),
          branch_id: Number(values.branch_id),
        })
        .first();
      if (!mapped)
        return {
          field: "branch_id",
          message: req.res.locals.t("error_employee_not_at_branch"),
        };
    }

    if (
      values.employee_id &&
      !(await isEmployeeInScope({ employeeId: values.employee_id, req }))
    ) {
      return req.res.locals.t("error_branch_out_of_scope");
    }
    if (values.apply_on === "SKU" && !values.sku_id)
      return req.res.locals.t("error_select_sku");
    if (values.apply_on === "SUBGROUP" && !values.subgroup_id)
      return req.res.locals.t("error_select_subgroup");
    if (values.apply_on === "GROUP" && !values.group_id)
      return req.res.locals.t("error_select_group");
    if (values.apply_on !== "SKU") values.sku_id = null;
    if (values.apply_on !== "SUBGROUP") values.subgroup_id = null;
    if (values.apply_on !== "GROUP") values.group_id = null;

    // Two rules for the same key are no longer a duplicate — that is a rate
    // change, and supersedeCommissionRule closes the old one at the new start
    // date. The only genuine conflict left is two rules claiming the SAME start
    // date for the same key, which would leave the resolver picking arbitrarily.
    const duplicateQ = knex("erp.employee_commission_rules")
      .where({
        employee_id: values.employee_id,
        commission_type: values.commission_type,
        apply_on: values.apply_on,
        commission_basis: values.commission_basis,
        value_type: values.value_type,
      })
      .whereRaw("COALESCE(branch_id,0)=COALESCE(?,0)", [values.branch_id || 0])
      .whereRaw("COALESCE(sku_id,0)=COALESCE(?,0)", [values.sku_id || 0])
      .whereRaw("COALESCE(subgroup_id,0)=COALESCE(?,0)", [
        values.subgroup_id || 0,
      ])
      .whereRaw("COALESCE(group_id,0)=COALESCE(?,0)", [values.group_id || 0])
      .whereRaw("effective_from = ?::date", [values.effective_from]);
    if (isUpdate && id) duplicateQ.andWhereNot({ id });
    const duplicate = await duplicateQ.first();
    if (duplicate) return req.res.locals.t("error_duplicate_commission_rule");

    values.value = toMoney(values.value);
    return null;
  },
};

const router = express.Router();
const flashCookie = `hr_${page.scopeKey.replace(/\./g, "_")}_flash`;
const backdateCookie = `hr_${page.scopeKey.replace(/\./g, "_")}_backdate`;
const BULK_PREVIEW_PATH = "/hr-payroll/employees/commissions/bulk-preview";

const logBulkPreviewDiagnostic = (level, message, payload = {}) => {
  const logger = level === "error" ? console.error : console.warn;
  logger(`[commissions:bulk-preview] ${message}`, payload);
};

const normalizeSelectValues = (rawValue) => {
  if (Array.isArray(rawValue))
    return rawValue.map((entry) => String(entry || "").trim()).filter(Boolean);
  if (rawValue && typeof rawValue === "object")
    return Object.values(rawValue)
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  const single = String(rawValue || "").trim();
  if (!single) return [];
  return single
    .split(",")
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
};

const normalizeNumericIds = (rawValue) =>
  Array.from(
    new Set(
      normalizeSelectValues(rawValue)
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0),
    ),
  );

const normalizeNumericIdsFromQuery = (...rawValues) =>
  Array.from(
    new Set(
      rawValues
        .flatMap((raw) => normalizeSelectValues(raw))
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0),
    ),
  );

const buildValues = (body = {}) =>
  page.fields.reduce((acc, field) => {
    if (field.type === "checkbox") {
      acc[field.name] = body[field.name] === "on";
      return acc;
    }
    if (field.type === "select") {
      const rawValue = body[field.name];
      if (field.multiple === true) {
        acc[field.name] = normalizeSelectValues(rawValue);
        return acc;
      }
      const value = String(rawValue || "").trim();
      acc[field.name] = value === "" ? null : value;
      return acc;
    }
    if (field.type === "number") {
      const value = (body[field.name] || "").trim();
      acc[field.name] = value === "" ? null : value;
      return acc;
    }
    acc[field.name] = (body[field.name] || "").trim();
    return acc;
  }, {});

const normalizeValidationError = (validationError) => {
  if (!validationError) return null;
  if (typeof validationError === "string")
    return { message: validationError, fieldErrors: {} };
  if (typeof validationError === "object") {
    const message = validationError.message || "";
    const field = validationError.field || null;
    const fieldErrors =
      validationError.fieldErrors &&
      typeof validationError.fieldErrors === "object"
        ? validationError.fieldErrors
        : {};
    if (field && message) fieldErrors[field] = message;
    return { message, fieldErrors };
  }
  return { message: String(validationError), fieldErrors: {} };
};

const renderIndexError = (
  req,
  res,
  values,
  error,
  modalMode,
  fieldErrors = {},
) => {
  const payload = { values, error, modalMode, fieldErrors };
  setCookie(res, flashCookie, JSON.stringify(payload), {
    path: req.baseUrl,
    maxAge: 60,
    sameSite: "Lax",
  });
  return res.redirect(req.baseUrl);
};

router.post(
  "/",
  requirePermission("SCREEN", page.scopeKey, "create"),
  async (req, res, next) => {
    const values = buildValues(req.body);
    const sanitizedValues = page.sanitizeValues
      ? page.sanitizeValues(values, req)
      : values;

    try {
      const missing = page.fields
        .filter((field) => field.required)
        .filter((field) => {
          const value = sanitizedValues[field.name];
          return (
            value === null ||
            value === undefined ||
            value === "" ||
            (Array.isArray(value) && !value.length)
          );
        });
      if (missing.length) {
        const missingMap = missing.reduce((acc, field) => {
          acc[field.name] = res.locals.t("error_required_fields");
          return acc;
        }, {});
        return renderIndexError(
          req,
          res,
          sanitizedValues,
          res.locals.t("error_required_fields"),
          "create",
          missingMap,
        );
      }

      if (String(sanitizedValues.apply_on || "").toUpperCase() !== "SKU") {
        return next();
      }

      const employeeIds = normalizeNumericIds(sanitizedValues.employee_id);
      const skuIds = normalizeNumericIds(sanitizedValues.sku_id);
      if (!employeeIds.length || !skuIds.length) {
        const fieldErrors = {};
        if (!employeeIds.length)
          fieldErrors.employee_id = res.locals.t("error_required_fields");
        if (!skuIds.length)
          fieldErrors.sku_id = res.locals.t("error_select_sku");
        return renderIndexError(
          req,
          res,
          sanitizedValues,
          res.locals.t("error_required_fields"),
          "create",
          fieldErrors,
        );
      }
      for (const employeeId of employeeIds) {
        if (!(await isEmployeeInScope({ employeeId, req }))) {
          return renderIndexError(
            req,
            res,
            sanitizedValues,
            res.locals.t("error_branch_out_of_scope"),
            "create",
            { employee_id: res.locals.t("error_branch_out_of_scope") },
          );
        }
      }

      const rowPlans = [];
      for (const employeeId of employeeIds) {
        for (const skuId of skuIds) {
          const rowValues = {
            ...sanitizedValues,
            employee_id: employeeId,
            apply_on: "SKU",
            sku_id: skuId,
            subgroup_id: null,
            group_id: null,
          };

          // "Existing" now means only the row already starting on this exact
          // date — anything else is an earlier period that supersede will close
          // rather than overwrite, and must not be treated as a duplicate.
          const existingRows = await knex(page.table)
            .select("id")
            .where({
              employee_id: employeeId,
              apply_on: "SKU",
              sku_id: skuId,
              commission_type: rowValues.commission_type,
              commission_basis: rowValues.commission_basis,
              value_type: rowValues.value_type,
            })
            .whereRaw("COALESCE(branch_id,0) = COALESCE(?,0)", [
              rowValues.branch_id || 0,
            ])
            .whereRaw("effective_from = ?::date", [rowValues.effective_from])
            .orderBy("id", "desc");
          const existing = existingRows[0] || null;
          const duplicateIdsToDelete = existingRows
            .slice(1)
            .map((row) => Number(row.id));

          if (page.validateValues) {
            const valuesForValidation = { ...rowValues };
            const validationError = await page.validateValues({
              values: valuesForValidation,
              req,
              isUpdate: Boolean(existing),
              id: existing?.id || null,
              knex,
            });
            if (validationError) {
              const normalized = normalizeValidationError(validationError);
              return renderIndexError(
                req,
                res,
                sanitizedValues,
                normalized.message || validationError,
                "create",
                normalized.fieldErrors,
              );
            }
            rowValues.value = valuesForValidation.value;
            rowValues.rate_type = valuesForValidation.rate_type;
            rowValues.commission_basis = valuesForValidation.commission_basis;
            rowValues.value_type = valuesForValidation.value_type;
            rowValues.status = valuesForValidation.status;
            rowValues.reverse_on_returns =
              valuesForValidation.reverse_on_returns;
          }

          rowPlans.push({
            existingId: existing?.id || null,
            duplicateIdsToDelete,
            values: rowValues,
          });
        }
      }

      const hasExistingRows = rowPlans.some((plan) => Boolean(plan.existingId));
      const approvalPayload = {
        mode: "SKU_MULTI_UPSERT",
        employee_ids: employeeIds,
        sku_ids: skuIds,
        apply_on: "SKU",
        commission_type: sanitizedValues.commission_type,
        branch_id: sanitizedValues.branch_id || null,
        effective_from: sanitizedValues.effective_from,
        effective_to: sanitizedValues.effective_to || null,
        status: sanitizedValues.status,
        reverse_on_returns: sanitizedValues.reverse_on_returns !== false,
        rate_type: sanitizedValues.rate_type,
        commission_basis: sanitizedValues.commission_basis,
        value_type: sanitizedValues.value_type,
        value: sanitizedValues.value,
        rows: rowPlans.map((plan) => ({
          employee_id: plan.values.employee_id,
          sku_id: plan.values.sku_id,
          rate_type: plan.values.rate_type,
          value: plan.values.value,
        })),
      };

      const approval = await handleScreenApproval({
        req,
        scopeKey: page.scopeKey,
        action: hasExistingRows ? "edit" : "create",
        entityType: page.entityType,
        entityId:
          rowPlans.length === 1 ? rowPlans[0].existingId || "NEW" : "BULK",
        summary: `${res.locals.t(hasExistingRows ? "edit" : "add")} ${res.locals.t(page.titleKey)} (${employeeIds.length} ${res.locals.t("employees") || "employees"}, ${skuIds.length} ${res.locals.t("skus")})`,
        oldValue: null,
        newValue: approvalPayload,
        t: res.locals.t,
      });
      if (approval.queued) {
        return res.redirect(req.get("referer") || req.baseUrl);
      }

      let createdCount = 0;
      let updatedCount = 0;
      await knex.transaction(async (trx) => {
        for (const plan of rowPlans) {
          if (plan.duplicateIdsToDelete.length) {
            await trx(page.table)
              .whereIn("id", plan.duplicateIdsToDelete)
              .del();
          }
          if (plan.existingId) {
            // Same start date: this period's figure was wrong, correct it in
            // place rather than stacking a second row on the same day.
            await trx(page.table)
              .where({ id: plan.existingId })
              .update(plan.values);
            updatedCount += 1;
          } else {
            await supersedeCommissionRule({
              trx,
              employeeId: Number(plan.values.employee_id),
              commissionType: plan.values.commission_type,
              applyOn: "SKU",
              branchId: plan.values.branch_id || null,
              skuId: Number(plan.values.sku_id),
              effectiveFrom: plan.values.effective_from,
              effectiveTo: plan.values.effective_to || null,
              values: {
                commission_basis: plan.values.commission_basis,
                value_type: plan.values.value_type,
                rate_type: plan.values.rate_type,
                value: plan.values.value,
                reverse_on_returns: plan.values.reverse_on_returns,
                status: plan.values.status,
              },
            });
            createdCount += 1;
          }
        }
      });

      queueAuditLog(req, {
        entityType: page.entityType,
        entityId:
          rowPlans.length === 1 ? rowPlans[0].existingId || "NEW" : "BULK",
        action: hasExistingRows ? "UPDATE" : "CREATE",
        context: {
          source: "commission-create-upsert",
          mode: "SKU_MULTI_UPSERT",
          created_count: createdCount,
          updated_count: updatedCount,
        },
      });

      const backdate = await buildBackdateNotice({
        effectiveFrom: sanitizedValues.effective_from,
        employeeId: employeeIds[0],
        commissionType: sanitizedValues.commission_type,
      });
      if (backdate) {
        setCookie(res, backdateCookie, JSON.stringify(backdate), {
          path: req.baseUrl,
          maxAge: 120,
          sameSite: "Lax",
        });
      }

      return res.redirect(req.baseUrl);
    } catch (err) {
      console.error("Error in CommissionRulesService:", err);
      return renderIndexError(
        req,
        res,
        sanitizedValues,
        err?.message || res.locals.t("generic_error"),
        "create",
      );
    }
  },
);

router.get(
  "/bulk-preview",
  requirePermission("SCREEN", page.scopeKey, "view"),
  async (req, res) => {
    const diagnostics = {
      request_id: req.id || null,
      user_id: req.user?.id || null,
      username: req.user?.username || null,
      method: req.method,
      path: req.originalUrl || BULK_PREVIEW_PATH,
      query: {
        apply_on: req.query.apply_on || null,
        employee_id: req.query.employee_id || null,
        subgroup_id: req.query.subgroup_id || null,
        subgroup_ids: req.query.subgroup_ids || null,
        group_id: req.query.group_id || null,
        group_ids: req.query.group_ids || null,
        rate_type: req.query.rate_type || null,
        value: req.query.value || null,
      },
    };

    try {
      const applyOn = String(req.query.apply_on || "")
        .trim()
        .toUpperCase();
      const employeeId = Number(req.query.employee_id || 0) || null;
      const subgroupIds = normalizeNumericIdsFromQuery(
        req.query.subgroup_ids,
        req.query.subgroup_id,
      );
      const groupIds = normalizeNumericIdsFromQuery(
        req.query.group_ids,
        req.query.group_id,
      );
      const baseRate = req.query.value;
      // "Previous rate" must be the rate in force at this branch on the date the
      // new one starts, not whichever row happens to exist.
      const previewBranchId = Number(req.query.branch_id || 0) || null;
      const previewEffectiveFrom =
        normalizeRuleDate(req.query.effective_from) || todayYmd();
      // Scopes which SKUs the grid lists (SFG for PRODUCTION_SFG, FG otherwise)
      // and which existing rules count as the "previous rate".
      const previewCommissionTypeRaw = String(req.query.commission_type || "")
        .trim()
        .toUpperCase();
      const previewCommissionType = COMMISSION_TYPES.has(
        previewCommissionTypeRaw,
      )
        ? previewCommissionTypeRaw
        : "SALESMAN_SALE";

      if (!ALLOWED_SCOPE_FOR_BULK.has(applyOn)) {
        logBulkPreviewDiagnostic(
          "warn",
          "Validation failed: invalid apply_on",
          {
            ...diagnostics,
            normalized_apply_on: applyOn,
          },
        );
        return res.status(400).json({
          message: res.locals.t(
            "error_group_subgroup_only_for_bulk_commission",
          ),
        });
      }
      if (applyOn === "SUBGROUP" && !subgroupIds.length) {
        logBulkPreviewDiagnostic(
          "warn",
          "Validation failed: subgroup_id missing for SUBGROUP mode",
          {
            ...diagnostics,
            normalized_apply_on: applyOn,
          },
        );
        return res
          .status(400)
          .json({ message: res.locals.t("error_select_subgroup") });
      }
      if (applyOn === "GROUP" && !groupIds.length) {
        logBulkPreviewDiagnostic(
          "warn",
          "Validation failed: group_id missing for GROUP mode",
          {
            ...diagnostics,
            normalized_apply_on: applyOn,
          },
        );
        return res
          .status(400)
          .json({ message: res.locals.t("error_select_group") });
      }
      if (
        employeeId &&
        !(await isEmployeeInScope({ employeeId, req }))
      ) {
        return res
          .status(403)
          .json({ message: res.locals.t("error_branch_out_of_scope") });
      }

      const rows = await buildBulkPreviewRows({
        employeeId,
        applyOn,
        subgroupIds,
        groupIds,
        commissionType: previewCommissionType,
        branchId: previewBranchId,
        effectiveFrom: previewEffectiveFrom,
        baseRate,
      });

      return res.json({ rows });
    } catch (err) {
      logBulkPreviewDiagnostic(
        "error",
        "Unhandled exception while building preview rows",
        {
          ...diagnostics,
          error_message: err?.message || String(err),
          error_code: err?.code || null,
          error_stack: err?.stack || null,
        },
      );
      return res.status(500).json({ message: res.locals.t("generic_error") });
    }
  },
);

router.post(
  "/bulk-upsert",
  requirePermission("SCREEN", page.scopeKey, "create"),
  async (req, res) => {
    try {
      const normalized = normalizeBulkInput({
        payload: req.body || {},
        t: res.locals.t,
      });
      if (
        normalized.employeeId &&
        !(await isEmployeeInScope({ employeeId: normalized.employeeId, req }))
      ) {
        return res
          .status(403)
          .json({ message: res.locals.t("error_branch_out_of_scope") });
      }

      const expectedRows = await buildBulkPreviewRows({
        employeeId: normalized.employeeId,
        applyOn: normalized.applyOn,
        subgroupIds: normalized.subgroupIds,
        groupIds: normalized.groupIds,
        commissionBasis: normalized.commissionBasis,
        commissionType: normalized.commissionType,
        branchId: normalized.branchId,
        effectiveFrom: normalized.effectiveFrom,
        baseRate: null,
      });
      const requestedRateBySku = new Map(
        normalized.rows
          .map((row) => [Number(row.skuId), row.rate])
          .filter(([skuId]) => Number.isInteger(skuId) && skuId > 0),
      );
      const queuedRows = expectedRows.map((row) => {
        const skuId = Number(row.sku_id || 0);
        const nextRate = requestedRateBySku.has(skuId)
          ? requestedRateBySku.get(skuId)
          : row.new_rate;
        return {
          sku_id: skuId,
          sku_code: row.sku_code || "",
          item_name: row.item_name || "",
          previous_rate: row.previous_rate ?? null,
          previous_rate_type: row.previous_rate_type || null,
          subgroup_id: row.subgroup_id ?? null,
          group_id: row.group_id ?? null,
          new_rate: nextRate ?? null,
        };
      });
      const allowedSkuIds = new Set(
        expectedRows.map((row) => Number(row.sku_id)),
      );
      const invalidSku = normalized.rows.find(
        (row) => !allowedSkuIds.has(Number(row.skuId)),
      );
      if (invalidSku || normalized.rows.length !== expectedRows.length) {
        return res.status(400).json({
          message: res.locals.t("error_invalid_bulk_commission_payload"),
        });
      }

      const employeeForSummary = await knex("erp.employees")
        .select("name")
        .where({ id: normalized.employeeId })
        .first();
      const approval = await handleScreenApproval({
        req,
        scopeKey: page.scopeKey,
        action: "create",
        entityType: page.entityType,
        entityId: normalized.employeeId,
        summary: `${res.locals.t("add")} ${res.locals.t(page.titleKey)}${employeeForSummary?.name ? " - " + employeeForSummary.name : ""} (${queuedRows.length})`,
        oldValue: null,
        newValue: {
          mode: "BULK_COMMISSION_SKU_UPSERT",
          apply_on: normalized.applyOn,
          commission_type: normalized.commissionType,
          employee_id: normalized.employeeId,
          branch_id: normalized.branchId,
          effective_from: normalized.effectiveFrom,
          effective_to: normalized.effectiveTo,
          subgroup_id: normalized.subgroupId,
          subgroup_ids: normalized.subgroupIds,
          group_id: normalized.groupId,
          group_ids: normalized.groupIds,
          scope_rate: normalized.scopeRate,
          rate_type: normalized.rateType,
          reverse_on_returns: normalized.reverseOnReturns,
          status: normalized.status,
          rows: queuedRows,
        },
        t: res.locals.t,
      });

      if (approval.queued) {
        const canViewApprovals =
          typeof res.locals.can === "function"
            ? res.locals.can("SCREEN", "administration.approvals", "navigate")
            : false;
        return res.status(202).json({
          queued: true,
          approval_request_id: approval.requestId || null,
          approvals_url: canViewApprovals ? "/administration/approvals" : null,
          message:
            res.locals.t("approval_sent") || res.locals.t("approval_submitted"),
        });
      }

      const skuSelectorMap = new Map(
        expectedRows.map((row) => [
          Number(row.sku_id),
          { subgroupId: row.subgroup_id ?? null, groupId: row.group_id ?? null },
        ]),
      );
      const enrichedRows = normalized.rows.map((row) => ({
        skuId: row.skuId,
        rate: row.rate,
        subgroupId: skuSelectorMap.get(Number(row.skuId))?.subgroupId ?? null,
        groupId: skuSelectorMap.get(Number(row.skuId))?.groupId ?? null,
      }));

      const result = await knex.transaction(async (trx) => {
        return applyBulkSkuRateUpsert({
          trx,
          employeeId: normalized.employeeId,
          applyOn: normalized.applyOn,
          commissionType: normalized.commissionType,
          branchId: normalized.branchId,
          effectiveFrom: normalized.effectiveFrom,
          effectiveTo: normalized.effectiveTo,
          subgroupIds: normalized.subgroupIds,
          groupIds: normalized.groupIds,
          scopeRate: normalized.scopeRate,
          rateType: normalized.rateType,
          valueType: normalized.valueType,
          reverseOnReturns: normalized.reverseOnReturns,
          status: normalized.status,
          rows: enrichedRows,
        });
      });

      queueAuditLog(req, {
        entityType: page.entityType,
        entityId: normalized.employeeId,
        action: "UPDATE",
        context: {
          source: "commission-bulk-upsert",
          apply_on: normalized.applyOn,
          scope_rate: normalized.scopeRate,
          created: result.created,
          updated: result.updated,
          row_count: normalized.rows.length,
        },
      });

      const backdate = await buildBackdateNotice({
        effectiveFrom: normalized.effectiveFrom,
        employeeId: normalized.employeeId,
        commissionType: normalized.commissionType,
      });
      // Same cookie the single-rule save uses: the grid reloads to the list
      // after a bulk save, and the middleware surfaces the notice there. One
      // path for both rather than a second in-modal prompt.
      if (backdate) {
        setCookie(res, backdateCookie, JSON.stringify(backdate), {
          path: req.baseUrl,
          maxAge: 120,
          sameSite: "Lax",
        });
      }

      return res.json({
        ok: true,
        created: result.created,
        updated: result.updated,
        backdate,
        message:
          res.locals.t("success_bulk_commission_saved") ||
          res.locals.t("saved"),
      });
    } catch (err) {
      console.error("Error in CommissionRulesService:", err);
      return res
        .status(400)
        .json({ message: err?.message || res.locals.t("generic_error") });
    }
  },
);

router.get(
  "/employee-rules",
  requirePermission("SCREEN", page.scopeKey, "view"),
  async (req, res, next) => {
    try {
      const employeeId = Number(req.query.employee_id);
      if (!Number.isInteger(employeeId) || employeeId <= 0) {
        return res.status(400).json({ error: "invalid_employee_id" });
      }
      if (!(await isEmployeeInScope({ employeeId, req }))) {
        return res.status(403).json({ error: "not_in_scope" });
      }
      const allowedBranchIds = getAllowedBranchIds(req);
      const rows = await fetchRows(page, {
        branchId: req.user?.isAdmin ? null : req.branchId,
        allowedBranchIds,
        locale: req.locale || "en",
        maxRows: 0,
        filters: {
          primaryValues: [employeeId],
          primaryMode: "include",
        },
        // The list body is a per-employee group summary; these are the rows the
        // user actually reads when they expand one. Without the querystring the
        // "Show past rates" toggle would flip the URL and change nothing.
        requestQuery: req.query || {},
      });
      return res.json({ rows });
    } catch (err) {
      return next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Recalculate commission for a past date range.
//
// Commission is denormalized at voucher time and rules are not effective-dated,
// so correcting a rate today never reaches vouchers already posted. These routes
// preview and apply a recomputation over an arbitrary range — arbitrary because
// salary cycles here do not start on the 1st.
// ---------------------------------------------------------------------------

const buildRecalcInput = (req, source) => {
  const payload = source || {};
  return normalizeRecalcInput({
    commission_types: payload.commission_types,
    from_date: payload.from_date,
    to_date: payload.to_date,
    employee_id: payload.employee_id,
    clear_orphans: payload.clear_orphans,
    allowedBranchIds: getAllowedBranchIds(req),
  });
};

// Feeds the guardrail panel: rules have no effective dates, so the only honest
// thing the screen can do is show exactly which rules the recompute will use.
router.get(
  "/recalc-rules",
  requirePermission("SCREEN", page.scopeKey, "view"),
  async (req, res) => {
    try {
      const employeeId = Number(req.query.employee_id || 0) || null;
      if (employeeId && !(await isEmployeeInScope({ employeeId, req }))) {
        return res
          .status(403)
          .json({ message: res.locals.t("error_branch_out_of_scope") });
      }
      const commissionTypes = String(req.query.commission_types || "")
        .split(",")
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean);
      const rules = await fetchActiveRulesForScope({
        db: knex,
        employeeId,
        commissionTypes: commissionTypes.length ? commissionTypes : COMPUTABLE_TYPES,
        locale: req.locale || "en",
      });
      return res.json({ rules });
    } catch (err) {
      console.error("[commission-recalc] rules lookup failed:", err);
      return res.status(500).json({ message: res.locals.t("generic_error") });
    }
  },
);

router.get(
  "/recalc-preview",
  requirePermission("SCREEN", page.scopeKey, "view"),
  async (req, res) => {
    try {
      const input = buildRecalcInput(req, req.query);
      if (!input.fromDate || !input.toDate) {
        return res
          .status(400)
          .json({ message: res.locals.t("error_recalc_date_range_required") });
      }
      if (input.employeeId && !(await isEmployeeInScope({ employeeId: input.employeeId, req }))) {
        return res
          .status(403)
          .json({ message: res.locals.t("error_branch_out_of_scope") });
      }

      const plan = await buildRecalcPlan({
        db: knex,
        input,
        locale: req.locale || "en",
        t: res.locals.t,
      });

      // The write descriptors are re-derived at apply time; sending them to the
      // browser would only bloat the response and invite tampering.
      return res.json({
        filters: {
          commission_types: input.commissionTypes,
          from_date: input.fromDate,
          to_date: input.toDate,
          employee_id: input.employeeId,
          clear_orphans: input.clearOrphans,
          date_range_corrected: input.dateRangeCorrected,
        },
        rows: plan.rows.map(({ write, ...row }) => row),
        counts: plan.counts,
        totals: plan.totals,
        over_limit: plan.over_limit,
        limit: plan.limit,
      });
    } catch (err) {
      console.error("[commission-recalc] preview failed:", err);
      return res.status(500).json({ message: res.locals.t("generic_error") });
    }
  },
);

router.post(
  "/recalc",
  requirePermission("SCREEN", page.scopeKey, "edit"),
  async (req, res) => {
    try {
      const input = buildRecalcInput(req, req.body);
      if (!input.fromDate || !input.toDate) {
        return res
          .status(400)
          .json({ message: res.locals.t("error_recalc_date_range_required") });
      }
      if (input.employeeId && !(await isEmployeeInScope({ employeeId: input.employeeId, req }))) {
        return res
          .status(403)
          .json({ message: res.locals.t("error_branch_out_of_scope") });
      }

      // Rebuilt server-side from the filter; any rows the client sent are ignored.
      const plan = await buildRecalcPlan({
        db: knex,
        input,
        locale: req.locale || "en",
        t: res.locals.t,
      });
      const writes = plan.rows.filter((row) => row.will_write);

      if (plan.over_limit) {
        return res.status(400).json({
          message: res.locals.t("error_recalc_over_limit"),
          limit: plan.limit,
          writes: writes.length,
        });
      }
      if (!writes.length) {
        return res
          .status(400)
          .json({ message: res.locals.t("error_recalc_nothing_to_write") });
      }

      const employeeIds = [...new Set(writes.map((row) => Number(row.employee_id)))];
      const employeeNames = {};
      writes.forEach((row) => {
        employeeNames[row.employee_id] = row.employee_name;
      });

      const approval = await handleScreenApproval({
        req,
        res,
        scopeKey: page.scopeKey,
        action: "edit",
        entityType: page.entityType,
        entityId: String(employeeIds[0] || "NEW"),
        summary: `${res.locals.t("recalculate_commission")} - ${input.fromDate} .. ${input.toDate} (${writes.length})`,
        oldValue: null,
        newValue: {
          mode: RECALC_APPROVAL_MODE,
          from_date: input.fromDate,
          to_date: input.toDate,
          commission_types: input.commissionTypes,
          employee_id: input.employeeId,
          clear_orphans: input.clearOrphans,
          employee_names: employeeNames,
          totals: plan.totals,
          counts: plan.counts,
          // Slim rows: enough for the approver to see exactly what they are
          // committing, without carrying lines_detail or write descriptors.
          rows: writes.map((row) => ({
            v: row.voucher_id,
            n: row.voucher_no,
            d: row.voucher_date,
            e: row.employee_id,
            t: row.commission_type,
            o: row.previous_rate,
            w: row.new_rate,
            s: row.status,
          })),
        },
      });

      if (approval?.queued) {
        const canViewApprovals =
          typeof res.locals.can === "function"
            ? res.locals.can("SCREEN", "administration.approvals", "navigate")
            : false;
        return res.status(202).json({
          queued: true,
          approval_request_id: approval.requestId || null,
          approvals_url: canViewApprovals ? "/administration/approvals" : null,
          writes: writes.length,
          message:
            res.locals.t("approval_sent") || res.locals.t("approval_submitted"),
        });
      }

      const provenance = {
        at: new Date().toISOString(),
        by: req.user?.id || null,
        source: "commission-recalc-screen",
        from_date: input.fromDate,
        to_date: input.toDate,
      };
      const result = await knex.transaction((trx) =>
        applyRecalcPlan({ trx, rows: plan.rows, provenance }),
      );

      queueAuditLog(req, {
        entityType: page.entityType,
        entityId: String(employeeIds[0] || ""),
        action: "UPDATE",
        context: {
          source: "commission-recalc",
          from_date: input.fromDate,
          to_date: input.toDate,
          commission_types: input.commissionTypes,
          employee_id: input.employeeId,
          clear_orphans: input.clearOrphans,
          writes: writes.length,
          totals: plan.totals,
          ledger_rows: result.ledgerRows,
          sales_vouchers: result.salesVouchers,
        },
      });

      return res.json({
        ok: true,
        writes: writes.length,
        totals: plan.totals,
        result,
        message: res.locals.t("success_commission_recalculated"),
      });
    } catch (err) {
      console.error("[commission-recalc] apply failed:", err);
      return res
        .status(400)
        .json({ message: err?.message || res.locals.t("generic_error") });
    }
  },
);

// Hands the backdate notice set by the create path to the screen exactly once,
// so the "review N vouchers" prompt survives the post-save redirect.
router.use((req, res, next) => {
  res.locals.commissionBackdateNotice = null;
  const raw = parseCookies(req)[backdateCookie];
  if (!raw) return next();
  try {
    res.locals.commissionBackdateNotice = JSON.parse(raw);
  } catch (err) {
    res.locals.commissionBackdateNotice = null;
  }
  setCookie(res, backdateCookie, "", { path: req.baseUrl, maxAge: 0 });
  return next();
});

router.use("/", createHrMasterRouter(page));

router.preview = {
  page,
  hydratePage,
};

module.exports = router;
