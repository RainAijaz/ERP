const express = require("express");
const knex = require("../../db/knex");
const { createHrMasterRouter } = require("./master-router");
const { normalizePhone, normalizeCnic, isValidPhone, isValidCnic, toMoney, hasTwoDecimalsOrLess } = require("./validation");
const commissionsRoutes = require("./commissions");
const allowancesRoutes = require("./allowances");

const page = {
  titleKey: "employees",
  descriptionKey: "employees_description",
  table: "erp.employees",
  scopeKey: "hr_payroll.employees",
  entityType: "EMPLOYEE",
  branchScoped: true,
  autoCodeFromName: true,
  codePrefix: "emp",
  defaults: {
    payroll_type: "MONTHLY",
    status: "active",
  },
  filterConfig: {
    primary: {
      key: "payroll_type",
      label: "payroll_type",
      dbColumn: "t.payroll_type",
      options: [
        { value: "MONTHLY", label: "payroll_monthly" },
        { value: "DAILY", label: "payroll_daily" },
        { value: "PIECE_RATE", label: "payroll_piece_rate" },
        { value: "MULTIPLE", label: "payroll_multiple" },
      ],
    },
    secondary: {
      key: "department_id",
      label: "departments",
      dbColumn: "t.department_id",
      fieldName: "department_id",
    },
  },
  branchMap: {
    table: "erp.employee_branch",
    key: "employee_id",
    branchKey: "branch_id",
  },
  joins: [{ table: { d: "erp.departments" }, on: ["t.department_id", "d.id"] }],
  extraSelect: (locale) => [
    locale === "ur" ? knex.raw("COALESCE(d.name_ur, d.name) as department_name") : "d.name as department_name",
    knex.raw(
      `(SELECT COALESCE(string_agg(b.name, ', ' ORDER BY b.name), '')
        FROM erp.employee_branch eb
        JOIN erp.branches b ON b.id = eb.branch_id
        WHERE eb.employee_id = t.id) as branch_names`,
    ),
    knex.raw(
      `(SELECT COALESCE(string_agg(eb.branch_id::text, ',' ORDER BY eb.branch_id), '')
        FROM erp.employee_branch eb
        WHERE eb.employee_id = t.id) as branch_ids`,
    ),
    knex.raw("CASE WHEN lower(trim(t.status)) = 'active' THEN true ELSE false END as is_active"),
  ],
  columns: [
    { key: "id", label: "id" },
    { key: "name", label: "name" },
    { key: "name_ur", label: "name_ur" },
    { key: "cnic", label: "cnic" },
    { key: "phone", label: "phone_number" },
    { key: "department_name", label: "departments" },
    { key: "payroll_type", label: "payroll_type" },
    { key: "basic_salary", label: "basic_salary" },
    { key: "branch_names", label: "branches" },
    { key: "status", label: "status" },
  ],
  fields: [
    { name: "name", label: "name", placeholder: "placeholder_employee_name", required: true },
    { name: "name_ur", label: "name_ur", placeholder: "name_ur" },
    { name: "cnic", label: "cnic", placeholder: "placeholder_employee_cnic", required: true },
    { name: "phone", label: "phone_number", placeholder: "placeholder_phone_number", required: true },
    {
      name: "department_id",
      label: "departments",
      type: "select",
      required: true,
      optionsQuery: {
        table: "erp.departments",
        valueKey: "id",
        labelKey: "name",
        orderBy: "name",
      },
    },
    { name: "designation", label: "designation_role", placeholder: "placeholder_designation_role", required: true },
    {
      name: "payroll_type",
      label: "payroll_type",
      type: "select",
      required: true,
      options: [
        { value: "MONTHLY", label: "payroll_monthly" },
        { value: "DAILY", label: "payroll_daily" },
        { value: "PIECE_RATE", label: "payroll_piece_rate" },
        { value: "MULTIPLE", label: "payroll_multiple" },
      ],
    },
    {
      name: "basic_salary",
      label: "basic_salary",
      type: "number",
      min: 0,
      step: "0.01",
      required: true,
    },
    {
      name: "branch_ids",
      label: "branches",
      type: "multi-select",
      required: true,
      optionsQuery: {
        table: "erp.branches",
        valueKey: "id",
        labelKey: "name",
        orderBy: "name",
      },
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
  ],
  sanitizeValues: (values) => ({
    ...values,
    name_ur: String(values.name_ur || "").trim(),
    cnic: normalizeCnic(values.cnic),
    phone: normalizePhone(values.phone),
    basic_salary: values.basic_salary == null ? null : String(values.basic_salary).trim(),
  }),
  validateValues: async ({ values, req, isUpdate, id }) => {
    const payrollTypes = new Set(["MONTHLY", "DAILY", "PIECE_RATE", "MULTIPLE"]);
    if (!payrollTypes.has(values.payroll_type)) return req.res.locals.t("error_invalid_payroll_type");
    if (values.basic_salary === null || Number(values.basic_salary) < 0) return req.res.locals.t("error_invalid_salary");
    if (!hasTwoDecimalsOrLess(values.basic_salary) || Number(values.basic_salary) > 99999999.99) return req.res.locals.t("error_invalid_salary_precision");
    if (!values.cnic) return { field: "cnic", message: req.res.locals.t("error_required_fields") };
    if (!values.phone) return { field: "phone", message: req.res.locals.t("error_required_fields") };
    if (!values.designation) return { field: "designation", message: req.res.locals.t("error_required_fields") };
    if (!values.department_id) return { field: "department_id", message: req.res.locals.t("error_select_department") };
    if (values.status !== "active" && values.status !== "inactive") return req.res.locals.t("error_invalid_status");
    if (values.cnic && !isValidCnic(values.cnic)) return { field: "cnic", message: req.res.locals.t("error_invalid_cnic") };
    if (values.phone && !isValidPhone(values.phone)) return { field: "phone", message: req.res.locals.t("error_invalid_phone_number") };
    if (values.cnic) {
      const q = knex("erp.employees").whereRaw("regexp_replace(coalesce(cnic, ''), '[^0-9]', '', 'g') = ?", [values.cnic]);
      if (isUpdate && id) q.andWhereNot({ id });
      const dup = await q.first();
      if (dup) return { field: "cnic", message: req.res.locals.t("error_duplicate_cnic") };
    }
    if (values.phone) {
      const q = knex("erp.employees").whereRaw("regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = ?", [values.phone]);
      if (isUpdate && id) q.andWhereNot({ id });
      const dup = await q.first();
      if (dup) return { field: "phone", message: req.res.locals.t("error_duplicate_phone_number") };
    }
    if (!req.user?.isAdmin) {
      const allowed = new Set((req.branchScope || []).map((id) => String(id)));
      const selected = Array.isArray(values.branch_ids) ? values.branch_ids.map(String) : [];
      const invalid = selected.some((id) => !allowed.has(id));
      if (invalid) return { field: "branch_ids", message: req.res.locals.t("error_branch_out_of_scope") };
    }
    values.basic_salary = toMoney(values.basic_salary);
    return null;
  },
  hasDependencies: async ({ id, knex }) => {
    const checks = await Promise.all([
      knex("erp.voucher_line").where({ employee_id: id }).first(),
      knex("erp.sales_header").where({ salesman_employee_id: id }).first(),
      knex("erp.sales_order_header").where({ salesman_employee_id: id }).first(),
    ]);
    return checks.some(Boolean);
  },
};

const router = express.Router();
router.use("/", createHrMasterRouter(page));
router.use("/commissions", commissionsRoutes);
router.use("/allowances", allowancesRoutes);

module.exports = router;
