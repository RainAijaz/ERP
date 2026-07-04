const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");
const {
  requirePermission,
  canAccessScope,
} = require("../../../middleware/access/role-permissions");
const {
  parseCookies,
  setCookie,
} = require("../../../middleware/utils/cookies");
const {
  friendlyErrorMessage,
} = require("../../../middleware/errors/friendly-error");
const {
  handleScreenApproval,
} = require("../../../middleware/approvals/screen-approval");
const {
  getBasicInfoEntityType,
} = require("../../../utils/approval-entity-map");
const { queueAuditLog } = require("../../../utils/audit-log");
const { generateUniqueCode } = require("../../../utils/entity-code");
const { buildAuditChangeSet } = require("../../../utils/audit-diff");

const router = express.Router();

const normalizeCredit = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isNaN(numberValue) ? null : numberValue;
};

const toPositiveIntOrNull = (value) => {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return null;
  return num;
};

const buildProductionStageCode = (deptId) => {
  const normalizedDeptId = toPositiveIntOrNull(deptId);
  return normalizedDeptId ? `DEPT_${normalizedDeptId}` : null;
};

const hasField = (page, name) =>
  page.fields.some((field) => field.name === name);

const getEntityLabel = (...rows) => {
  for (const row of rows) {
    const label = row && (row.name || row.name_en || row.code || row.title);
    if (label) return String(label);
  }
  return "";
};

const withLabel = (summary, ...rows) => {
  const label = getEntityLabel(...rows);
  return label ? `${summary} - ${label}` : summary;
};

// Page metadata drives form fields, table columns, and DB mapping.
const BASIC_INFO_PAGES = {
  units: {
    titleKey: "units",
    description: "desc_units",
    table: "erp.uom",
    translateMode: "transliterate",
    autoCodeFromName: true,
    columns: [
      { key: "id", label: "id" },
      { key: "code", label: "code" },
      { key: "name", label: "name" },
      { key: "name_ur", label: "name_ur" },
      { key: "is_active", label: "active", type: "boolean" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    fields: [
      {
        name: "name",
        label: "name",
        placeholder: "unit_name_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        placeholder: "urdu_name_placeholder",
        required: true,
      },
    ],
  },
  sizes: {
    titleKey: "sizes",
    description: "desc_sizes",
    table: "erp.sizes",
    translateMode: "transliterate",
    itemTypeMap: {
      table: "erp.size_item_types",
      key: "size_id",
    },
    columns: [
      { key: "id", label: "id" },
      { key: "name", label: "name" },
      { key: "name_ur", label: "name_ur" },
      { key: "item_types", label: "applies_to" },
      { key: "is_active", label: "active", type: "boolean" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    fields: [
      {
        name: "name",
        label: "size",
        placeholder: "size_name_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        placeholder: "urdu_name_placeholder",
        required: true,
      },
      {
        name: "item_types",
        label: "applies_to",
        type: "multi-checkbox",
        required: true,
        options: [
          { value: "RM", label: "raw_materials" },
          { value: "SFG", label: "semi_finished_goods" },
          { value: "FG", label: "finished_goods" },
        ],
      },
    ],
  },
  colors: {
    titleKey: "colors",
    description: "desc_colors",
    table: "erp.colors",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "id" },
      { key: "name", label: "name" },
      { key: "name_ur", label: "name_ur" },
      { key: "is_active", label: "active", type: "boolean" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    fields: [
      {
        name: "name",
        label: "color",
        placeholder: "color_name_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        placeholder: "urdu_name_placeholder",
        required: true,
      },
    ],
  },
  grades: {
    titleKey: "grades",
    description: "desc_grades",
    table: "erp.grades",
    translateMode: "transliterate",
    defaults: {
      grade_rank: 1,
    },
    columns: [
      { key: "id", label: "id" },
      { key: "name", label: "name" },
      { key: "name_ur", label: "name_ur" },
      { key: "grade_rank", label: "grade_rank" },
      { key: "is_active", label: "active", type: "boolean" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    fields: [
      {
        name: "name",
        label: "grade",
        placeholder: "grade_name_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        placeholder: "urdu_name_placeholder",
        required: true,
      },
      {
        name: "grade_rank",
        label: "grade_rank",
        type: "number",
        placeholder: "grade_rank_placeholder",
        required: true,
      },
    ],
  },
  "packing-types": {
    titleKey: "packing_types",
    description: "desc_packing_types",
    table: "erp.packing_types",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "id" },
      { key: "name", label: "name" },
      { key: "name_ur", label: "name_ur" },
      { key: "is_active", label: "active", type: "boolean" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    fields: [
      {
        name: "name",
        label: "packing_type",
        placeholder: "packing_type_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        placeholder: "urdu_name_placeholder",
        required: true,
      },
    ],
  },
  cities: {
    titleKey: "cities",
    description: "desc_cities",
    table: "erp.cities",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "id" },
      { key: "name", label: "name" },
      { key: "name_ur", label: "name_ur" },
      { key: "is_active", label: "active", type: "boolean" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    fields: [
      {
        name: "name",
        label: "city",
        placeholder: "city_name_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        placeholder: "urdu_name_placeholder",
        required: true,
      },
    ],
  },
  groups: {
    titleKey: "product_groups",
    description: "desc_product_groups",
    table: "erp.product_groups",
    translateMode: "transliterate",
    itemTypeMap: {
      table: "erp.product_group_item_types",
      key: "group_id",
    },
    columns: [
      { key: "id", label: "id" },
      { key: "name", label: "name" },
      { key: "name_ur", label: "name_ur" },
      { key: "item_types", label: "applies_to" },
      { key: "is_active", label: "active", type: "boolean" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    defaults: {
      is_active: true,
      item_types: ["RM", "SFG", "FG"],
    },
    fields: [
      {
        name: "name",
        label: "group_name",
        placeholder: "product_group_name_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        placeholder: "urdu_name_placeholder",
        required: true,
      },
      {
        name: "item_types",
        label: "applies_to",
        type: "multi-checkbox",
        required: true,
        options: [
          { value: "RM", label: "raw_materials" },
          { value: "SFG", label: "semi_finished_goods" },
          { value: "FG", label: "finished_goods" },
        ],
      },
    ],
  },
  "product-subgroups": {
    titleKey: "product_subgroups",
    description: "desc_product_subgroups",
    table: "erp.product_subgroups",
    translateMode: "transliterate",
    autoCodeFromName: true,
    itemTypeMap: {
      table: "erp.product_subgroup_item_types",
      key: "subgroup_id",
    },
    columns: [
      { key: "id", label: "id" },
      { key: "code", label: "code" },
      { key: "name", label: "name" },
      { key: "name_ur", label: "name_ur" },
      { key: "item_types", label: "applies_to" },
      { key: "is_active", label: "active", type: "boolean" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    fields: [
      {
        name: "name",
        label: "subgroup_name",
        placeholder: "subgroup_name_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        placeholder: "urdu_name_placeholder",
        required: true,
      },
      {
        name: "item_types",
        label: "applies_to",
        type: "multi-checkbox",
        required: true,
        options: [
          { value: "RM", label: "raw_materials" },
          { value: "SFG", label: "semi_finished_goods" },
          { value: "FG", label: "finished_goods" },
        ],
      },
    ],
  },
  "product-types": {
    titleKey: "product_types",
    description: "desc_product_types",
    table: "erp.product_types",
    translateMode: "transliterate",
    autoCodeFromName: true,
    columns: [
      { key: "id", label: "id" },
      { key: "code", label: "code" },
      { key: "name", label: "name" },
      { key: "name_ur", label: "name_ur" },
      { key: "is_active", label: "active", type: "boolean" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    fields: [
      {
        name: "name",
        label: "product_type",
        placeholder: "product_type_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        placeholder: "urdu_name_placeholder",
        required: true,
      },
    ],
  },
  "sales-discount-policies": {
    titleKey: "sales_discount_policies",
    description: "desc_sales_discount_policies",
    table: "erp.sales_discount_policy",
    joins: [
      {
        table: { pg: "erp.product_groups" },
        on: ["t.product_group_id", "pg.id"],
      },
    ],
    extraSelect: (locale) => [
      locale === "ur"
        ? knex.raw("COALESCE(pg.name_ur, pg.name) as product_group_name")
        : "pg.name as product_group_name",
      knex.raw(
        "CASE WHEN t.is_active THEN 'Active' ELSE 'Inactive' END as policy_status",
      ),
    ],
    columns: [
      { key: "id", label: "id" },
      { key: "product_group_name", label: "product_group" },
      { key: "max_pair_discount", label: "max_pair_discount" },
      { key: "policy_status", label: "status" },
    ],
    defaults: {
      is_active: true,
    },
    fields: [
      {
        name: "product_group_id",
        label: "product_group",
        type: "select",
        required: true,
        optionsQuery: {
          table: "erp.product_groups",
          valueKey: "id",
          labelKey: "name",
          orderBy: "name",
        },
      },
      {
        name: "max_pair_discount",
        label: "max_pair_discount",
        type: "number",
        required: true,
        min: "0",
        step: "0.01",
      },
      {
        name: "is_active",
        label: "is_active",
        type: "checkbox",
      },
    ],
  },
  "party-groups": {
    titleKey: "party_groups",
    description: "desc_party_groups",
    table: "erp.party_groups",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "id" },
      { key: "party_type", label: "type" },
      { key: "name", label: "name" },
      { key: "name_ur", label: "name_ur" },
      { key: "is_active", label: "active", type: "boolean" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    fields: [
      {
        name: "party_type",
        label: "group_type",
        type: "select",
        required: true,
        options: [
          { value: "CUSTOMER", label: "customer" },
          { value: "SUPPLIER", label: "supplier" },
          { value: "BOTH", label: "both" },
        ],
      },
      {
        name: "name",
        label: "party_name",
        placeholder: "party_group_name_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        placeholder: "urdu_name_placeholder",
        required: true,
      },
    ],
  },
  "account-groups": {
    titleKey: "account_groups",
    description: "desc_account_groups",
    table: "erp.account_groups",
    translateMode: "transliterate",
    autoCodeFromName: true,
    columns: [
      { key: "id", label: "id" },
      { key: "account_type", label: "type" },
      { key: "code", label: "code" },
      { key: "name", label: "group_name" },
      { key: "name_ur", label: "name_ur" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    fields: [
      {
        name: "account_type",
        label: "account_type",
        helpText: "account_type_help",
        type: "select",
        required: true,
        options: [
          { value: "ASSET", label: "asset" },
          { value: "LIABILITY", label: "liability" },
          { value: "EQUITY", label: "equity" },
          { value: "REVENUE", label: "revenue" },
          { value: "EXPENSE", label: "expense" },
        ],
      },
      {
        name: "name",
        label: "name",
        helpText: "account_group_name_help",
        placeholder: "account_group_name_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        helpText: "urdu_name_help",
        placeholder: "urdu_name_placeholder",
        required: true,
      },
    ],
  },
  departments: {
    titleKey: "departments",
    description: "desc_departments",
    table: "erp.departments",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "id" },
      { key: "name", label: "name" },
      { key: "name_ur", label: "name_ur" },
      { key: "is_production", label: "production", type: "boolean" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    defaults: {
      is_production: false,
    },
    fields: [
      {
        name: "name",
        label: "department",
        placeholder: "department_name_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        placeholder: "urdu_name_placeholder",
        required: true,
      },
      {
        name: "is_production",
        label: "production_department",
        type: "checkbox",
      },
    ],
  },
  "production-stages": {
    titleKey: "production_stages",
    description: "desc_production_stages",
    table: "erp.production_stages",
    translateMode: "transliterate",
    joins: [{ table: { d: "erp.departments" }, on: ["t.dept_id", "d.id"] }],
    extraSelect: (locale) => [
      locale === "ur"
        ? knex.raw("COALESCE(d.name_ur, d.name) as dept_name")
        : "d.name as dept_name",
    ],
    columns: [
      { key: "id", label: "id" },
      { key: "name", label: "name" },
      { key: "name_ur", label: "name_ur" },
      { key: "dept_name", label: "department" },
      { key: "is_active", label: "active", type: "boolean" },
      { key: "created_by_name", label: "created_by" },
      { key: "created_at", label: "created_at" },
    ],
    defaults: {
      is_active: true,
    },
    fields: [
      {
        name: "name",
        label: "name",
        placeholder: "production_stage_placeholder",
        required: true,
      },
      {
        name: "name_ur",
        label: "name_ur",
        placeholder: "urdu_name_placeholder",
        required: false,
      },
      {
        name: "dept_id",
        label: "department",
        type: "select",
        required: true,
        optionsQuery: {
          table: "erp.departments",
          valueKey: "id",
          labelKey: "name",
          orderBy: "name",
          where: { is_active: true, is_production: true },
        },
      },
      {
        name: "is_active",
        label: "is_active",
        type: "checkbox",
      },
    ],
  },
};

const getPageConfig = (key) => BASIC_INFO_PAGES[key];

// Resolve dynamic select options (e.g., group lists) before rendering.
const ACTIVE_OPTION_TABLES = new Set([
  "erp.party_groups",
  "erp.account_groups",
  "erp.product_groups",
  "erp.product_subgroups",
  "erp.cities",
  "erp.branches",
  "erp.departments",
  "erp.grades",
  "erp.packing_types",
  "erp.sizes",
  "erp.colors",
  "erp.uom",
]);

const hydratePage = async (page, locale) => {
  const fields = [];
  for (const field of page.fields) {
    if (!field.optionsQuery) {
      fields.push(field);
      continue;
    }
    const selectFields = field.optionsQuery.select || [
      field.optionsQuery.valueKey,
      field.optionsQuery.labelKey,
    ];
    let query = knex(field.optionsQuery.table).select(selectFields);
    if (
      field.optionsQuery.activeOnly !== false &&
      ACTIVE_OPTION_TABLES.has(field.optionsQuery.table)
    ) {
      query = query.where({ is_active: true });
    }
    if (field.optionsQuery.where) {
      query = query.where(field.optionsQuery.where);
    }
    if (
      page.table === "erp.production_stages" &&
      field.name === "dept_id" &&
      field.optionsQuery.table === "erp.departments"
    ) {
      query = query.where({ is_production: true });
    }
    const rows = await query.orderBy(
      field.optionsQuery.orderBy || field.optionsQuery.labelKey,
    );
    fields.push({
      ...field,
      options: rows.map((row) => {
        const labelRaw = field.labelFormat
          ? field.labelFormat(row, locale)
          : row[field.optionsQuery.labelKey];
        const labelUr =
          !field.labelFormat && locale === "ur" && row.name_ur
            ? row.name_ur
            : null;
        return {
          value: row[field.optionsQuery.valueKey],
          label: labelUr || labelRaw,
        };
      }),
    });
  }
  return { ...page, fields };
};

Object.values(BASIC_INFO_PAGES).forEach((page) => {
  page.columns = (page.columns || [])
    .filter((column) => column.key !== "is_active")
    .filter(
      (column) =>
        column.key !== "created_by_name" && column.key !== "created_at",
    );
});

const renderPage = (req, res, view, page, extra = {}) =>
  res.render("base/layouts/main", {
    title: `${res.locals.t(page.titleKey)} - Basic Info`,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    isAdmin: req.user?.isAdmin || false,
    csrfToken: res.locals.csrfToken,
    view,
    t: res.locals.t,
    page,
    ...extra,
  });

// Build the list query with optional joins and item-type aggregation.
const fetchRows = (page, options = {}) => {
  let query = knex({ t: page.table }).leftJoin(
    { u: "erp.users" },
    "t.created_by",
    "u.id",
  );
  if (page.hasUpdatedFields !== false) {
    query = query.leftJoin({ uu: "erp.users" }, "t.updated_by", "uu.id");
  }
  if (page.joins) {
    page.joins.forEach((join) => {
      query = query.leftJoin(join.table, join.on[0], join.on[1]);
    });
  }
  if (page.branchScoped && options.branchId) {
    if (page.branchMap) {
      query = query.where((builder) => {
        builder
          .whereExists(function () {
            this.select(1)
              .from(page.branchMap.table)
              .whereRaw(`${page.branchMap.table}.${page.branchMap.key} = t.id`)
              .andWhere(
                `${page.branchMap.table}.${page.branchMap.branchKey}`,
                options.branchId,
              );
          })
          .orWhere("t.branch_id", options.branchId);
      });
    } else {
      query = query.where("t.branch_id", options.branchId);
    }
  }
  if (page.itemTypeMap) {
    query = query.leftJoin(
      { pgt: page.itemTypeMap.table },
      "t.id",
      `pgt.${page.itemTypeMap.key}`,
    );
  }
  const selects = ["t.*", "u.username as created_by_name"];
  if (page.hasUpdatedFields !== false) {
    selects.push("uu.username as updated_by_name");
  }
  let extraSelect = page.extraSelect
    ? typeof page.extraSelect === "function"
      ? page.extraSelect(options.locale || "en")
      : page.extraSelect
    : [];
  if (!Array.isArray(extraSelect)) {
    extraSelect = [extraSelect];
  }
  if (extraSelect.length) {
    selects.push(...extraSelect);
  }
  if (page.itemTypeMap) {
    const extraGroupBys = extraSelect
      .map((select) => {
        if (typeof select === "string") {
          return select.split(/\s+as\s+/i)[0].trim();
        }
        if (select && typeof select.toString === "function") {
          return select;
        }
        return null;
      })
      .filter(Boolean);
    selects.push(
      knex.raw(
        "COALESCE(string_agg(pgt.item_type::text, ', ' ORDER BY pgt.item_type), '') as item_types",
      ),
    );
    return query
      .select(selects)
      .groupBy(["t.id", "u.username", "uu.username", ...extraGroupBys])
      .orderBy("t.id", "desc");
  }
  return query.select(selects).orderBy("t.id", "desc");
};

const ROUTE_MAP = {
  units: "/units",
  sizes: "/sizes",
  colors: "/colors",
  grades: "/grades",
  "packing-types": "/packing-types",
  cities: "/cities",
  groups: "/product-groups",
  "product-subgroups": "/product-subgroups",
  "product-types": "/product-types",
  "sales-discount-policies": "/sales-discount-policies",
  "party-groups": "/party-groups",
  "account-groups": "/account-groups",
  departments: "/departments",
  "production-stages": "/production-stages",
};

const BASIC_INFO_SCOPE_KEYS = {
  units: "master_data.basic_info.units",
  sizes: "master_data.basic_info.sizes",
  colors: "master_data.basic_info.colors",
  grades: "master_data.basic_info.grades",
  "packing-types": "master_data.basic_info.packing_types",
  cities: "master_data.basic_info.cities",
  groups: "master_data.basic_info.product_groups",
  "product-subgroups": "master_data.basic_info.product_subgroups",
  "product-types": "master_data.basic_info.product_types",
  "sales-discount-policies": "master_data.basic_info.sales_discount_policies",
  "party-groups": "master_data.basic_info.party_groups",
  "account-groups": "master_data.basic_info.account_groups",
  departments: "master_data.basic_info.departments",
  "production-stages": "master_data.basic_info.production_stages",
  "uom-conversions": "master_data.basic_info.uom_conversions",
};

const listHandler = (type) => async (req, res, next) => {
  const page = getPageConfig(type);
  if (!page) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  try {
    const hydrated = await hydratePage(page, req.locale);
    const flash = readFlash(req, res, req.baseUrl);
    const flashMatch = flash && flash.type === type ? flash : null;
    const modalMode = flashMatch ? flashMatch.modalMode : "create";
    const modalOpen = flashMatch
      ? ["create", "edit"].includes(modalMode)
      : false;
    const basePath = `${req.baseUrl}${ROUTE_MAP[type]}`;
    const defaults = { ...(hydrated.defaults || {}) };
    const scopeKey =
      BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`;
    const canBrowse = res.locals.can("SCREEN", scopeKey, "navigate");
    const rows = canBrowse
      ? await fetchRows(hydrated, {
          branchId: req.user?.isAdmin ? null : req.branchId,
          locale: req.locale,
        })
      : [];
    return renderPage(
      req,
      res,
      "../../master_data/basic-info/index",
      hydrated,
      {
        rows,
        basePath,
        scopeKey,
        values: flashMatch ? flashMatch.values : defaults,
        error: flashMatch ? flashMatch.error : null,
        modalOpen,
        modalMode,
      },
    );
  } catch (err) {
    return next(err);
  }
};

const newHandler = (type) => async (req, res, next) => {
  const page = getPageConfig(type);
  if (!page) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  try {
    const hydrated = await hydratePage(page, req.locale);
    const basePath = `${req.baseUrl}${ROUTE_MAP[type]}`;
    return renderPage(req, res, "../../master_data/basic-info/form", hydrated, {
      basePath,
      values: hydrated.defaults || {},
      error: null,
    });
  } catch (err) {
    return next(err);
  }
};

// Normalize form payloads to consistent shapes for inserts/updates.
const buildValues = (page, body) =>
  page.fields.reduce((acc, field) => {
    if (field.type === "checkbox") {
      acc[field.name] = body[field.name] === "on";
      return acc;
    }
    if (field.type === "multi-select" || field.type === "multi-checkbox") {
      const value = body[field.name];
      if (Array.isArray(value)) {
        acc[field.name] = value;
      } else if (value && typeof value === "object") {
        acc[field.name] = Object.values(value);
      } else {
        acc[field.name] = value ? [value] : [];
      }
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

const FLASH_COOKIE = "basic_info_flash";

const clearFlash = (res, path) => {
  setCookie(res, FLASH_COOKIE, "", { path, maxAge: 0, sameSite: "Lax" });
  if (path && !path.endsWith("/")) {
    setCookie(res, FLASH_COOKIE, "", {
      path: `${path}/`,
      maxAge: 0,
      sameSite: "Lax",
    });
  }
};

const readFlash = (req, res, path) => {
  const cookies = parseCookies(req);
  if (!cookies[FLASH_COOKIE]) return null;
  let payload = null;
  try {
    payload = JSON.parse(cookies[FLASH_COOKIE]);
  } catch (err) {
    payload = null;
  }
  clearFlash(res, path);
  return payload;
};

// Store a short-lived flash so modal + errors re-open after redirect.
const renderIndexError = async (
  req,
  res,
  page,
  values,
  error,
  modalMode,
  basePath,
  type,
) => {
  const message = friendlyErrorMessage(error, res.locals.t);
  const payload = { type, values, error: message, modalMode };
  setCookie(res, FLASH_COOKIE, JSON.stringify(payload), {
    path: req.baseUrl,
    maxAge: 60,
    sameSite: "Lax",
  });
  if (modalMode === "delete") {
    setCookie(res, "ui_error", JSON.stringify({ message }), {
      path: "/",
      maxAge: 30,
      sameSite: "Lax",
    });
  }
  return res.redirect(basePath);
};

const createHandler = (type) => async (req, res, next) => {
  const page = getPageConfig(type);
  if (!page) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  const values = buildValues(page, req.body);
  if (type === "product-subgroups") {
    values.group_id = null;
  }
  if (!hasField(page, "code") && !page.autoCodeFromName) {
    delete values.code;
  }
  const missing = page.fields
    .filter((field) => field.required)
    .filter((field) => !values[field.name]);
  const basePath = `${req.baseUrl}${ROUTE_MAP[type]}`;

  if (missing.length) {
    return renderIndexError(
      req,
      res,
      page,
      values,
      res.locals.t("error_required_fields"),
      "create",
      basePath,
      type,
    );
  }

  try {
    if (type === "production-stages") {
      const deptId = toPositiveIntOrNull(values.dept_id);
      if (!deptId) {
        return renderIndexError(
          req,
          res,
          page,
          values,
          res.locals.t("error_required_fields"),
          "create",
          basePath,
          type,
        );
      }
      const dept = await knex("erp.departments")
        .select("id", "is_active", "is_production")
        .where({ id: deptId })
        .first();
      if (!dept || !dept.is_active || !dept.is_production) {
        return renderIndexError(
          req,
          res,
          page,
          values,
          res.locals.t("bom_error_department_must_be_production"),
          "create",
          basePath,
          type,
        );
      }
      values.dept_id = deptId;
      values.code = buildProductionStageCode(deptId);
      if (!values.code) {
        return renderIndexError(
          req,
          res,
          page,
          values,
          res.locals.t("error_required_fields"),
          "create",
          basePath,
          type,
        );
      }
      if (values.is_active !== false) {
        const existingActiveForDept = await knex("erp.production_stages")
          .select("id")
          .where({ dept_id: deptId, is_active: true })
          .first();
        if (existingActiveForDept) {
          return renderIndexError(
            req,
            res,
            page,
            values,
            "This production department already has an active stage.",
            "create",
            basePath,
            type,
          );
        }
      }
    }

    if (hasField(page, "code") || page.autoCodeFromName) {
      values.code = await generateUniqueCode({
        name: values.name,
        prefix: type,
        maxLen: 50,
        knex,
        table: page.table,
      });
    }
    if (page.table === "erp.uom") {
      const codeValue = (values.code || "").trim();
      if (codeValue) {
        const existing = await knex(page.table)
          .whereRaw("lower(code) = ?", [codeValue.toLowerCase()])
          .first();
        if (existing) {
          return renderIndexError(
            req,
            res,
            page,
            values,
            res.locals.t("unit_code_exists"),
            "create",
            basePath,
            type,
          );
        }
      }
    }
    if (page.itemTypeMap) {
      const { item_types: itemTypes = [], ...rest } = values;
      if (!itemTypes.length) {
        return renderIndexError(
          req,
          res,
          page,
          values,
          res.locals.t("error_required_fields"),
          "create",
          basePath,
          type,
        );
      }
      const approval = await handleScreenApproval({
        req,
        scopeKey:
          BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`,
        action: "create",
        entityType: getBasicInfoEntityType(type),
        entityId: "NEW",
        summary: withLabel(
          `${res.locals.t("create")} ${res.locals.t(page.titleKey)}`,
          values,
        ),
        oldValue: null,
        newValue: values,
        t: res.locals.t,
      });

      if (approval.queued) {
        return res.redirect(req.get("referer") || basePath);
      }

      await knex.transaction(async (trx) => {
        // Insert the main record, then map each selected item type.
        const [row] = await trx(page.table)
          .insert({
            ...rest,
            created_by: req.user ? req.user.id : null,
          })
          .returning("id");
        const groupId = row && row.id ? row.id : row;
        if (itemTypes.length) {
          await trx(page.itemTypeMap.table).insert(
            itemTypes.map((itemType) => ({
              [page.itemTypeMap.key]: groupId,
              item_type: itemType,
            })),
          );
        }
        queueAuditLog(req, {
          entityType: getBasicInfoEntityType(type),
          entityId: groupId,
          action: "CREATE",
        });
      });
    } else {
      if (page.branchMap) {
        const { branch_ids: branchIds = [], ...rest } = values;
        const approval = await handleScreenApproval({
          req,
          scopeKey:
            BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`,
          action: "create",
          entityType: getBasicInfoEntityType(type),
          entityId: "NEW",
          summary: withLabel(
            `${res.locals.t("create")} ${res.locals.t(page.titleKey)}`,
            values,
          ),
          oldValue: null,
          newValue: values,
          t: res.locals.t,
        });

        if (approval.queued) {
          return res.redirect(req.get("referer") || basePath);
        }

        await knex.transaction(async (trx) => {
          const [row] = await trx(page.table)
            .insert({
              ...rest,
              created_by: req.user ? req.user.id : null,
            })
            .returning("id");
          const accountId = row && row.id ? row.id : row;
          if (branchIds.length) {
            await trx(page.branchMap.table).insert(
              branchIds.map((branchId) => ({
                [page.branchMap.key]: accountId,
                [page.branchMap.branchKey]: branchId,
              })),
            );
          }
          queueAuditLog(req, {
            entityType: getBasicInfoEntityType(type),
            entityId: accountId,
            action: "CREATE",
          });
        });
      } else {
        const approval = await handleScreenApproval({
          req,
          scopeKey:
            BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`,
          action: "create",
          entityType: getBasicInfoEntityType(type),
          entityId: "NEW",
          summary: withLabel(
            `${res.locals.t("create")} ${res.locals.t(page.titleKey)}`,
            values,
          ),
          oldValue: null,
          newValue: values,
          t: res.locals.t,
        });

        if (approval.queued) {
          return res.redirect(req.get("referer") || basePath);
        }

        const insertValues = {
          ...values,
          created_by: req.user ? req.user.id : null,
        };
        const [row] = await knex(page.table)
          .insert(insertValues)
          .returning("id");
        const createdId = row && row.id ? row.id : row;
        queueAuditLog(req, {
          entityType: getBasicInfoEntityType(type),
          entityId: createdId,
          action: "CREATE",
        });
      }
    }
    return res.redirect(basePath);
  } catch (err) {
    console.error("[basic-info:create]", { type, error: err });
    return renderIndexError(
      req,
      res,
      page,
      values,
      err?.message || res.locals.t("error_unable_save"),
      "create",
      basePath,
      type,
    );
  }
};

const updateHandler = (type) => async (req, res, next) => {
  const page = getPageConfig(type);
  const id = Number(req.params.id);
  if (!page || !id) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  const values = buildValues(page, req.body);
  if (type === "product-subgroups") {
    values.group_id = null;
  }
  if (!hasField(page, "code") && !page.autoCodeFromName) {
    delete values.code;
  }
  const missing = page.fields
    .filter((field) => field.required)
    .filter((field) => !values[field.name]);

  const basePath = `${req.baseUrl}${ROUTE_MAP[type]}`;

  if (missing.length) {
    return renderIndexError(
      req,
      res,
      page,
      values,
      res.locals.t("error_required_fields"),
      "edit",
      basePath,
      type,
    );
  }

  try {
    const existingRow = await knex(page.table).where({ id }).first();
    if (!existingRow) {
      return renderIndexError(
        req,
        res,
        page,
        values,
        res.locals.t("error_not_found"),
        "edit",
        basePath,
        type,
      );
    }
    if (type === "production-stages") {
      const deptId = toPositiveIntOrNull(values.dept_id);
      if (!deptId) {
        return renderIndexError(
          req,
          res,
          page,
          values,
          res.locals.t("error_required_fields"),
          "edit",
          basePath,
          type,
        );
      }
      const dept = await knex("erp.departments")
        .select("id", "is_active", "is_production")
        .where({ id: deptId })
        .first();
      if (!dept || !dept.is_active || !dept.is_production) {
        return renderIndexError(
          req,
          res,
          page,
          values,
          res.locals.t("bom_error_department_must_be_production"),
          "edit",
          basePath,
          type,
        );
      }
      values.dept_id = deptId;
      values.code = buildProductionStageCode(deptId);
      if (!values.code) {
        return renderIndexError(
          req,
          res,
          page,
          values,
          res.locals.t("error_required_fields"),
          "edit",
          basePath,
          type,
        );
      }
      if (values.is_active !== false) {
        const existingActiveForDept = await knex("erp.production_stages")
          .select("id")
          .where({ dept_id: deptId, is_active: true })
          .whereNot({ id })
          .first();
        if (existingActiveForDept) {
          return renderIndexError(
            req,
            res,
            page,
            values,
            "This production department already has an active stage.",
            "edit",
            basePath,
            type,
          );
        }
      }
    } else if (existingRow.code) {
      values.code = existingRow.code;
    } else if (hasField(page, "code") || page.autoCodeFromName) {
      values.code = await generateUniqueCode({
        name: values.name,
        prefix: type,
        maxLen: 50,
        knex,
        table: page.table,
        excludeId: id,
      });
    }

    if (page.table === "erp.uom") {
      const existing = await knex(page.table)
        .select("code")
        .where({ id })
        .first();
      if (existing && existing.code !== values.code) {
        const usedInItems = await knex("erp.items")
          .where({ base_uom_id: id })
          .first();
        const usedInConversions = await knex("erp.uom_conversions")
          .where({ from_uom_id: id })
          .orWhere({ to_uom_id: id })
          .first();
        if (usedInItems || usedInConversions) {
          return renderIndexError(
            req,
            res,
            page,
            values,
            res.locals.t("error_unit_code_locked"),
            "edit",
            basePath,
            type,
          );
        }
      }
    }
    if (page.itemTypeMap) {
      const { item_types: itemTypes = [], ...rest } = values;
      if (!itemTypes.length) {
        return renderIndexError(
          req,
          res,
          page,
          values,
          res.locals.t("error_required_fields"),
          "edit",
          basePath,
          type,
        );
      }
      const approval = await handleScreenApproval({
        req,
        scopeKey:
          BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`,
        action: "edit",
        entityType: getBasicInfoEntityType(type),
        entityId: id,
        summary: withLabel(
          `${res.locals.t("edit")} ${res.locals.t(page.titleKey)}`,
          values,
          existingRow,
        ),
        oldValue: existingRow,
        newValue: values,
        t: res.locals.t,
      });

      if (approval.queued) {
        return res.redirect(req.get("referer") || basePath);
      }
      const changeSet = buildAuditChangeSet({
        before: existingRow,
        after: values,
        includeKeys: page.fields.map((field) => field.name),
      });
      const auditFields =
        page.hasUpdatedFields === false
          ? {}
          : {
              updated_by: req.user ? req.user.id : null,
              updated_at: knex.fn.now(),
            };
      await knex.transaction(async (trx) => {
        // Update the main row, then replace item type mappings.
        await trx(page.table)
          .where({ id })
          .update({
            ...rest,
            ...auditFields,
          });
        await trx(page.itemTypeMap.table)
          .where({ [page.itemTypeMap.key]: id })
          .del();
        if (itemTypes.length) {
          await trx(page.itemTypeMap.table).insert(
            itemTypes.map((itemType) => ({
              [page.itemTypeMap.key]: id,
              item_type: itemType,
            })),
          );
        }
        queueAuditLog(req, {
          entityType: getBasicInfoEntityType(type),
          entityId: id,
          action: "UPDATE",
          context: {
            source: "basic-info-update",
            ...changeSet,
          },
        });
      });
    } else {
      const auditFields =
        page.hasUpdatedFields === false
          ? {}
          : {
              updated_by: req.user ? req.user.id : null,
              updated_at: knex.fn.now(),
            };
      if (page.branchMap) {
        const { branch_ids: branchIds = [], ...rest } = values;
        const approval = await handleScreenApproval({
          req,
          scopeKey:
            BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`,
          action: "edit",
          entityType: getBasicInfoEntityType(type),
          entityId: id,
          summary: withLabel(
            `${res.locals.t("edit")} ${res.locals.t(page.titleKey)}`,
            values,
            existingRow,
          ),
          oldValue: existingRow,
          newValue: values,
          t: res.locals.t,
        });

        if (approval.queued) {
          return res.redirect(req.get("referer") || basePath);
        }
        const changeSet = buildAuditChangeSet({
          before: existingRow,
          after: values,
          includeKeys: page.fields.map((field) => field.name),
        });
        await knex.transaction(async (trx) => {
          await trx(page.table)
            .where({ id })
            .update({
              ...rest,
              ...auditFields,
            });
          await trx(page.branchMap.table)
            .where({ [page.branchMap.key]: id })
            .del();
          if (branchIds.length) {
            await trx(page.branchMap.table).insert(
              branchIds.map((branchId) => ({
                [page.branchMap.key]: id,
                [page.branchMap.branchKey]: branchId,
              })),
            );
          }
          queueAuditLog(req, {
            entityType: getBasicInfoEntityType(type),
            entityId: id,
            action: "UPDATE",
            context: {
              source: "basic-info-update",
              ...changeSet,
            },
          });
        });
      } else {
        const approval = await handleScreenApproval({
          req,
          scopeKey:
            BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`,
          action: "edit",
          entityType: getBasicInfoEntityType(type),
          entityId: id,
          summary: withLabel(
            `${res.locals.t("edit")} ${res.locals.t(page.titleKey)}`,
            values,
            existingRow,
          ),
          oldValue: existingRow,
          newValue: values,
          t: res.locals.t,
        });

        if (approval.queued) {
          return res.redirect(req.get("referer") || basePath);
        }
        const changeSet = buildAuditChangeSet({
          before: existingRow,
          after: values,
          includeKeys: page.fields.map((field) => field.name),
        });
        await knex(page.table)
          .where({ id })
          .update({
            ...values,
            ...auditFields,
          });
        queueAuditLog(req, {
          entityType: getBasicInfoEntityType(type),
          entityId: id,
          action: "UPDATE",
          context: {
            source: "basic-info-update",
            ...changeSet,
          },
        });
      }
    }
    return res.redirect(basePath);
  } catch (err) {
    console.error("[basic-info:update]", { type, id, error: err });
    return renderIndexError(
      req,
      res,
      page,
      values,
      err?.message || res.locals.t("error_unable_save"),
      "edit",
      basePath,
      type,
    );
  }
};

const toggleHandler = (type) => async (req, res, next) => {
  const page = getPageConfig(type);
  const id = Number(req.params.id);
  if (!page || !id) {
    return next(new HttpError(404, "Basic information page not found"));
  }
  const basePath = `${req.baseUrl}${ROUTE_MAP[type]}`;

  try {
    const current = await knex(page.table).where({ id }).first();
    if (!current) {
      return next(new HttpError(404, "Record not found"));
    }
    const scopeKey =
      BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`;
    const entityType = getBasicInfoEntityType(type);
    const summary = withLabel(
      `${res.locals.t("deactivate")} ${res.locals.t(page.titleKey)}`,
      current,
    );
    const approval = await handleScreenApproval({
      req,
      scopeKey,
      action: "delete",
      entityType,
      entityId: id,
      summary,
      oldValue: current,
      newValue: { is_active: !current.is_active },
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }
    const auditFields =
      page.hasUpdatedFields === false
        ? {}
        : {
            updated_by: req.user ? req.user.id : null,
            updated_at: knex.fn.now(),
          };
    await knex(page.table)
      .where({ id })
      .update({
        is_active: !current.is_active,
        ...auditFields,
      });
    queueAuditLog(req, {
      entityType: getBasicInfoEntityType(type),
      entityId: id,
      action: "DELETE",
    });
    return res.redirect(basePath);
  } catch (err) {
    return renderIndexError(
      req,
      res,
      page,
      {},
      err?.message || res.locals.t("error_update_status"),
      "delete",
      basePath,
      type,
    );
  }
};

const deleteHandler = (type) => async (req, res, next) => {
  const page = getPageConfig(type);
  const id = Number(req.params.id);
  if (!page || !id) {
    return next(new HttpError(404, "Basic information page not found"));
  }
  const basePath = `${req.baseUrl}${ROUTE_MAP[type]}`;

  try {
    const existing = await knex(page.table).where({ id }).first();
    if (!existing) {
      return renderIndexError(
        req,
        res,
        page,
        {},
        res.locals.t("error_not_found"),
        "delete",
        basePath,
        type,
      );
    }
    const scopeKey =
      BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`;
    const entityType = getBasicInfoEntityType(type);
    const summary = withLabel(
      `${res.locals.t("delete")} ${res.locals.t(page.titleKey)}`,
      existing,
    );
    const approval = await handleScreenApproval({
      req,
      scopeKey,
      action: "delete",
      entityType,
      entityId: id,
      summary,
      oldValue: existing,
      newValue: null,
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }
    try {
      await knex(page.table).where({ id }).del();
    } catch (deleteErr) {
      if (String(deleteErr?.code || "") === "23503") {
        throw new HttpError(409, res.locals.t("error_record_in_use"));
      }
      throw deleteErr;
    }
    queueAuditLog(req, {
      entityType: getBasicInfoEntityType(type),
      entityId: id,
      action: "DELETE",
    });
    return res.redirect(basePath);
  } catch (err) {
    return renderIndexError(
      req,
      res,
      page,
      {},
      err?.message || res.locals.t("error_delete"),
      "delete",
      basePath,
      type,
    );
  }
};

Object.entries(ROUTE_MAP).forEach(([type, path]) => {
  const scopeKey =
    BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`;
  router.get(
    path,
    requirePermission("SCREEN", scopeKey, "view"),
    listHandler(type),
  );
  router.get(
    `${path}/new`,
    requirePermission("SCREEN", scopeKey, "create"),
    newHandler(type),
  );
  router.post(
    path,
    requirePermission("SCREEN", scopeKey, "create"),
    createHandler(type),
  );
  router.post(
    `${path}/:id`,
    requirePermission("SCREEN", scopeKey, "edit"),
    updateHandler(type),
  );
  router.post(
    `${path}/:id/toggle`,
    requirePermission("SCREEN", scopeKey, "delete"),
    toggleHandler(type),
  );
  router.post(
    `${path}/:id/delete`,
    requirePermission("SCREEN", scopeKey, "hard_delete"),
    deleteHandler(type),
  );
});

router.get(
  "/groups/products/product-groups",
  requirePermission("SCREEN", "master_data.basic_info.product_groups", "view"),
  (req, res) => {
    res.redirect(`${req.baseUrl}${ROUTE_MAP.groups}`);
  },
);
router.get(
  "/groups/products/product-subgroups",
  requirePermission(
    "SCREEN",
    "master_data.basic_info.product_subgroups",
    "view",
  ),
  (req, res) => {
    res.redirect(`${req.baseUrl}${ROUTE_MAP["product-subgroups"]}`);
  },
);
router.get(
  "/groups/products/product-types",
  requirePermission("SCREEN", "master_data.basic_info.product_types", "view"),
  (req, res) => {
    res.redirect(`${req.baseUrl}${ROUTE_MAP["product-types"]}`);
  },
);
router.get(
  "/groups/party-groups",
  requirePermission("SCREEN", "master_data.basic_info.party_groups", "view"),
  (req, res) => {
    res.redirect(`${req.baseUrl}${ROUTE_MAP["party-groups"]}`);
  },
);
router.get(
  "/groups/account-groups",
  requirePermission("SCREEN", "master_data.basic_info.account_groups", "view"),
  (req, res) => {
    res.redirect(`${req.baseUrl}${ROUTE_MAP["account-groups"]}`);
  },
);
router.get(
  "/groups/departments",
  requirePermission("SCREEN", "master_data.basic_info.departments", "view"),
  (req, res) => {
    res.redirect(`${req.baseUrl}${ROUTE_MAP.departments}`);
  },
);
router.get(
  "/groups/production-stages",
  requirePermission(
    "SCREEN",
    "master_data.basic_info.production_stages",
    "view",
  ),
  (req, res) => {
    res.redirect(`${req.baseUrl}${ROUTE_MAP["production-stages"]}`);
  },
);

router.get("/:type", (req, res, next) => {
  const target = ROUTE_MAP[req.params.type];
  if (target) {
    const scopeKey =
      BASIC_INFO_SCOPE_KEYS[req.params.type] ||
      `master_data.basic_info.${req.params.type}`;
    if (!canAccessScope(req, "SCREEN", scopeKey, "view")) {
      return next(
        new HttpError(
          403,
          (typeof res?.locals?.t === "function" &&
            (res.locals.t("permission_denied") || "").trim()) ||
            "Permission denied",
        ),
      );
    }
    return res.redirect(`${req.baseUrl}${target}`);
  }
  return next(new HttpError(404, "Basic information page not found"));
});

router.preview = {
  getPageConfig,
  hydratePage,
};

module.exports = router;
