const express = require("express");
const knex = require("../../db/knex");
const { createHrMasterRouter, hydratePage } = require("./master-router");
const {
  normalizePhone,
  normalizeCnic,
  isValidPhone,
  isValidCnic,
  toMoney,
  hasTwoDecimalsOrLess,
} = require("./validation");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const {
  handleScreenApproval,
} = require("../../middleware/approvals/screen-approval");
const { queueAuditLog } = require("../../utils/audit-log");
const {
  ARTICLE_TYPE,
  normalizeScopeInput,
  normalizeBulkInput,
  resolveLabourIds,
  buildBulkPreviewRows,
  applyBulkSkuRateUpsert,
} = require("../../services/hr-payroll/labour-rates-service");

let hasLabourRateArticleTypeColumnPromise = null;
const hasLabourRateArticleTypeColumn = async (db = knex) => {
  if (!hasLabourRateArticleTypeColumnPromise) {
    hasLabourRateArticleTypeColumnPromise = db.schema
      .withSchema("erp")
      .hasColumn("labour_rate_rules", "article_type")
      .catch((err) => {
        console.error("Error in LabourRateRulesService:", err);
        return false;
      });
  }
  return hasLabourRateArticleTypeColumnPromise;
};
const LABOUR_RATE_ARTICLE_TYPE_SQL = `
  COALESCE(
    NULLIF(UPPER(COALESCE(to_jsonb(t)->>'article_type', '')), ''),
    UPPER(COALESCE(i.item_type::text, '')),
    UPPER(COALESCE((SELECT psit.item_type::text FROM erp.product_subgroup_item_types psit WHERE psit.subgroup_id = t.subgroup_id ORDER BY psit.item_type LIMIT 1), '')),
    UPPER(COALESCE((SELECT pgit.item_type::text FROM erp.product_group_item_types pgit WHERE pgit.group_id = t.group_id ORDER BY pgit.item_type LIMIT 1), '')),
    ''
  )
`;

const labourDeptTableSupport = new Map();
const hasErpTable = async (db, tableName) => {
  const key = String(tableName || "")
    .trim()
    .toLowerCase();
  if (!key) return false;
  if (!labourDeptTableSupport.has(key)) {
    labourDeptTableSupport.set(
      key,
      db.schema
        .withSchema("erp")
        .hasTable(key)
        .catch((err) => {
          console.error("Error in LabourDepartmentGuardService:", err);
          return false;
        }),
    );
  }
  return labourDeptTableSupport.get(key);
};

const findLabourDeptUsageMap = async ({ db, labourId, deptIds = [] }) => {
  const normalizedLabourId = Number(labourId || 0);
  const normalizedDeptIds = [
    ...new Set(
      (Array.isArray(deptIds) ? deptIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
  if (
    !Number.isInteger(normalizedLabourId) ||
    normalizedLabourId <= 0 ||
    !normalizedDeptIds.length
  ) {
    return new Map();
  }

  const [
    hasDcvHeader,
    hasLabourVoucherLine,
    hasLabourRateRules,
    hasBomLabourLine,
  ] = await Promise.all([
    hasErpTable(db, "dcv_header"),
    hasErpTable(db, "labour_voucher_line"),
    hasErpTable(db, "labour_rate_rules"),
    hasErpTable(db, "bom_labour_line"),
  ]);

  const [dcvRows, labourVoucherRows, labourRateRows, bomLabourRows] =
    await Promise.all([
      hasDcvHeader
        ? db("erp.dcv_header")
            .distinct("dept_id")
            .where({ labour_id: normalizedLabourId })
            .whereIn("dept_id", normalizedDeptIds)
        : Promise.resolve([]),
      hasLabourVoucherLine
        ? db("erp.labour_voucher_line")
            .distinct("dept_id")
            .where({ labour_id: normalizedLabourId })
            .whereIn("dept_id", normalizedDeptIds)
        : Promise.resolve([]),
      hasLabourRateRules
        ? db("erp.labour_rate_rules")
            .distinct("dept_id")
            .where({ labour_id: normalizedLabourId })
            .whereIn("dept_id", normalizedDeptIds)
        : Promise.resolve([]),
      hasBomLabourLine
        ? db("erp.bom_labour_line")
            .distinct("dept_id")
            .where({ labour_id: normalizedLabourId })
            .whereIn("dept_id", normalizedDeptIds)
        : Promise.resolve([]),
    ]);

  const usageByDept = new Map();
  const addUsage = (rows, source) => {
    rows.forEach((row) => {
      const deptId = Number(row?.dept_id || 0);
      if (!deptId) return;
      if (!usageByDept.has(deptId)) usageByDept.set(deptId, new Set());
      usageByDept.get(deptId).add(source);
    });
  };
  addUsage(dcvRows, "DCV");
  addUsage(labourVoucherRows, "LABOUR_VOUCHER");
  addUsage(labourRateRows, "LABOUR_RATE_RULE");
  addUsage(bomLabourRows, "BOM_LABOUR_LINE");
  return usageByDept;
};

const page = {
  titleKey: "labours",
  descriptionKey: "labours_description",
  table: "erp.labours",
  scopeKey: "hr_payroll.labours",
  entityType: "LABOUR",
  softDeleteOnHardDelete: true,
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
  multiMaps: [
    {
      table: "erp.labour_department",
      key: "labour_id",
      valueKey: "dept_id",
      fieldName: "dept_ids",
    },
  ],
  joins: [],
  extraSelect: (locale) => [
    knex.raw(
      `(SELECT COALESCE(string_agg(x.dept_id::text, ',' ORDER BY x.dept_id), '')
        FROM (
          SELECT DISTINCT ld.dept_id
          FROM erp.labour_department ld
          WHERE ld.labour_id = t.id
          UNION
          SELECT DISTINCT t.dept_id
          WHERE t.dept_id IS NOT NULL
        ) x) as dept_ids`,
    ),
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
    knex.raw(
      "CASE WHEN lower(trim(t.status)) = 'active' THEN true ELSE false END as is_active",
    ),
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
    {
      name: "name",
      label: "name",
      placeholder: "placeholder_labour_name",
      required: true,
    },
    { name: "name_ur", label: "name_ur", placeholder: "name_ur" },
    {
      name: "cnic",
      label: "cnic",
      placeholder: "placeholder_employee_cnic",
      required: true,
    },
    {
      name: "phone",
      label: "phone_number",
      placeholder: "placeholder_phone_number",
      required: true,
    },
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
    dept_ids: Array.isArray(values.dept_ids)
      ? [
          ...new Set(
            values.dept_ids.map((id) => String(id).trim()).filter(Boolean),
          ),
        ]
      : [],
    dept_id:
      Array.isArray(values.dept_ids) && values.dept_ids.length
        ? String(values.dept_ids[0]).trim()
        : null,
  }),
  validateValues: async ({ values, req, isUpdate, id }) => {
    const categories = new Set(["finished", "semi_finished"]);
    if (!categories.has(values.production_category))
      return req.res.locals.t("error_invalid_production_category");
    if (!Array.isArray(values.dept_ids) || !values.dept_ids.length)
      return {
        field: "dept_ids",
        message: req.res.locals.t("error_select_department"),
      };
    if (!values.cnic)
      return {
        field: "cnic",
        message: req.res.locals.t("error_required_fields"),
      };
    if (!values.phone)
      return {
        field: "phone",
        message: req.res.locals.t("error_required_fields"),
      };
    if (values.status !== "active" && values.status !== "inactive")
      return req.res.locals.t("error_invalid_status");
    if (values.cnic && !isValidCnic(values.cnic))
      return { field: "cnic", message: req.res.locals.t("error_invalid_cnic") };
    if (values.phone && !isValidPhone(values.phone))
      return {
        field: "phone",
        message: req.res.locals.t("error_invalid_phone_number"),
      };
    values.dept_id = Number(values.dept_ids[0] || 0) || null;

    if (isUpdate && id) {
      const labourId = Number(id || 0);
      const [existingLabour, existingMapRows] = await Promise.all([
        knex("erp.labours")
          .select("id", "dept_id")
          .where({ id: labourId })
          .first(),
        knex("erp.labour_department")
          .select("dept_id")
          .where({ labour_id: labourId }),
      ]);
      const existingDeptIds = new Set();
      const primaryDeptId = Number(existingLabour?.dept_id || 0);
      if (Number.isInteger(primaryDeptId) && primaryDeptId > 0)
        existingDeptIds.add(primaryDeptId);
      (existingMapRows || []).forEach((row) => {
        const deptId = Number(row?.dept_id || 0);
        if (Number.isInteger(deptId) && deptId > 0) existingDeptIds.add(deptId);
      });

      const nextDeptIds = new Set(
        (Array.isArray(values.dept_ids) ? values.dept_ids : [])
          .map((deptId) => Number(deptId))
          .filter((deptId) => Number.isInteger(deptId) && deptId > 0),
      );
      const removedDeptIds = [...existingDeptIds].filter(
        (deptId) => !nextDeptIds.has(deptId),
      );
      if (removedDeptIds.length) {
        const usageMap = await findLabourDeptUsageMap({
          db: knex,
          labourId,
          deptIds: removedDeptIds,
        });
        const blockedDeptIds = removedDeptIds.filter((deptId) =>
          usageMap.has(Number(deptId)),
        );
        if (blockedDeptIds.length) {
          const deptRows = await knex("erp.departments")
            .select("id", "name")
            .whereIn("id", blockedDeptIds);
          const deptNameById = new Map(
            (deptRows || []).map((row) => [
              Number(row.id),
              String(row.name || `#${row.id}`).trim(),
            ]),
          );
          const blockedDeptLabels = blockedDeptIds.map(
            (deptId) => deptNameById.get(Number(deptId)) || `#${deptId}`,
          );
          const msgTemplate = req.res.locals.t(
            "error_labour_department_in_use",
          );
          const msg = String(
            msgTemplate && msgTemplate !== "error_labour_department_in_use"
              ? msgTemplate
              : "Department mapping cannot be removed because it is already used in vouchers/rates/BOM.",
          );
          return {
            field: "dept_ids",
            message: `${msg} ${blockedDeptLabels.join(", ")}`,
          };
        }
      }
    }

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
  maxRows: 500,
  filterConfig: {
    primary: {
      key: "labour_id",
      label: "labours",
      valueType: "number",
      dbColumn: "t.labour_id",
      optionsResolver: async ({ knex, locale }) => {
        const labelExpr =
          locale === "ur" ? "COALESCE(l.name_ur, l.name)" : "l.name";
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
  },
  applyExtraFilters: (query, { filters = {} } = {}) => {
    const subgroupIds = Array.isArray(filters.subgroupValues)
      ? filters.subgroupValues
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
      : [];
    const groupIds = Array.isArray(filters.groupValues)
      ? filters.groupValues
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
      : [];
    const articleTypes = Array.isArray(filters.articleTypeValues)
      ? filters.articleTypeValues
          .map((value) =>
            String(value || "")
              .trim()
              .toUpperCase(),
          )
          .filter((value) => value === "FG" || value === "SFG")
      : [];
    const subgroupMode =
      String(filters.subgroupMode || "include").toLowerCase() === "exclude"
        ? "exclude"
        : "include";
    const groupMode =
      String(filters.groupMode || "include").toLowerCase() === "exclude"
        ? "exclude"
        : "include";
    const articleTypeMode =
      String(filters.articleTypeMode || "include").toLowerCase() === "exclude"
        ? "exclude"
        : "include";

    if (subgroupIds.length) {
      const subgroupMatch = function subgroupMatch() {
        this.where(function skuSubgroupMatch() {
          this.where("t.apply_on", "SKU").whereIn("i.subgroup_id", subgroupIds);
        })
          .orWhere(function subgroupRuleMatch() {
            this.where("t.apply_on", "SUBGROUP").whereIn(
              "t.subgroup_id",
              subgroupIds,
            );
          })
          .orWhere(function groupRuleFromSubgroupMatch() {
            this.where("t.apply_on", "GROUP").whereIn(
              "t.group_id",
              function subgroupGroupIds() {
                this.select("sg_filter.group_id")
                  .from("erp.product_subgroups as sg_filter")
                  .whereIn("sg_filter.id", subgroupIds);
              },
            );
          });
      };
      query =
        subgroupMode === "exclude"
          ? query.whereNot(subgroupMatch)
          : query.where(subgroupMatch);
    }
    if (groupIds.length) {
      const groupMatch = function groupMatch() {
        this.where(function skuGroupMatch() {
          this.where("t.apply_on", "SKU").whereIn("i.group_id", groupIds);
        })
          .orWhere(function subgroupGroupMatch() {
            this.where("t.apply_on", "SUBGROUP").whereIn(
              "sg_rule.group_id",
              groupIds,
            );
          })
          .orWhere(function groupRuleMatch() {
            this.where("t.apply_on", "GROUP").whereIn("t.group_id", groupIds);
          });
      };
      query =
        groupMode === "exclude"
          ? query.whereNot(groupMatch)
          : query.where(groupMatch);
    }
    if (articleTypes.length) {
      const ARTICLE_TYPE_BOTH = "BOTH";
      query =
        articleTypeMode === "exclude"
          ? query
              .whereNotIn(knex.raw(LABOUR_RATE_ARTICLE_TYPE_SQL), articleTypes)
              .whereRaw(`${LABOUR_RATE_ARTICLE_TYPE_SQL} <> ?`, [
                ARTICLE_TYPE_BOTH,
              ])
          : query.where(function includeArticleTypeFilter() {
              this.whereIn(
                knex.raw(LABOUR_RATE_ARTICLE_TYPE_SQL),
                articleTypes,
              ).orWhereRaw(`${LABOUR_RATE_ARTICLE_TYPE_SQL} = ?`, [
                ARTICLE_TYPE_BOTH,
              ]);
            });
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
    {
      table: { sg_rule: "erp.product_subgroups" },
      on: ["t.subgroup_id", "sg_rule.id"],
    },
  ],
  extraSelect: (locale) => [
    locale === "ur"
      ? knex.raw("COALESCE(l.name_ur, l.name) as labour_name")
      : "l.name as labour_name",
    locale === "ur"
      ? knex.raw("COALESCE(d.name_ur, d.name) as department_name")
      : "d.name as department_name",
    "s.sku_code as sku_code",
    knex.raw(`${LABOUR_RATE_ARTICLE_TYPE_SQL} as article_type`),
    knex.raw(
      "CASE WHEN lower(trim(t.status)) = 'active' THEN true ELSE false END as is_active",
    ),
  ],
  columns: [
    { key: "id", label: "id" },
    { key: "labour_name", label: "labours" },
    { key: "department_name", label: "departments" },
    { key: "sku_code", label: "skus" },
    { key: "article_type", label: "article_type" },
    { key: "rate_value", label: "rate" },
  ],
  fields: [
    {
      name: "labour_id",
      label: "labours",
      type: "multi-select",
      required: true,
      optionsResolver: async ({ knex, locale }) => {
        const labelExpr =
          locale === "ur" ? "COALESCE(l.name_ur, l.name)" : "l.name";
        const rows = await knex("erp.labours as l")
          .select("l.id as value", knex.raw(`${labelExpr} as label`))
          .whereRaw("lower(trim(l.status)) = 'active'")
          .orderByRaw(`${labelExpr} asc`);
        return rows.map((row) => ({ value: row.value, label: row.label }));
      },
    },
    {
      name: "dept_id",
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
    {
      name: "sku_id",
      label: "skus",
      type: "select",
      multiple: true,
      showWhen: { field: "apply_on", values: ["SKU"] },
      options: [],
    },
    {
      name: "subgroup_id",
      label: "product_subgroups",
      type: "select",
      multiple: true,
      showWhen: { field: "apply_on", values: ["SUBGROUP"] },
      optionsResolver: async ({ knex, locale }) => {
        const labelExpr =
          locale === "ur" ? "COALESCE(sg.name_ur, sg.name)" : "sg.name";
        const rows = await knex("erp.product_subgroups as sg")
          .distinct("sg.id as value")
          .select(knex.raw(`${labelExpr} as label`))
          .join(
            "erp.product_subgroup_item_types as psit",
            "psit.subgroup_id",
            "sg.id",
          )
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
      multiple: true,
      showWhen: { field: "apply_on", values: ["GROUP"] },
      optionsResolver: async ({ knex, locale }) => {
        const labelExpr =
          locale === "ur" ? "COALESCE(pg.name_ur, pg.name)" : "pg.name";
        const rows = await knex("erp.product_groups as pg")
          .distinct("pg.id as value")
          .select(knex.raw(`${labelExpr} as label`))
          .join(
            "erp.product_group_item_types as pgit",
            "pgit.group_id",
            "pg.id",
          )
          .where("pg.is_active", true)
          .whereIn("pgit.item_type", ["FG", "SFG"])
          .orderByRaw(`${labelExpr} asc`);
        return rows.map((row) => ({ value: row.value, label: row.label }));
      },
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
      name: "rate_value",
      label: "rate",
      type: "number",
      min: 0,
      step: "0.01",
      required: true,
    },
  ],
  sanitizeValues: (values) => ({
    ...values,
    apply_on: String(values.apply_on || "")
      .trim()
      .toUpperCase(),
    article_type:
      values.article_type == null
        ? null
        : String(values.article_type).trim().toUpperCase(),
    rate_type: String(values.rate_type || "")
      .trim()
      .toUpperCase(),
    rate_value:
      values.rate_value == null ? null : String(values.rate_value).trim(),
  }),
  validateValues: async ({ values, req, isUpdate, id, knex }) => {
    const hasArticleTypeColumn = await hasLabourRateArticleTypeColumn(knex);

    if (isUpdate && id) {
      const selectCols = [
        "labour_id",
        "dept_id",
        "apply_on",
        "sku_id",
        "subgroup_id",
        "group_id",
      ];
      if (hasArticleTypeColumn) {
        selectCols.push("article_type");
      }
      const existing = await knex("erp.labour_rate_rules")
        .where({ id: Number(id) })
        .first(...selectCols);
      if (!existing) return req.res.locals.t("error_not_found");
      values.labour_id = existing.labour_id;
      values.dept_id = existing.dept_id;
      values.apply_on = existing.apply_on;
      values.sku_id = existing.sku_id;
      values.subgroup_id = existing.subgroup_id;
      values.group_id = existing.group_id;
      if (hasArticleTypeColumn) {
        values.article_type = existing.article_type;
      }
    }

    const applyOnSet = new Set(["SKU", "SUBGROUP", "GROUP"]);
    const rateTypeSet = new Set(["PER_DOZEN", "PER_PAIR"]);
    if (!values.dept_id)
      return {
        field: "dept_id",
        message: req.res.locals.t("error_select_department"),
      };
    if (!values.labour_id)
      return {
        field: "labour_id",
        message: req.res.locals.t("error_select_labour"),
      };
    if (!applyOnSet.has(values.apply_on))
      return {
        field: "apply_on",
        message: req.res.locals.t("error_invalid_apply_on"),
      };
    if (values.apply_on === "SKU" && !values.sku_id)
      return { field: "sku_id", message: req.res.locals.t("error_select_sku") };
    if (values.apply_on === "SUBGROUP" && !values.subgroup_id)
      return {
        field: "subgroup_id",
        message: req.res.locals.t("error_select_subgroup"),
      };
    if (values.apply_on === "GROUP" && !values.group_id)
      return {
        field: "group_id",
        message: req.res.locals.t("error_select_group"),
      };
    if (!rateTypeSet.has(values.rate_type))
      return req.res.locals.t("error_invalid_rate_type");
    if (
      values.rate_value == null ||
      Number(values.rate_value) < 0 ||
      !hasTwoDecimalsOrLess(values.rate_value)
    ) {
      return {
        field: "rate_value",
        message: req.res.locals.t("error_invalid_rate_value"),
      };
    }

    if (!isUpdate && values.apply_on !== "SKU") {
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
        return {
          field: "sku_id",
          message:
            req.res.locals.t("error_duplicate_labour_rate_rule") ||
            req.res.locals.t("error_duplicate_name"),
        };
      }
    }

    values.rate_value = toMoney(values.rate_value);
    values.status = "active";
    if (!hasArticleTypeColumn) {
      delete values.article_type;
    }
    return null;
  },
};

const router = express.Router();
const ratesRouter = express.Router();
const logLabourRateSaveDebug = (req, event, payload = {}) => {
  console.log("[hr-labour-rates-save-debug]", {
    event,
    path: req?.originalUrl || req?.url || "",
    method: req?.method || "",
    userId: req?.user?.id || null,
    username: req?.user?.username || null,
    ...payload,
  });
};

ratesRouter.get(
  "/department-options",
  requirePermission("SCREEN", labourRatesPage.scopeKey, "view"),
  async (req, res) => {
    try {
      const labourIds = [
        ...new Set(
          (Array.isArray(req.query.labour_ids)
            ? req.query.labour_ids
            : String(req.query.labour_ids || "").split(",")
          )
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0),
        ),
      ];
      const labourRaw = String(req.query.labour_id || "").trim();
      const labelExpr =
        req.locale === "ur" ? "COALESCE(d.name_ur, d.name)" : "d.name";

      if (!labourRaw && !labourIds.length) return res.json({ options: [] });

      const effectiveLabourIds = labourIds.length
        ? labourIds
        : [Number(labourRaw)].filter(
            (value) => Number.isInteger(value) && value > 0,
          );

      if (!effectiveLabourIds.length) {
        return res
          .status(400)
          .json({ message: res.locals.t("error_select_labour") });
      }

      const labourDepartmentRows = await knex("erp.labours as l")
        .leftJoin("erp.labour_department as ld", "ld.labour_id", "l.id")
        .select(
          "l.id as labour_id",
          "l.dept_id as primary_dept_id",
          "ld.dept_id as mapped_dept_id",
        )
        .whereIn("l.id", effectiveLabourIds)
        .whereRaw("lower(trim(l.status)) = 'active'");

      const deptMapByLabour = new Map();
      effectiveLabourIds.forEach((id) => {
        deptMapByLabour.set(Number(id), new Set());
      });
      labourDepartmentRows.forEach((row) => {
        const labourIdNum = Number(row.labour_id);
        if (!deptMapByLabour.has(labourIdNum)) {
          deptMapByLabour.set(labourIdNum, new Set());
        }
        const deptSet = deptMapByLabour.get(labourIdNum);
        const primaryDept = Number(row.primary_dept_id || 0);
        const mappedDept = Number(row.mapped_dept_id || 0);
        if (Number.isInteger(primaryDept) && primaryDept > 0)
          deptSet.add(primaryDept);
        if (Number.isInteger(mappedDept) && mappedDept > 0)
          deptSet.add(mappedDept);
      });

      let commonDeptIds = null;
      for (const labourIdNum of effectiveLabourIds) {
        const deptSet = deptMapByLabour.get(Number(labourIdNum)) || new Set();
        const deptIds = [...deptSet];
        if (!deptIds.length) {
          commonDeptIds = [];
          break;
        }
        if (commonDeptIds === null) {
          commonDeptIds = deptIds;
        } else {
          const currentSet = new Set(deptIds);
          commonDeptIds = commonDeptIds.filter((deptId) =>
            currentSet.has(deptId),
          );
        }
        if (!commonDeptIds.length) break;
      }

      if (!Array.isArray(commonDeptIds) || !commonDeptIds.length) {
        return res.json({ options: [] });
      }

      const options = await knex("erp.departments as d")
        .distinct("d.id as value")
        .select(knex.raw(`${labelExpr} as label`))
        .where({ "d.is_active": true, "d.is_production": true })
        .whereIn("d.id", commonDeptIds)
        .orderByRaw(`${labelExpr} asc`);

      return res.json({
        options: options.map((row) => ({ value: row.value, label: row.label })),
      });
    } catch (err) {
      console.error("Error in LabourRateRulesService:", err);
      return res
        .status(400)
        .json({ message: err?.message || res.locals.t("generic_error") });
    }
  },
);

ratesRouter.get(
  "/resolved-labours",
  requirePermission("SCREEN", labourRatesPage.scopeKey, "view"),
  async (req, res) => {
    try {
      const labourIdsInput = [
        ...new Set(
          (Array.isArray(req.query.labour_ids)
            ? req.query.labour_ids
            : String(req.query.labour_ids || "").split(",")
          )
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0),
        ),
      ];
      const labourRaw = String(req.query.labour_id || "").trim();
      const deptId = Number(req.query.dept_id || 0);
      if (
        (!labourRaw && !labourIdsInput.length) ||
        !Number.isInteger(deptId) ||
        deptId <= 0
      ) {
        return res.json({ rows: [] });
      }

      const labourIds = labourIdsInput.length
        ? labourIdsInput
        : [Number(labourRaw)].filter(
            (value) => Number.isInteger(value) && value > 0,
          );
      if (!labourIds.length) {
        return res
          .status(400)
          .json({ message: res.locals.t("error_select_labour") });
      }

      const resolvedLabourIds = await resolveLabourIds({
        deptId,
        labourSelection: {
          all: false,
          labourId: labourIds[0],
          labourIds,
          raw: labourIds.join(","),
        },
        t: res.locals.t,
      });
      if (!resolvedLabourIds.length) return res.json({ rows: [] });

      const labelExpr =
        req.locale === "ur" ? "COALESCE(l.name_ur, l.name)" : "l.name";
      const rows = await knex("erp.labours as l")
        .select("l.id as labour_id", knex.raw(`${labelExpr} as labour_name`))
        .whereIn("l.id", resolvedLabourIds)
        .orderByRaw(`${labelExpr} asc`);

      return res.json({
        rows: rows.map((row) => ({
          labour_id: Number(row.labour_id),
          labour_name: row.labour_name,
        })),
      });
    } catch (err) {
      console.error("Error in LabourRateRulesService:", err);
      return res
        .status(400)
        .json({ message: err?.message || res.locals.t("generic_error") });
    }
  },
);

ratesRouter.get(
  "/sku-options",
  requirePermission("SCREEN", labourRatesPage.scopeKey, "view"),
  async (req, res) => {
    try {
      const articleTypeRaw = String(req.query.article_type || "")
        .trim()
        .toUpperCase();
      let itemTypes = [ARTICLE_TYPE.FINISHED, ARTICLE_TYPE.SEMI_FINISHED];
      if (
        articleTypeRaw === ARTICLE_TYPE.FINISHED ||
        articleTypeRaw === "FINISHED"
      )
        itemTypes = [ARTICLE_TYPE.FINISHED];
      if (
        articleTypeRaw === ARTICLE_TYPE.SEMI_FINISHED ||
        articleTypeRaw === "SEMI_FINISHED"
      )
        itemTypes = [ARTICLE_TYPE.SEMI_FINISHED];

      const term = String(req.query.q || "").trim();
      let query = knex("erp.skus as s")
        .distinct("s.id as value", "s.sku_code as label")
        .join("erp.variants as v", "v.id", "s.variant_id")
        .join("erp.items as i", "i.id", "v.item_id")
        .where({ "s.is_active": true, "i.is_active": true })
        .whereIn("i.item_type", itemTypes);

      if (term) {
        query = query.whereILike("s.sku_code", `%${term}%`);
      }

      const options = await query.orderBy("s.sku_code", "asc").limit(1500);
      return res.json({ options });
    } catch (err) {
      console.error("Error in LabourRateRulesService:", err);
      return res
        .status(400)
        .json({ message: err?.message || res.locals.t("generic_error") });
    }
  },
);

ratesRouter.get(
  "/bulk-preview",
  requirePermission("SCREEN", labourRatesPage.scopeKey, "view"),
  async (req, res) => {
    try {
      const normalized = normalizeScopeInput({
        payload: req.query || {},
        t: res.locals.t,
      });
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
        skuIds: normalized.skuIds,
        subgroupId: normalized.subgroupId,
        subgroupIds: normalized.subgroupIds,
        groupId: normalized.groupId,
        groupIds: normalized.groupIds,
        articleType: normalized.articleType,
        rateType: normalized.rateType,
        baseRate: req.query.rate_value || null,
      });

      return res.json({ rows });
    } catch (err) {
      console.error("Error in LabourRateRulesService:", err);
      return res
        .status(400)
        .json({ message: err?.message || res.locals.t("generic_error") });
    }
  },
);

ratesRouter.post(
  "/bulk-upsert",
  requirePermission("SCREEN", labourRatesPage.scopeKey, "create"),
  async (req, res) => {
    const traceId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    logLabourRateSaveDebug(req, "bulk_upsert:request_received", {
      traceId,
      bodyKeys: Object.keys(req.body || {}),
      rowsCount: Array.isArray(req.body?.rows) ? req.body.rows.length : 0,
    });
    try {
      const normalized = normalizeBulkInput({
        payload: req.body || {},
        t: res.locals.t,
      });
      logLabourRateSaveDebug(req, "bulk_upsert:normalized", {
        traceId,
        labourSelection: normalized.labourSelection?.all
          ? "ALL"
          : normalized.labourSelection?.labourId || null,
        deptId: normalized.deptId,
        applyOn: normalized.applyOn,
        articleType: normalized.articleType,
        rateType: normalized.rateType,
        rowsCount: normalized.rows.length,
      });
      const labourIds = await resolveLabourIds({
        deptId: normalized.deptId,
        labourSelection: normalized.labourSelection,
        t: res.locals.t,
      });
      logLabourRateSaveDebug(req, "bulk_upsert:labours_resolved", {
        traceId,
        labourIdsCount: labourIds.length,
        elapsedMs: Date.now() - startedAt,
      });

      const expectedRowsStart = Date.now();
      logLabourRateSaveDebug(req, "bulk_upsert:expected_rows_start", {
        traceId,
        elapsedMs: expectedRowsStart - startedAt,
      });
      const expectedRows = await buildBulkPreviewRows({
        labourIds,
        deptId: normalized.deptId,
        applyOn: normalized.applyOn,
        skuId: normalized.skuId,
        skuIds: normalized.skuIds,
        subgroupId: normalized.subgroupId,
        subgroupIds: normalized.subgroupIds,
        groupId: normalized.groupId,
        groupIds: normalized.groupIds,
        articleType: normalized.articleType,
        rateType: normalized.rateType,
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
          subgroup_id: row.subgroup_id ?? null,
          group_id: row.group_id ?? null,
          new_rate: nextRate ?? null,
        };
      });
      logLabourRateSaveDebug(req, "bulk_upsert:expected_rows_done", {
        traceId,
        expectedRowsCount: expectedRows.length,
        durationMs: Date.now() - expectedRowsStart,
        elapsedMs: Date.now() - startedAt,
      });

      const allowedSkuIds = new Set(
        expectedRows.map((row) => Number(row.sku_id)),
      );
      const invalidSku = normalized.rows.find(
        (row) => !allowedSkuIds.has(Number(row.skuId)),
      );
      if (invalidSku || normalized.rows.length !== expectedRows.length) {
        logLabourRateSaveDebug(req, "bulk_upsert:payload_mismatch", {
          traceId,
          expectedRowsCount: expectedRows.length,
          receivedRowsCount: normalized.rows.length,
          invalidSkuId: invalidSku ? Number(invalidSku.skuId) : null,
        });
        return res.status(400).json({
          message: res.locals.t("error_invalid_bulk_labour_rate_payload"),
        });
      }

      const approvalStart = Date.now();
      logLabourRateSaveDebug(req, "bulk_upsert:approval_check_start", {
        traceId,
        elapsedMs: approvalStart - startedAt,
      });
      const approval = await handleScreenApproval({
        req,
        scopeKey: labourRatesPage.scopeKey,
        action: "create",
        entityType: labourRatesPage.entityType,
        entityId: normalized.labourSelection?.all
          ? "ALL"
          : normalized.labourSelection?.labourId || "NEW",
        summary: `${res.locals.t("add")} ${res.locals.t(labourRatesPage.titleKey)}`,
        oldValue: null,
        newValue: {
          mode: "BULK_LABOUR_RATE_SKU_UPSERT",
          labour_id: normalized.labourSelection?.raw || null,
          dept_id: normalized.deptId,
          apply_on: normalized.applyOn,
          sku_id: normalized.skuId,
          sku_ids: normalized.skuIds,
          subgroup_id: normalized.subgroupId,
          subgroup_ids: normalized.subgroupIds,
          group_id: normalized.groupId,
          group_ids: normalized.groupIds,
          article_type: normalized.articleType,
          rate_type: normalized.rateType,
          status: normalized.status,
          rows: queuedRows,
        },
        t: res.locals.t,
      });
      logLabourRateSaveDebug(req, "bulk_upsert:approval_check_done", {
        traceId,
        queued: Boolean(approval?.queued),
        durationMs: Date.now() - approvalStart,
        elapsedMs: Date.now() - startedAt,
      });

      if (approval.queued) {
        logLabourRateSaveDebug(req, "bulk_upsert:queued_for_approval", {
          traceId,
          requestId: approval.requestId || null,
        });
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

      const writeStart = Date.now();
      logLabourRateSaveDebug(req, "bulk_upsert:db_write_start", {
        traceId,
        elapsedMs: writeStart - startedAt,
      });
      const expectedRowBySku = new Map(
        expectedRows
          .map((row) => [Number(row.sku_id), row])
          .filter(([skuId]) => Number.isInteger(skuId) && skuId > 0),
      );
      const normalizedRowsForSave = normalized.rows.map((row) => {
        const expectedRow = expectedRowBySku.get(Number(row.skuId));
        return {
          ...row,
          subgroupId: row.subgroupId || expectedRow?.subgroup_id || null,
          groupId: row.groupId || expectedRow?.group_id || null,
        };
      });

      const result = await knex.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '5s'");
        await trx.raw("SET LOCAL statement_timeout = '15s'");

        return applyBulkSkuRateUpsert({
          trx,
          labourIds,
          deptId: normalized.deptId,
          applyOn: normalized.applyOn,
          subgroupId: normalized.subgroupId,
          groupId: normalized.groupId,
          rateType: normalized.rateType,
          status: normalized.status,
          rows: normalizedRowsForSave,
          debugLog: (stage, details = {}) =>
            logLabourRateSaveDebug(req, `bulk_upsert:service_${stage}`, {
              traceId,
              ...details,
            }),
        });
      });
      logLabourRateSaveDebug(req, "bulk_upsert:db_write_success", {
        traceId,
        created: result.created,
        updated: result.updated,
        rowsCount: normalized.rows.length,
        durationMs: Date.now() - writeStart,
        elapsedMs: Date.now() - startedAt,
      });

      queueAuditLog(req, {
        entityType: labourRatesPage.entityType,
        entityId: normalized.labourSelection?.all
          ? "ALL"
          : normalized.labourSelection?.labourId || "NEW",
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
      logLabourRateSaveDebug(req, "bulk_upsert:exception", {
        traceId,
        error: err?.message || String(err),
        elapsedMs: Date.now() - startedAt,
      });
      console.error("Error in LabourRateRulesService:", err);
      return res
        .status(400)
        .json({ message: err?.message || res.locals.t("generic_error") });
    }
  },
);

ratesRouter.use("/", createHrMasterRouter(labourRatesPage));
router.use("/rates", ratesRouter);
router.use("/", createHrMasterRouter(page));

router.preview = {
  page,
  labourRatesPage,
  hydratePage,
};

module.exports = router;
