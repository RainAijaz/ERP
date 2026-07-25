const express = require("express");
const knex = require("../../db/knex");
const { createHrMasterRouter, hydratePage } = require("./master-router");
const { toMoney, hasTwoDecimalsOrLess } = require("./validation");

const getAllowedBranchIds = (req) => {
  if (req?.user?.isAdmin) return [];
  return Array.isArray(req?.branchScope)
    ? req.branchScope
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    : [];
};

// Normalizes an <input type="date"> value ("YYYY-MM-DD" or "") to a stored
// date string or null. Returns undefined when the value is not a valid date.
const normalizeAllowanceDate = (value) => {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
};

const page = {
  titleKey: "labour_allowances",
  descriptionKey: "labour_allowances_description",
  table: "erp.labour_allowance_rules",
  scopeKey: "hr_payroll.labour_allowances",
  entityType: "LABOUR",
  branchScoped: false,
  autoCodeFromName: false,
  defaults: {
    amount_type: "FIXED",
    frequency: "MONTHLY",
    taxable: false,
    status: "active",
  },
  filterConfig: {
    primary: {
      key: "amount_type",
      label: "amount_type",
      dbColumn: "t.amount_type",
      options: [
        { value: "FIXED", label: "amount_type_fixed" },
        { value: "PERCENT_BASIC", label: "amount_type_percent_basic" },
      ],
    },
    secondary: {
      key: "frequency",
      label: "frequency",
      dbColumn: "t.frequency",
      options: [
        { value: "MONTHLY", label: "frequency_monthly" },
        { value: "DAILY", label: "frequency_daily" },
      ],
    },
  },
  branchFilter: {
    mapTable: "erp.labour_branch",
    mapKey: "labour_id",
    entityKey: "labour_id",
    branchKey: "branch_id",
  },
  joins: [{ table: { l: "erp.labours" }, on: ["t.labour_id", "l.id"] }],
  extraSelect: (locale) => [
    locale === "ur"
      ? knex.raw("COALESCE(l.name_ur, l.name) as labour_name")
      : "l.name as labour_name",
    knex.raw("to_char(t.effective_from, 'YYYY-MM-DD') as effective_from"),
    knex.raw("to_char(t.effective_to, 'YYYY-MM-DD') as effective_to"),
    knex.raw(
      "CASE WHEN lower(trim(t.status)) = 'active' THEN true ELSE false END as is_active",
    ),
  ],
  columns: [
    { key: "id", label: "id" },
    { key: "labour_name", label: "labours" },
    { key: "allowance_type", label: "allowance_type" },
    { key: "amount_type", label: "amount_type" },
    { key: "amount", label: "amount" },
    { key: "frequency", label: "frequency" },
    { key: "effective_from", label: "effective_from" },
    { key: "effective_to", label: "effective_to" },
    { key: "taxable", label: "taxable" },
    { key: "status", label: "status" },
  ],
  fields: [
    {
      name: "labour_id",
      label: "labours",
      type: "select",
      required: true,
      optionsResolver: async ({ knex, locale, req }) => {
        const labelExpr =
          locale === "ur" ? "COALESCE(l.name_ur, l.name)" : "l.name";
        const allowedBranchIds = getAllowedBranchIds(req);
        let query = knex("erp.labours as l")
          .select("l.id as value", knex.raw(`${labelExpr} as label`))
          .whereRaw("lower(trim(l.status)) = 'active'");
        if (allowedBranchIds.length) {
          query = query.whereExists(function branchScope() {
            this.select(1)
              .from("erp.labour_branch as lb")
              .whereRaw("lb.labour_id = l.id")
              .whereIn("lb.branch_id", allowedBranchIds);
          });
        }
        const rows = await query.orderByRaw(`${labelExpr} asc`);
        return rows.map((row) => ({ value: row.value, label: row.label }));
      },
    },
    {
      name: "allowance_type",
      label: "allowance_type",
      required: true,
      placeholder: "placeholder_allowance_type",
    },
    {
      name: "amount_type",
      label: "amount_type",
      type: "select",
      required: true,
      options: [
        { value: "FIXED", label: "amount_type_fixed" },
        { value: "PERCENT_BASIC", label: "amount_type_percent_basic" },
      ],
    },
    { name: "amount", label: "amount", type: "number", min: 0, step: "0.01", required: true },
    {
      name: "frequency",
      label: "frequency",
      type: "select",
      required: true,
      options: [
        { value: "MONTHLY", label: "frequency_monthly" },
        { value: "DAILY", label: "frequency_daily" },
      ],
    },
    { name: "effective_from", label: "effective_from", type: "date" },
    { name: "effective_to", label: "effective_to", type: "date" },
    { name: "taxable", label: "taxable", type: "checkbox" },
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
  ],
  sanitizeValues: (values) => ({
    ...values,
    allowance_type: String(values.allowance_type || "").trim(),
    amount: values.amount == null ? null : String(values.amount).trim(),
    effective_from: normalizeAllowanceDate(values.effective_from),
    effective_to: normalizeAllowanceDate(values.effective_to),
  }),
  validateValues: async ({ values, req, isUpdate, id }) => {
    const amountTypes = new Set(["FIXED", "PERCENT_BASIC"]);
    const frequencies = new Set(["MONTHLY", "DAILY"]);
    if (!amountTypes.has(values.amount_type)) return req.res.locals.t("error_invalid_amount_type");
    if (!frequencies.has(values.frequency)) return req.res.locals.t("error_invalid_frequency");
    if (values.status !== "active" && values.status !== "inactive") return req.res.locals.t("error_invalid_status");
    if (!values.labour_id) return { field: "labour_id", message: req.res.locals.t("error_select_labour") };
    if (!values.allowance_type) return req.res.locals.t("error_required_fields");
    if (values.amount == null || Number(values.amount) < 0 || !hasTwoDecimalsOrLess(values.amount)) return req.res.locals.t("error_invalid_rate_value");
    if (Number(values.amount) > 99999999.99) return req.res.locals.t("error_invalid_rate_value");
    if (values.effective_from === undefined || values.effective_to === undefined)
      return req.res.locals.t("error_invalid_date");
    if (values.effective_from && values.effective_to && values.effective_to < values.effective_from)
      return { field: "effective_to", message: req.res.locals.t("error_invalid_date_range") };

    const duplicateQ = knex("erp.labour_allowance_rules")
      .where({ labour_id: values.labour_id })
      .whereRaw("lower(allowance_type)=lower(?)", [values.allowance_type]);
    if (isUpdate && id) duplicateQ.andWhereNot({ id });
    const duplicate = await duplicateQ.first();
    if (duplicate) return req.res.locals.t("error_duplicate_labour_allowance_rule");

    const allowedBranchIds = getAllowedBranchIds(req);
    if (allowedBranchIds.length) {
      const inScope = await knex("erp.labour_branch as lb")
        .select("lb.labour_id")
        .where("lb.labour_id", Number(values.labour_id || 0))
        .whereIn("lb.branch_id", allowedBranchIds)
        .first();
      if (!inScope) return req.res.locals.t("error_branch_out_of_scope");
    }

    values.amount = toMoney(values.amount);
    return null;
  },
};

const router = express.Router();
router.use("/", createHrMasterRouter(page));

router.preview = {
  page,
  hydratePage,
};

module.exports = router;
