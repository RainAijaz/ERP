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

const page = {
  titleKey: "allowances",
  descriptionKey: "allowances_description",
  table: "erp.employee_allowance_rules",
  scopeKey: "hr_payroll.allowances",
  entityType: "EMPLOYEE",
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
    mapTable: "erp.employee_branch",
    mapKey: "employee_id",
    entityKey: "employee_id",
    branchKey: "branch_id",
  },
  joins: [{ table: { e: "erp.employees" }, on: ["t.employee_id", "e.id"] }],
  extraSelect: (locale) => [
    locale === "ur" ? knex.raw("COALESCE(e.name_ur, e.name) as employee_name") : "e.name as employee_name",
    knex.raw("CASE WHEN lower(trim(t.status)) = 'active' THEN true ELSE false END as is_active"),
  ],
  columns: [
    { key: "id", label: "id" },
    { key: "employee_name", label: "employees" },
    { key: "allowance_type", label: "allowance_type" },
    { key: "amount_type", label: "amount_type" },
    { key: "amount", label: "amount" },
    { key: "frequency", label: "frequency" },
    { key: "taxable", label: "taxable" },
    { key: "status", label: "status" },
  ],
  fields: [
    {
      name: "employee_id",
      label: "employees",
      type: "select",
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
    { name: "allowance_type", label: "allowance_type", required: true, placeholder: "placeholder_allowance_type" },
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
  }),
  validateValues: async ({ values, req, isUpdate, id }) => {
    const amountTypes = new Set(["FIXED", "PERCENT_BASIC"]);
    const frequencies = new Set(["MONTHLY", "DAILY"]);
    if (!amountTypes.has(values.amount_type)) return req.res.locals.t("error_invalid_amount_type");
    if (!frequencies.has(values.frequency)) return req.res.locals.t("error_invalid_frequency");
    if (values.status !== "active" && values.status !== "inactive") return req.res.locals.t("error_invalid_status");
    if (!values.allowance_type) return req.res.locals.t("error_required_fields");
    if (values.amount == null || Number(values.amount) < 0 || !hasTwoDecimalsOrLess(values.amount)) return req.res.locals.t("error_invalid_rate_value");
    if (Number(values.amount) > 99999999.99) return req.res.locals.t("error_invalid_rate_value");

    const duplicateQ = knex("erp.employee_allowance_rules")
      .where({
        employee_id: values.employee_id,
      })
      .whereRaw("lower(allowance_type)=lower(?)", [values.allowance_type]);
    if (isUpdate && id) duplicateQ.andWhereNot({ id });
    const duplicate = await duplicateQ.first();
    if (duplicate) return req.res.locals.t("error_duplicate_allowance_rule");
    const allowedBranchIds = getAllowedBranchIds(req);
    if (allowedBranchIds.length) {
      const inScope = await knex("erp.employee_branch as eb")
        .select("eb.employee_id")
        .where("eb.employee_id", Number(values.employee_id || 0))
        .whereIn("eb.branch_id", allowedBranchIds)
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
