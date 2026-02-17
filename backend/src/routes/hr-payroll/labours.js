const express = require("express");
const knex = require("../../db/knex");
const { createHrMasterRouter } = require("./master-router");
const { normalizePhone, normalizeCnic, isValidPhone, isValidCnic, toMoney, hasTwoDecimalsOrLess } = require("./validation");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { handleScreenApproval } = require("../../middleware/approvals/screen-approval");
const { queueAuditLog } = require("../../utils/audit-log");
const {
  ALL_LABOURS_VALUE,
  ARTICLE_TYPE,
  normalizeScopeInput,
  normalizeBulkInput,
  resolveLabourIds,
  buildBulkPreviewRows,
  applyBulkSkuRateUpsert,
} = require("../../services/hr-payroll/labour-rates-service");

const page = {
  titleKey: "labours",
  descriptionKey: "labours_description",
  table: "erp.labours",
  scopeKey: "hr_payroll.labours",
  entityType: "LABOUR",
  branchScoped: true,
  autoCodeFromName: true,
  codePrefix: "lab",
  defaults: {
    production_category: "finished",
    status: "active",
  },
  filterConfig: {
    primary: {
      key: "production_category",
      label: "production_category",
      dbColumn: "t.production_category",
      options: [
        { value: "finished", label: "production_category_finished" },
        { value: "semi_finished", label: "production_category_semi_finished" },
      ],
    },
    secondary: {
      key: "dept_id",
      label: "departments",
      dbColumn: "t.dept_id",
      fieldName: "dept_id",
    },
  },
  branchMap: {
    table: "erp.labour_branch",
    key: "labour_id",
    branchKey: "branch_id",
  },
  multiMaps: [{ table: "erp.labour_department", key: "labour_id", valueKey: "dept_id", fieldName: "dept_ids" }],
  joins: [],
  extraSelect: (locale) => [
    knex.raw(
      `(SELECT COALESCE(string_agg(x.dept_name, ', ' ORDER BY x.dept_name), '')
        FROM (
          SELECT DISTINCT ${locale === "ur" ? "COALESCE(d.name_ur, d.name)" : "d.name"} AS dept_name
          FROM erp.labour_department ld
          JOIN erp.departments d ON d.id = ld.dept_id
          WHERE ld.labour_id = t.id
            AND d.is_active = true
            AND d.is_production = true
          UNION
          SELECT DISTINCT ${locale === "ur" ? "COALESCE(d2.name_ur, d2.name)" : "d2.name"} AS dept_name
          FROM erp.departments d2
          WHERE d2.id = t.dept_id
            AND t.dept_id IS NOT NULL
            AND d2.is_active = true
            AND d2.is_production = true
        ) x) as department_name`,
    ),
    knex.raw(
      `(SELECT COALESCE(string_agg(b.name, ', ' ORDER BY b.name), '')
        FROM erp.labour_branch lb
        JOIN erp.branches b ON b.id = lb.branch_id
        WHERE lb.labour_id = t.id) as branch_names`,
    ),
    knex.raw(
      `(SELECT COALESCE(string_agg(lb.branch_id::text, ',' ORDER BY lb.branch_id), '')
        FROM erp.labour_branch lb
        WHERE lb.labour_id = t.id) as branch_ids`,
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
    { key: "production_category", label: "production_category" },
    { key: "branch_names", label: "branches" },
    { key: "status", label: "status" },
  ],
  fields: [
    { name: "name", label: "name", placeholder: "placeholder_labour_name", required: true },
    { name: "name_ur", label: "name_ur", placeholder: "name_ur" },
    { name: "cnic", label: "cnic", placeholder: "placeholder_employee_cnic", required: true },
    { name: "phone", label: "phone_number", placeholder: "placeholder_phone_number", required: true },
    {
      name: "production_category",
      label: "production_category",
      type: "select",
      required: true,
      options: [
        { value: "finished", label: "production_category_finished" },
        { value: "semi_finished", label: "production_category_semi_finished" },
      ],
    },
    {
      name: "dept_ids",
      label: "departments",
      type: "multi-select",
      required: true,
      optionsQuery: {
        table: "erp.departments",
        valueKey: "id",
        labelKey: "name",
        orderBy: "name",
        where: { is_production: true, is_active: true },
      },
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
    dept_ids: Array.isArray(values.dept_ids) ? [...new Set(values.dept_ids.map((id) => String(id).trim()).filter(Boolean))] : [],
    dept_id: Array.isArray(values.dept_ids) && values.dept_ids.length ? String(values.dept_ids[0]).trim() : null,
  }),
  validateValues: async ({ values, req, isUpdate, id }) => {
    const categories = new Set(["finished", "semi_finished"]);
    if (!categories.has(values.production_category)) return req.res.locals.t("error_invalid_production_category");
    if (!Array.isArray(values.dept_ids) || !values.dept_ids.length) return { field: "dept_ids", message: req.res.locals.t("error_select_department") };
    if (!values.cnic) return { field: "cnic", message: req.res.locals.t("error_required_fields") };
    if (!values.phone) return { field: "phone", message: req.res.locals.t("error_required_fields") };
    if (values.status !== "active" && values.status !== "inactive") return req.res.locals.t("error_invalid_status");
    if (values.cnic && !isValidCnic(values.cnic)) return { field: "cnic", message: req.res.locals.t("error_invalid_cnic") };
    if (values.phone && !isValidPhone(values.phone)) return { field: "phone", message: req.res.locals.t("error_invalid_phone_number") };
    values.dept_id = Number(values.dept_ids[0] || 0) || null;
    return null;
  },
};

const labourRatesPage = {
  titleKey: "labour_rates",
  descriptionKey: "labour_rates_description",
  table: "erp.labour_rate_rules",
  scopeKey: "hr_payroll.labour_rates",
  entityType: "LABOUR",
  branchScoped: false,
  autoCodeFromName: false,
  defaults: {},
  filterConfig: {
    primary: {
      key: "labour_id",
      label: "labours",
      valueType: "number",
      dbColumn: "t.labour_id",
      optionsResolver: async ({ knex, locale }) => {
        const labelExpr = locale === "ur" ? "COALESCE(l.name_ur, l.name)" : "l.name";
        const rows = await knex("erp.labours as l")
          .select("l.id as value", knex.raw(`${labelExpr} as label`))
          .whereRaw("lower(trim(l.status)) = 'active'")
          .orderByRaw(`${labelExpr} asc`);
        return rows.map((row) => ({ value: row.value, label: row.label }));
      },
    },
    secondary: {
      key: "dept_id",
      label: "departments",
      valueType: "number",
      dbColumn: "t.dept_id",
      fieldName: "dept_id",
    },
    tertiary: {
      key: "rate_type",
      label: "rate_type",
      dbColumn: "t.rate_type",
      options: [
        { value: "PER_DOZEN", label: "rate_type_per_dozen" },
        { value: "PER_PAIR", label: "rate_type_per_pair" },
      ],
    },
  },
  applyExtraFilters: (query, { filters = {} } = {}) => {
    const applyOnValues = Array.isArray(filters.applyOnValues)
      ? filters.applyOnValues.map((value) => String(value || "").trim().toUpperCase()).filter((value) => value === "SKU" || value === "SUBGROUP" || value === "GROUP")
      : [];
    const subgroupIds = Array.isArray(filters.subgroupValues)
      ? filters.subgroupValues.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
      : [];
    const groupIds = Array.isArray(filters.groupValues)
      ? filters.groupValues.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
      : [];
    const articleTypes = Array.isArray(filters.articleTypeValues)
      ? filters.articleTypeValues.map((value) => String(value || "").trim().toUpperCase()).filter((value) => value === "FG" || value === "SFG")
      : [];
    const applyOnMode = String(filters.applyOnMode || "include").toLowerCase() === "exclude" ? "exclude" : "include";
    const subgroupMode = String(filters.subgroupMode || "include").toLowerCase() === "exclude" ? "exclude" : "include";
    const groupMode = String(filters.groupMode || "include").toLowerCase() === "exclude" ? "exclude" : "include";
    const articleTypeMode = String(filters.articleTypeMode || "include").toLowerCase() === "exclude" ? "exclude" : "include";

    if (applyOnValues.length) {
      query = applyOnMode === "exclude" ? query.whereNotIn("t.apply_on", applyOnValues) : query.whereIn("t.apply_on", applyOnValues);
    }
    if (subgroupIds.length) {
      query = subgroupMode === "exclude" ? query.whereNotIn("t.subgroup_id", subgroupIds) : query.whereIn("t.subgroup_id", subgroupIds);
    }
    if (groupIds.length) {
      query = groupMode === "exclude" ? query.whereNotIn("t.group_id", groupIds) : query.whereIn("t.group_id", groupIds);
    }
    if (articleTypes.length) {
      query = articleTypeMode === "exclude" ? query.whereNotIn("i.item_type", articleTypes) : query.whereIn("i.item_type", articleTypes);
    }

    return query;
  },
  hideBranchFilter: true,
  joins: [
    { table: { l: "erp.labours" }, on: ["t.labour_id", "l.id"] },
    { table: { d: "erp.departments" }, on: ["t.dept_id", "d.id"] },
    { table: { s: "erp.skus" }, on: ["t.sku_id", "s.id"] },
    { table: { v: "erp.variants" }, on: ["s.variant_id", "v.id"] },
    { table: { i: "erp.items" }, on: ["v.item_id", "i.id"] },
  ],
  extraSelect: (locale) => [
    locale === "ur" ? knex.raw("COALESCE(l.name_ur, l.name) as labour_name") : "l.name as labour_name",
    locale === "ur" ? knex.raw("COALESCE(d.name_ur, d.name) as department_name") : "d.name as department_name",
    "s.sku_code as sku_code",
    knex.raw("COALESCE(i.item_type::text, '') as article_type"),
    knex.raw("CASE WHEN lower(trim(t.status)) = 'active' THEN true ELSE false END as is_active"),
  ],
  columns: [
    { key: "id", label: "id" },
    { key: "labour_name", label: "labours" },
    { key: "department_name", label: "departments" },
    { key: "sku_code", label: "skus" },
    { key: "article_type", label: "article_type" },
    { key: "rate_type", label: "rate_type" },
    { key: "rate_value", label: "rate" },
  ],
  fields: [
    {
      name: "labour_id",
      label: "labours",
      type: "select",
      required: true,
      optionsResolver: async ({ knex, locale }) => {
        const labelExpr = locale === "ur" ? "COALESCE(l.name_ur, l.name)" : "l.name";
        const rows = await knex("erp.labours as l")
          .select("l.id as value", knex.raw(`${labelExpr} as label`))
          .whereRaw("lower(trim(l.status)) = 'active'")
          .orderByRaw(`${labelExpr} asc`);
        return [{ value: ALL_LABOURS_VALUE, label: "all_labours" }, ...rows.map((row) => ({ value: row.value, label: row.label }))];
      },
    },
    { name: "dept_id", label: "departments", type: "select", required: true, optionsQuery: { table: "erp.departments", valueKey: "id", labelKey: "name", orderBy: "name" } },
    { name: "apply_on", label: "apply_on", type: "select", required: true, options: [{ value: "SKU", label: "apply_on_sku" }, { value: "SUBGROUP", label: "apply_on_subgroup" }, { value: "GROUP", label: "apply_on_group" }] },
    {
      name: "sku_id",
      label: "skus",
      type: "select",
      showWhen: { field: "apply_on", values: ["SKU"] },
      options: [],
    },
    {
      name: "subgroup_id",
      label: "product_subgroups",
      type: "select",
      showWhen: { field: "apply_on", values: ["SUBGROUP"] },
      optionsResolver: async ({ knex, locale }) => {
        const labelExpr = locale === "ur" ? "COALESCE(sg.name_ur, sg.name)" : "sg.name";
        const rows = await knex("erp.product_subgroups as sg")
          .distinct("sg.id as value")
          .select(knex.raw(`${labelExpr} as label`))
          .join("erp.product_subgroup_item_types as psit", "psit.subgroup_id", "sg.id")
          .where("sg.is_active", true)
          .whereIn("psit.item_type", ["FG", "SFG"])
          .orderByRaw(`${labelExpr} asc`);
        return rows.map((row) => ({ value: row.value, label: row.label }));
      },
    },
    {
      name: "group_id",
      label: "product_groups",
      type: "select",
      showWhen: { field: "apply_on", values: ["GROUP"] },
      optionsQuery: { table: "erp.product_groups", valueKey: "id", labelKey: "name", orderBy: "name" },
    },
    {
      name: "article_type",
      label: "article_type",
      type: "select",
      required: true,
      options: [
        { value: "FG", label: "article_type_fg" },
        { value: "SFG", label: "article_type_sfg" },
        { value: "BOTH", label: "coverage_scope_both" },
      ],
    },
    { name: "rate_type", label: "rate_type", type: "select", required: true, options: [{ value: "PER_DOZEN", label: "rate_type_per_dozen" }, { value: "PER_PAIR", label: "rate_type_per_pair" }] },
    { name: "rate_value", label: "rate", type: "number", min: 0, step: "0.01", required: true },
  ],
  sanitizeValues: (values) => ({
    ...values,
    apply_on: String(values.apply_on || "").trim().toUpperCase(),
    rate_type: String(values.rate_type || "").trim().toUpperCase(),
    rate_value: values.rate_value == null ? null : String(values.rate_value).trim(),
  }),
  validateValues: async ({ values, req, isUpdate, id, knex }) => {
    const applyOnSet = new Set(["SKU", "SUBGROUP", "GROUP"]);
    const rateTypeSet = new Set(["PER_DOZEN", "PER_PAIR"]);
    if (!values.dept_id) return { field: "dept_id", message: req.res.locals.t("error_select_department") };
    if (!values.labour_id) return { field: "labour_id", message: req.res.locals.t("error_select_labour") };
    if (!applyOnSet.has(values.apply_on)) return { field: "apply_on", message: req.res.locals.t("error_invalid_apply_on") };
    if (values.apply_on === "SKU" && !values.sku_id) return { field: "sku_id", message: req.res.locals.t("error_select_sku") };
    if (values.apply_on === "SUBGROUP" && !values.subgroup_id) return { field: "subgroup_id", message: req.res.locals.t("error_select_subgroup") };
    if (values.apply_on === "GROUP" && !values.group_id) return { field: "group_id", message: req.res.locals.t("error_select_group") };
    if (!rateTypeSet.has(values.rate_type)) return req.res.locals.t("error_invalid_rate_type");
    if (values.rate_value == null || Number(values.rate_value) < 0 || !hasTwoDecimalsOrLess(values.rate_value)) {
      return { field: "rate_value", message: req.res.locals.t("error_invalid_rate_value") };
    }

    if (values.apply_on !== "SKU") {
      values.sku_id = null;
    }
    if (values.apply_on !== "SUBGROUP") {
      values.subgroup_id = null;
    }
    if (values.apply_on !== "GROUP") {
      values.group_id = null;
    }

    if (values.sku_id) {
      const duplicateQuery = knex("erp.labour_rate_rules as r")
        .where({
          "r.applies_to_all_labours": false,
          "r.labour_id": Number(values.labour_id),
          "r.dept_id": Number(values.dept_id),
          "r.sku_id": Number(values.sku_id),
        })
        .first("r.id");
      if (isUpdate && id) duplicateQuery.whereNot("r.id", Number(id));
      const duplicate = await duplicateQuery;
      if (duplicate) {
        return { field: "sku_id", message: req.res.locals.t("error_duplicate_labour_rate_rule") || req.res.locals.t("error_duplicate_name") };
      }
    }

    values.rate_value = toMoney(values.rate_value);
    values.status = "active";
    return null;
  },
};

const router = express.Router();
const ratesRouter = express.Router();

ratesRouter.get("/department-options", requirePermission("SCREEN", labourRatesPage.scopeKey, "view"), async (req, res) => {
  try {
    const labourRaw = String(req.query.labour_id || "").trim();
    const labourUpper = labourRaw.toUpperCase();
    const labelExpr = req.locale === "ur" ? "COALESCE(d.name_ur, d.name)" : "d.name";

    if (!labourRaw) return res.json({ options: [] });

    let query = knex("erp.departments as d")
      .distinct("d.id as value")
      .select(knex.raw(`${labelExpr} as label`))
      .where({ "d.is_active": true, "d.is_production": true });

    if (labourUpper !== ALL_LABOURS_VALUE) {
      const labourId = Number(labourRaw);
      if (!Number.isInteger(labourId) || labourId <= 0) {
        return res.status(400).json({ message: res.locals.t("error_select_labour") });
      }
      query = query.andWhere(function whereLabourAssigned() {
        this.whereExists(function fromPrimaryDept() {
          this.select(1)
            .from("erp.labours as l")
            .where("l.id", labourId)
            .whereRaw("lower(trim(l.status)) = 'active'")
            .andWhereRaw("l.dept_id = d.id");
        }).orWhereExists(function fromLabourDepartmentMap() {
          this.select(1)
            .from("erp.labour_department as ld")
            .join("erp.labours as l2", "l2.id", "ld.labour_id")
            .where("ld.labour_id", labourId)
            .whereRaw("lower(trim(l2.status)) = 'active'")
            .andWhereRaw("ld.dept_id = d.id");
        });
      });
    }

    const options = await query.orderByRaw(`${labelExpr} asc`);
    return res.json({ options: options.map((row) => ({ value: row.value, label: row.label })) });
  } catch (err) {
    console.error("Error in LabourRateRulesService:", err);
    return res.status(400).json({ message: err?.message || res.locals.t("generic_error") });
  }
});

ratesRouter.get("/resolved-labours", requirePermission("SCREEN", labourRatesPage.scopeKey, "view"), async (req, res) => {
  try {
    const labourRaw = String(req.query.labour_id || "").trim();
    const deptId = Number(req.query.dept_id || 0);
    if (!labourRaw || !Number.isInteger(deptId) || deptId <= 0) {
      return res.json({ rows: [] });
    }

    const labourSelection =
      labourRaw.toUpperCase() === ALL_LABOURS_VALUE
        ? { all: true, labourId: null, raw: ALL_LABOURS_VALUE }
        : { all: false, labourId: Number(labourRaw), raw: labourRaw };

    const labourIds = await resolveLabourIds({
      deptId,
      labourSelection,
      t: res.locals.t,
    });
    if (!labourIds.length) return res.json({ rows: [] });

    const labelExpr = req.locale === "ur" ? "COALESCE(l.name_ur, l.name)" : "l.name";
    const rows = await knex("erp.labours as l")
      .select("l.id as labour_id", knex.raw(`${labelExpr} as labour_name`))
      .whereIn("l.id", labourIds)
      .orderByRaw(`${labelExpr} asc`);

    return res.json({
      rows: rows.map((row) => ({
        labour_id: Number(row.labour_id),
        labour_name: row.labour_name,
      })),
    });
  } catch (err) {
    console.error("Error in LabourRateRulesService:", err);
    return res.status(400).json({ message: err?.message || res.locals.t("generic_error") });
  }
});

ratesRouter.get("/sku-options", requirePermission("SCREEN", labourRatesPage.scopeKey, "view"), async (req, res) => {
  try {
    const articleTypeRaw = String(req.query.article_type || "").trim().toUpperCase();
    let itemTypes = [ARTICLE_TYPE.FINISHED, ARTICLE_TYPE.SEMI_FINISHED];
    if (articleTypeRaw === ARTICLE_TYPE.FINISHED || articleTypeRaw === "FINISHED") itemTypes = [ARTICLE_TYPE.FINISHED];
    if (articleTypeRaw === ARTICLE_TYPE.SEMI_FINISHED || articleTypeRaw === "SEMI_FINISHED") itemTypes = [ARTICLE_TYPE.SEMI_FINISHED];

    const term = String(req.query.q || "").trim();
    let query = knex("erp.skus as s")
      .distinct("s.id as value", "s.sku_code as label")
      .join("erp.variants as v", "v.id", "s.variant_id")
      .join("erp.items as i", "i.id", "v.item_id")
      .whereIn("i.item_type", itemTypes);

    if (term) {
      query = query.whereILike("s.sku_code", `%${term}%`);
    }

    const options = await query.orderBy("s.sku_code", "asc").limit(1500);
    return res.json({ options });
  } catch (err) {
    console.error("Error in LabourRateRulesService:", err);
    return res.status(400).json({ message: err?.message || res.locals.t("generic_error") });
  }
});

ratesRouter.get("/bulk-preview", requirePermission("SCREEN", labourRatesPage.scopeKey, "view"), async (req, res) => {
  try {
    const normalized = normalizeScopeInput({ payload: req.query || {}, t: res.locals.t });
    const labourIds = await resolveLabourIds({
      deptId: normalized.deptId,
      labourSelection: normalized.labourSelection,
      t: res.locals.t,
    });

    const rows = await buildBulkPreviewRows({
      labourIds,
      deptId: normalized.deptId,
      applyOn: normalized.applyOn,
      skuId: normalized.skuId,
      subgroupId: normalized.subgroupId,
      groupId: normalized.groupId,
      articleType: normalized.articleType,
      rateType: normalized.rateType,
      baseRate: req.query.rate_value || null,
    });

    return res.json({ rows });
  } catch (err) {
    console.error("Error in LabourRateRulesService:", err);
    return res.status(400).json({ message: err?.message || res.locals.t("generic_error") });
  }
});

ratesRouter.post("/bulk-upsert", requirePermission("SCREEN", labourRatesPage.scopeKey, "navigate"), async (req, res) => {
  try {
    const normalized = normalizeBulkInput({ payload: req.body || {}, t: res.locals.t });
    const labourIds = await resolveLabourIds({
      deptId: normalized.deptId,
      labourSelection: normalized.labourSelection,
      t: res.locals.t,
    });

    const expectedRows = await buildBulkPreviewRows({
      labourIds,
      deptId: normalized.deptId,
      applyOn: normalized.applyOn,
      skuId: normalized.skuId,
      subgroupId: normalized.subgroupId,
      groupId: normalized.groupId,
      articleType: normalized.articleType,
      rateType: normalized.rateType,
      baseRate: null,
    });

    const allowedSkuIds = new Set(expectedRows.map((row) => Number(row.sku_id)));
    const invalidSku = normalized.rows.find((row) => !allowedSkuIds.has(Number(row.skuId)));
    if (invalidSku || normalized.rows.length !== expectedRows.length) {
      return res.status(400).json({ message: res.locals.t("error_invalid_bulk_labour_rate_payload") });
    }

    const approval = await handleScreenApproval({
      req,
      scopeKey: labourRatesPage.scopeKey,
      action: "create",
      entityType: labourRatesPage.entityType,
      entityId: normalized.labourSelection?.all ? "ALL" : normalized.labourSelection?.labourId || "NEW",
      summary: `${res.locals.t("add")} ${res.locals.t(labourRatesPage.titleKey)}`,
      oldValue: null,
      newValue: {
        mode: "BULK_LABOUR_RATE_SKU_UPSERT",
        labour_id: normalized.labourSelection?.raw || null,
        dept_id: normalized.deptId,
        apply_on: normalized.applyOn,
        sku_id: normalized.skuId,
        subgroup_id: normalized.subgroupId,
        group_id: normalized.groupId,
        article_type: normalized.articleType,
        rate_type: normalized.rateType,
        status: normalized.status,
        rows: normalized.rows,
      },
      t: res.locals.t,
    });

    if (approval.queued) {
      const canViewApprovals = typeof res.locals.can === "function" ? res.locals.can("SCREEN", "administration.approvals", "navigate") : false;
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
        labourIds,
        deptId: normalized.deptId,
        applyOn: normalized.applyOn,
        subgroupId: normalized.subgroupId,
        groupId: normalized.groupId,
        rateType: normalized.rateType,
        status: normalized.status,
        rows: normalized.rows,
      });
    });

    queueAuditLog(req, {
      entityType: labourRatesPage.entityType,
      entityId: normalized.labourSelection?.all ? "ALL" : normalized.labourSelection?.labourId || "NEW",
      action: "UPDATE",
      context: {
        source: "labour-rate-bulk-upsert",
        apply_on: normalized.applyOn,
        rate_type: normalized.rateType,
        created: result.created,
        updated: result.updated,
        row_count: normalized.rows.length,
      },
    });

    return res.json({
      message: res.locals.t("success_bulk_labour_rate_saved"),
      created: result.created,
      updated: result.updated,
    });
  } catch (err) {
    console.error("Error in LabourRateRulesService:", err);
    return res.status(400).json({ message: err?.message || res.locals.t("generic_error") });
  }
});

ratesRouter.use("/", createHrMasterRouter(labourRatesPage));
router.use("/rates", ratesRouter);
router.use("/", createHrMasterRouter(page));

module.exports = router;
