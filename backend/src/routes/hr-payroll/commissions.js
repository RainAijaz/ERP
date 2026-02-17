const express = require("express");
const knex = require("../../db/knex");
const { createHrMasterRouter } = require("./master-router");
const { toMoney, hasTwoDecimalsOrLess } = require("./validation");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { handleScreenApproval } = require("../../middleware/approvals/screen-approval");
const { queueAuditLog } = require("../../utils/audit-log");
const { setCookie } = require("../../middleware/utils/cookies");
const {
  ALLOWED_SCOPE_FOR_BULK,
  deriveValueTypeFromBasis,
  normalizeBulkInput,
  buildBulkPreviewRows,
  applyBulkSkuRateUpsert,
} = require("../../services/hr-payroll/commission-rules-service");

const page = {
  titleKey: "sales_commission",
  descriptionKey: "sales_commission_description",
  table: "erp.employee_commission_rules",
  scopeKey: "hr_payroll.commissions",
  entityType: "EMPLOYEE",
  branchScoped: false,
  autoCodeFromName: false,
  defaults: {
    reverse_on_returns: true,
    status: "active",
  },
  filterConfig: {
    primary: {
      key: "employee_id",
      label: "employees",
      dbColumn: "t.employee_id",
      fieldName: "employee_id",
    },
    secondary: {
      key: "commission_basis",
      label: "commission_basis",
      dbColumn: "t.commission_basis",
      options: [
        { value: "NET_SALES_PERCENT", label: "commission_basis_net_sales_percent" },
        { value: "GROSS_MARGIN_PERCENT", label: "commission_basis_gross_margin_percent" },
        { value: "FIXED_PER_UNIT", label: "commission_basis_fixed_per_unit" },
        { value: "FIXED_PER_INVOICE", label: "commission_basis_fixed_per_invoice" },
      ],
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
  hideBranchFilter: true,
  joins: [
    { table: { e: "erp.employees" }, on: ["t.employee_id", "e.id"] },
    { table: { s: "erp.skus" }, on: ["t.sku_id", "s.id"] },
    { table: { sg: "erp.product_subgroups" }, on: ["t.subgroup_id", "sg.id"] },
    { table: { pg: "erp.product_groups" }, on: ["t.group_id", "pg.id"] },
  ],
  extraSelect: (locale) => [
    locale === "ur" ? knex.raw("COALESCE(e.name_ur, e.name) as employee_name") : "e.name as employee_name",
    locale === "ur" ? knex.raw("COALESCE(sg.name_ur, sg.name) as subgroup_name") : "sg.name as subgroup_name",
    locale === "ur" ? knex.raw("COALESCE(pg.name_ur, pg.name) as group_name") : "pg.name as group_name",
    "s.sku_code as sku_code",
    knex.raw(
      `CASE
        WHEN t.apply_on='SKU' THEN COALESCE(s.sku_code, '')
        WHEN t.apply_on='SUBGROUP' THEN COALESCE(sg.name, '')
        WHEN t.apply_on='GROUP' THEN COALESCE(pg.name, '')
        ELSE 'ALL'
      END as selector_display`,
    ),
    knex.raw("CASE WHEN lower(trim(t.status)) = 'active' THEN true ELSE false END as is_active"),
  ],
  columns: [
    { key: "id", label: "id" },
    { key: "employee_name", label: "employees" },
    { key: "sku_code", label: "skus" },
    { key: "commission_basis", label: "commission_basis" },
    { key: "value", label: "dozen_rate" },
    { key: "reverse_on_returns", label: "reverse_on_returns" },
  ],
  fields: [
    {
      name: "employee_id",
      label: "employees",
      type: "select",
      required: true,
      optionsQuery: {
        table: "erp.employees",
        valueKey: "id",
        labelKey: "name",
        orderBy: "name",
        where: { status: "active" },
      },
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
      label: "article",
      type: "select",
      showWhen: { field: "apply_on", values: ["SKU"] },
      optionsQuery: {
        table: "erp.skus as s",
        valueKey: "id",
        labelKey: "sku_code",
        select: ["s.id as id", "s.sku_code", "i.name as item_name"],
        joins: [{ table: { v: "erp.variants" }, on: ["s.variant_id", "v.id"] }, { table: { i: "erp.items" }, on: ["v.item_id", "i.id"] }],
        whereRaw: "i.item_type = 'FG'",
        orderBy: "s.sku_code",
      },
      labelFormat: (row) => `${row.sku_code}${row.item_name ? ` - ${row.item_name}` : ""}`,
    },
    {
      name: "subgroup_id",
      label: "product_subgroups",
      type: "select",
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
      name: "commission_basis",
      label: "commission_basis",
      type: "select",
      required: true,
      options: [
        { value: "NET_SALES_PERCENT", label: "commission_basis_net_sales_percent" },
        { value: "GROSS_MARGIN_PERCENT", label: "commission_basis_gross_margin_percent" },
        { value: "FIXED_PER_UNIT", label: "commission_basis_fixed_per_unit" },
        { value: "FIXED_PER_INVOICE", label: "commission_basis_fixed_per_invoice" },
      ],
    },
    { name: "value", label: "dozen_rate", type: "number", min: 0, step: "0.01", required: true },
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
    { name: "reverse_on_returns", label: "reverse_on_returns", type: "checkbox" },
  ],
  sanitizeValues: (values) => ({
    ...values,
    value: values.value == null ? null : String(values.value).trim(),
    value_type: deriveValueTypeFromBasis(values.commission_basis),
    reverse_on_returns: values.reverse_on_returns !== false,
  }),
  validateValues: async ({ values, req, isUpdate, id }) => {
    const applyOn = new Set(["SKU", "SUBGROUP", "GROUP"]);
    const bases = new Set(["NET_SALES_PERCENT", "GROSS_MARGIN_PERCENT", "FIXED_PER_UNIT", "FIXED_PER_INVOICE"]);
    if (!applyOn.has(values.apply_on)) return req.res.locals.t("error_invalid_apply_on");
    if (!isUpdate && ALLOWED_SCOPE_FOR_BULK.has(values.apply_on)) {
      return req.res.locals.t("error_group_subgroup_only_for_bulk_commission");
    }
    if (!bases.has(values.commission_basis)) return req.res.locals.t("error_invalid_commission_basis");
    const derivedValueType = deriveValueTypeFromBasis(values.commission_basis);
    if (!derivedValueType) return req.res.locals.t("error_invalid_value_type");
    values.value_type = derivedValueType;
    if (values.status !== "active" && values.status !== "inactive") return req.res.locals.t("error_invalid_status");
    if (values.value == null || Number(values.value) < 0 || !hasTwoDecimalsOrLess(values.value)) return req.res.locals.t("error_invalid_rate_value");
    if (Number(values.value) > 99999999.99) return req.res.locals.t("error_invalid_rate_value");

    if (values.apply_on === "SKU" && !values.sku_id) return req.res.locals.t("error_select_sku");
    if (values.apply_on === "SUBGROUP" && !values.subgroup_id) return req.res.locals.t("error_select_subgroup");
    if (values.apply_on === "GROUP" && !values.group_id) return req.res.locals.t("error_select_group");
    if (values.apply_on !== "SKU") values.sku_id = null;
    if (values.apply_on !== "SUBGROUP") values.subgroup_id = null;
    if (values.apply_on !== "GROUP") values.group_id = null;

    const duplicateQ = knex("erp.employee_commission_rules")
      .where({
        employee_id: values.employee_id,
        apply_on: values.apply_on,
        commission_basis: values.commission_basis,
        value_type: values.value_type,
        status: values.status,
      })
      .whereRaw("COALESCE(sku_id,0)=COALESCE(?,0)", [values.sku_id || 0])
      .whereRaw("COALESCE(subgroup_id,0)=COALESCE(?,0)", [values.subgroup_id || 0])
      .whereRaw("COALESCE(group_id,0)=COALESCE(?,0)", [values.group_id || 0]);
    if (isUpdate && id) duplicateQ.andWhereNot({ id });
    const duplicate = await duplicateQ.first();
    if (duplicate) return req.res.locals.t("error_duplicate_commission_rule");

    values.value = toMoney(values.value);
    return null;
  },
};

const router = express.Router();
const flashCookie = `hr_${page.scopeKey.replace(/\./g, "_")}_flash`;
const BULK_PREVIEW_PATH = "/hr-payroll/employees/commissions/bulk-preview";

const logBulkPreviewDiagnostic = (level, message, payload = {}) => {
  const logger = level === "error" ? console.error : console.warn;
  logger(`[commissions:bulk-preview] ${message}`, payload);
};

const buildValues = (body = {}) =>
  page.fields.reduce((acc, field) => {
    if (field.type === "checkbox") {
      acc[field.name] = body[field.name] === "on";
      return acc;
    }
    if (field.type === "select") {
      const value = (body[field.name] || "").trim();
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
  if (typeof validationError === "string") return { message: validationError, fieldErrors: {} };
  if (typeof validationError === "object") {
    const message = validationError.message || "";
    const field = validationError.field || null;
    const fieldErrors = validationError.fieldErrors && typeof validationError.fieldErrors === "object" ? validationError.fieldErrors : {};
    if (field && message) fieldErrors[field] = message;
    return { message, fieldErrors };
  }
  return { message: String(validationError), fieldErrors: {} };
};

const renderIndexError = (req, res, values, error, modalMode, fieldErrors = {}) => {
  const payload = { values, error, modalMode, fieldErrors };
  setCookie(res, flashCookie, JSON.stringify(payload), {
    path: req.baseUrl,
    maxAge: 60,
    sameSite: "Lax",
  });
  return res.redirect(req.baseUrl);
};

router.post("/", requirePermission("SCREEN", page.scopeKey, "navigate"), async (req, res, next) => {
  const values = buildValues(req.body);
  const sanitizedValues = page.sanitizeValues ? page.sanitizeValues(values, req) : values;

  try {
    const missing = page.fields
      .filter((field) => field.required)
      .filter((field) => {
        const value = sanitizedValues[field.name];
        return value === null || value === undefined || value === "";
      });
    if (missing.length) {
      const missingMap = missing.reduce((acc, field) => {
        acc[field.name] = res.locals.t("error_required_fields");
        return acc;
      }, {});
      return renderIndexError(req, res, sanitizedValues, res.locals.t("error_required_fields"), "create", missingMap);
    }

    if (String(sanitizedValues.apply_on || "").toUpperCase() !== "SKU") {
      return next();
    }

    const existingRows = await knex(page.table)
      .select("id")
      .where({
        employee_id: sanitizedValues.employee_id,
        apply_on: "SKU",
        sku_id: sanitizedValues.sku_id,
      })
      .orderBy("id", "desc");
    const existing = existingRows[0] || null;
    const duplicateIdsToDelete = existingRows.slice(1).map((row) => Number(row.id));

    if (page.validateValues) {
      const validationError = await page.validateValues({
        values: sanitizedValues,
        req,
        isUpdate: Boolean(existing),
        id: existing?.id || null,
        knex,
      });
      if (validationError) {
        const normalized = normalizeValidationError(validationError);
        return renderIndexError(req, res, sanitizedValues, normalized.message || validationError, "create", normalized.fieldErrors);
      }
    }

    const approval = await handleScreenApproval({
      req,
      scopeKey: page.scopeKey,
      action: existing ? "edit" : "create",
      entityType: page.entityType,
      entityId: existing?.id || "NEW",
      summary: `${res.locals.t(existing ? "edit" : "add")} ${res.locals.t(page.titleKey)}`,
      oldValue: existing || null,
      newValue: sanitizedValues,
      t: res.locals.t,
    });
    if (approval.queued) {
      return res.redirect(req.get("referer") || req.baseUrl);
    }

    if (duplicateIdsToDelete.length) {
      await knex(page.table)
        .whereIn("id", duplicateIdsToDelete)
        .del();
    }

    if (existing?.id) {
      await knex(page.table).where({ id: existing.id }).update(sanitizedValues);
      queueAuditLog(req, {
        entityType: page.entityType,
        entityId: existing.id,
        action: "UPDATE",
        context: { source: "commission-create-upsert", mode: "SKU_UPSERT" },
      });
    } else {
      const [created] = await knex(page.table).insert(sanitizedValues).returning("id");
      const createdId = created && created.id ? created.id : created;
      queueAuditLog(req, {
        entityType: page.entityType,
        entityId: createdId,
        action: "CREATE",
        context: { source: "commission-create-upsert", mode: "SKU_UPSERT" },
      });
    }

    return res.redirect(req.baseUrl);
  } catch (err) {
    console.error("Error in CommissionRulesService:", err);
    return renderIndexError(req, res, sanitizedValues, err?.message || res.locals.t("generic_error"), "create");
  }
});

router.get("/bulk-preview", requirePermission("SCREEN", page.scopeKey, "view"), async (req, res) => {
  const diagnostics = {
    request_id: req.id || null,
    user_id: req.user?.id || null,
    username: req.user?.username || null,
    method: req.method,
    path: req.originalUrl || BULK_PREVIEW_PATH,
    query: {
      apply_on: req.query.apply_on || null,
      employee_id: req.query.employee_id || null,
      commission_basis: req.query.commission_basis || null,
      subgroup_id: req.query.subgroup_id || null,
      group_id: req.query.group_id || null,
      value: req.query.value || null,
    },
  };

  try {
    const applyOn = String(req.query.apply_on || "").trim().toUpperCase();
    const employeeId = Number(req.query.employee_id || 0) || null;
    const commissionBasis = String(req.query.commission_basis || "").trim().toUpperCase();
    const subgroupId = Number(req.query.subgroup_id || 0) || null;
    const groupId = Number(req.query.group_id || 0) || null;
    const baseRate = req.query.value;

    if (!ALLOWED_SCOPE_FOR_BULK.has(applyOn)) {
      logBulkPreviewDiagnostic("warn", "Validation failed: invalid apply_on", {
        ...diagnostics,
        normalized_apply_on: applyOn,
      });
      return res.status(400).json({ message: res.locals.t("error_group_subgroup_only_for_bulk_commission") });
    }
    if (applyOn === "SUBGROUP" && !subgroupId) {
      logBulkPreviewDiagnostic("warn", "Validation failed: subgroup_id missing for SUBGROUP mode", {
        ...diagnostics,
        normalized_apply_on: applyOn,
      });
      return res.status(400).json({ message: res.locals.t("error_select_subgroup") });
    }
    if (applyOn === "GROUP" && !groupId) {
      logBulkPreviewDiagnostic("warn", "Validation failed: group_id missing for GROUP mode", {
        ...diagnostics,
        normalized_apply_on: applyOn,
      });
      return res.status(400).json({ message: res.locals.t("error_select_group") });
    }

    const rows = await buildBulkPreviewRows({
      employeeId,
      applyOn,
      subgroupId,
      groupId,
      commissionBasis,
      baseRate,
    });

    return res.json({ rows });
  } catch (err) {
    logBulkPreviewDiagnostic("error", "Unhandled exception while building preview rows", {
      ...diagnostics,
      error_message: err?.message || String(err),
      error_code: err?.code || null,
      error_stack: err?.stack || null,
    });
    return res.status(500).json({ message: res.locals.t("generic_error") });
  }
});

router.post("/bulk-upsert", requirePermission("SCREEN", page.scopeKey, "navigate"), async (req, res) => {
  try {
    const normalized = normalizeBulkInput({ payload: req.body || {}, t: res.locals.t });

    const expectedRows = await buildBulkPreviewRows({
      employeeId: normalized.employeeId,
      applyOn: normalized.applyOn,
      subgroupId: normalized.subgroupId,
      groupId: normalized.groupId,
      commissionBasis: normalized.commissionBasis,
      baseRate: null,
    });
    const allowedSkuIds = new Set(expectedRows.map((row) => Number(row.sku_id)));
    const invalidSku = normalized.rows.find((row) => !allowedSkuIds.has(Number(row.skuId)));
    if (invalidSku || normalized.rows.length !== expectedRows.length) {
      return res.status(400).json({ message: res.locals.t("error_invalid_bulk_commission_payload") });
    }

    const approval = await handleScreenApproval({
      req,
      scopeKey: page.scopeKey,
      action: "create",
      entityType: page.entityType,
      entityId: normalized.employeeId,
      summary: `${res.locals.t("add")} ${res.locals.t(page.titleKey)}`,
      oldValue: null,
      newValue: {
        mode: "BULK_COMMISSION_SKU_UPSERT",
        apply_on: normalized.applyOn,
        employee_id: normalized.employeeId,
        commission_basis: normalized.commissionBasis,
        reverse_on_returns: normalized.reverseOnReturns,
        status: normalized.status,
        rows: normalized.rows,
      },
      t: res.locals.t,
    });

    if (approval.queued) {
      const canViewApprovals = typeof res.locals.can === "function"
        ? res.locals.can("SCREEN", "administration.approvals", "navigate")
        : false;
      return res.status(202).json({
        queued: true,
        approval_request_id: approval.requestId || null,
        approvals_url: canViewApprovals ? "/administration/approvals" : null,
        message: res.locals.t("approval_sent") || res.locals.t("approval_submitted") || "Change submitted for Administrator approval.",
      });
    }

    const result = await knex.transaction(async (trx) => {
      return applyBulkSkuRateUpsert({
        trx,
        employeeId: normalized.employeeId,
        commissionBasis: normalized.commissionBasis,
        valueType: normalized.valueType,
        reverseOnReturns: normalized.reverseOnReturns,
        status: normalized.status,
        rows: normalized.rows,
      });
    });

    queueAuditLog(req, {
      entityType: page.entityType,
      entityId: normalized.employeeId,
      action: "UPDATE",
      context: {
        source: "commission-bulk-upsert",
        apply_on: normalized.applyOn,
        commission_basis: normalized.commissionBasis,
        created: result.created,
        updated: result.updated,
        row_count: normalized.rows.length,
      },
    });

    return res.json({
      ok: true,
      created: result.created,
      updated: result.updated,
      message: res.locals.t("success_bulk_commission_saved") || res.locals.t("saved") || "Saved",
    });
  } catch (err) {
    console.error("Error in CommissionRulesService:", err);
    return res.status(400).json({ message: err?.message || res.locals.t("generic_error") });
  }
});

router.use("/", createHrMasterRouter(page));

module.exports = router;
