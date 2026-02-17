const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");
const { requirePermission } = require("../../../middleware/access/role-permissions");
const { parseCookies, setCookie } = require("../../../middleware/utils/cookies");
const { friendlyErrorMessage } = require("../../../middleware/errors/friendly-error");
const { handleScreenApproval } = require("../../../middleware/approvals/screen-approval");
const { getBasicInfoEntityType } = require("../../../utils/approval-entity-map");
const { queueAuditLog } = require("../../../utils/audit-log");
const { generateUniqueCode } = require("../../../utils/entity-code");
const { buildAuditChangeSet } = require("../../../utils/audit-diff");

const router = express.Router();

const normalizeCredit = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isNaN(numberValue) ? null : numberValue;
};

const hasField = (page, name) => page.fields.some((field) => field.name === name);

// Page metadata drives form fields, table columns, and DB mapping.
const BASIC_INFO_PAGES = {
  units: {
    titleKey: "units",
    description: "Define the units of measure used across items, vouchers, and stock.",
    table: "erp.uom",
    translateMode: "transliterate",
    autoCodeFromName: true,
    columns: [
      { key: "id", label: "ID" },
      { key: "code", label: "Code" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "name",
        label: "Name",
        placeholder: "Pieces, Dozen, Kilogram",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
    ],
  },
  sizes: {
    titleKey: "sizes",
    description: "Size labels used in variants (e.g., 7/10, 9/10).",
    table: "erp.sizes",
    translateMode: "transliterate",
    itemTypeMap: {
      table: "erp.size_item_types",
      key: "size_id",
    },
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "item_types", label: "Applies To" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "name",
        label: "Size",
        placeholder: "7/10, 40, 41",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
      {
        name: "item_types",
        label: "Applies To",
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
    description: "Color options for raw materials and finished variants.",
    table: "erp.colors",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "name",
        label: "Color",
        placeholder: "Black, White, Mix",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
    ],
  },
  grades: {
    titleKey: "grades",
    description: "Quality grades for product variants.",
    table: "erp.grades",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "name",
        label: "Grade",
        placeholder: "A, B, C",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
    ],
  },
  "packing-types": {
    titleKey: "packing_types",
    description: "Packaging types for packed stock and variant rules.",
    table: "erp.packing_types",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "name",
        label: "Packing Type",
        placeholder: "Thaili, Box, Carton",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
    ],
  },
  cities: {
    titleKey: "cities",
    description: "Maintain city master for party addresses and reporting.",
    table: "erp.cities",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "name",
        label: "City",
        placeholder: "Lahore, Karachi",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
    ],
  },
  groups: {
    titleKey: "groups",
    description: "Product group visibility for raw, semi-finished, and finished items.",
    table: "erp.product_groups",
    translateMode: "transliterate",
    itemTypeMap: {
      table: "erp.product_group_item_types",
      key: "group_id",
    },
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "item_types", label: "Applies To" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    defaults: {
      is_active: true,
      item_types: ["RM", "SFG", "FG"],
    },
    fields: [
      {
        name: "name",
        label: "Group Name",
        placeholder: "EVA, PU, Footwear",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
      {
        name: "item_types",
        label: "Applies To",
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
    description: "Define product sub-groups under a product group.",
    table: "erp.product_subgroups",
    translateMode: "transliterate",
    autoCodeFromName: true,
    itemTypeMap: {
      table: "erp.product_subgroup_item_types",
      key: "subgroup_id",
    },
    joins: [{ table: { pg: "erp.product_groups" }, on: ["t.group_id", "pg.id"] }],
    extraSelect: (locale) => [locale === "ur" ? knex.raw("COALESCE(pg.name_ur, pg.name) as group_name") : "pg.name as group_name"],
    columns: [
      { key: "id", label: "ID" },
      { key: "group_name", label: "Group" },
      { key: "code", label: "Code" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "item_types", label: "Applies To" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "group_id",
        label: "Group",
        type: "select",
        required: false,
        optionsQuery: {
          table: "erp.product_groups",
          valueKey: "id",
          labelKey: "name",
          orderBy: "name",
        },
      },
      {
        name: "name",
        label: "Subgroup Name",
        placeholder: "Ballman, Ragzeen ",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
      {
        name: "item_types",
        label: "Applies To",
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
    description: "Define product types (e.g., Slipper, Sandal, Pumpy).",
    table: "erp.product_types",
    translateMode: "transliterate",
    autoCodeFromName: true,
    columns: [
      { key: "id", label: "ID" },
      { key: "code", label: "Code" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "name",
        label: "Product Type",
        placeholder: "Slipper, Sandal, Pumpy",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
    ],
  },
  "party-groups": {
    titleKey: "party_groups",
    description: "Organize customers and suppliers into reusable party groups.",
    table: "erp.party_groups",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "ID" },
      { key: "party_type", label: "Type" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "party_type",
        label: "Group Type",
        type: "select",
        required: true,
        options: [
          { value: "CUSTOMER", label: "Customer" },
          { value: "SUPPLIER", label: "Supplier" },
          { value: "BOTH", label: "Both" },
        ],
      },
      {
        name: "name",
        label: "Party Name",
        placeholder: "Wholesale, Retail, Suppliers",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
    ],
  },
  "account-groups": {
    titleKey: "account_groups",
    description: "Define chart of account groups under standard account types.",
    table: "erp.account_groups",
    translateMode: "transliterate",
    autoCodeFromName: true,
    columns: [
      { key: "id", label: "ID" },
      { key: "account_type", label: "Type" },
      { key: "code", label: "Code" },
      { key: "name", label: "Group Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_contra", label: "Contra", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    defaults: {
      is_contra: false,
    },
    fields: [
      {
        name: "account_type",
        label: "Account Type",
        helpText: "Select the main classification (Asset, Liability, Equity, Revenue, Expense).",
        type: "select",
        required: true,
        options: [
          { value: "ASSET", label: "ASSET" },
          { value: "LIABILITY", label: "LIABILITY" },
          { value: "EQUITY", label: "EQUITY" },
          { value: "REVENUE", label: "REVENUE" },
          { value: "EXPENSE", label: "EXPENSE" },
        ],
      },
      {
        name: "name",
        label: "Name",
        helpText: "Name of the account group.",
        placeholder: "Cash & Bank, Trade Receivables",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        helpText: "Urdu display name for reports and screens.",
        placeholder: "Urdu name",
        required: true,
      },
      {
        name: "is_contra",
        label: "Contra Account",
        helpText: "Use for balances that offset their parent group.",
        type: "checkbox",
      },
    ],
  },
  departments: {
    titleKey: "departments",
    description: "Department master for production and non-production cost centers.",
    table: "erp.departments",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_production", label: "Production", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    defaults: {
      is_production: false,
    },
    fields: [
      {
        name: "name",
        label: "Department",
        placeholder: "Cutting, Stitching, Accounts",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
      {
        name: "is_production",
        label: "Production Department",
        type: "checkbox",
      },
    ],
  },
};

const getPageConfig = (key) => BASIC_INFO_PAGES[key];

// Resolve dynamic select options (e.g., group lists) before rendering.
const ACTIVE_OPTION_TABLES = new Set(["erp.party_groups", "erp.account_groups", "erp.product_groups", "erp.product_subgroups", "erp.cities", "erp.branches", "erp.departments", "erp.grades", "erp.packing_types", "erp.sizes", "erp.colors", "erp.uom"]);

const hydratePage = async (page, locale) => {
  const fields = [];
  for (const field of page.fields) {
    if (!field.optionsQuery) {
      fields.push(field);
      continue;
    }
    const selectFields = field.optionsQuery.select || [field.optionsQuery.valueKey, field.optionsQuery.labelKey];
    let query = knex(field.optionsQuery.table).select(selectFields);
    if (field.optionsQuery.activeOnly !== false && ACTIVE_OPTION_TABLES.has(field.optionsQuery.table)) {
      query = query.where({ is_active: true });
    }
    if (field.optionsQuery.where) {
      query = query.where(field.optionsQuery.where);
    }
    const rows = await query.orderBy(field.optionsQuery.orderBy || field.optionsQuery.labelKey);
    fields.push({
      ...field,
      options: rows.map((row) => {
        const labelRaw = field.labelFormat ? field.labelFormat(row, locale) : row[field.optionsQuery.labelKey];
        const labelUr = !field.labelFormat && locale === "ur" && row.name_ur ? row.name_ur : null;
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
  page.columns = (page.columns || []).filter((column) => column.key !== "is_active").filter((column) => column.key !== "created_by_name" && column.key !== "created_at");
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
  let query = knex({ t: page.table }).leftJoin({ u: "erp.users" }, "t.created_by", "u.id");
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
            this.select(1).from(page.branchMap.table).whereRaw(`${page.branchMap.table}.${page.branchMap.key} = t.id`).andWhere(`${page.branchMap.table}.${page.branchMap.branchKey}`, options.branchId);
          })
          .orWhere("t.branch_id", options.branchId);
      });
    } else {
      query = query.where("t.branch_id", options.branchId);
    }
  }
  if (page.itemTypeMap) {
    query = query.leftJoin({ pgt: page.itemTypeMap.table }, "t.id", `pgt.${page.itemTypeMap.key}`);
  }
  const selects = ["t.*", "u.username as created_by_name"];
  if (page.hasUpdatedFields !== false) {
    selects.push("uu.username as updated_by_name");
  }
  let extraSelect = page.extraSelect ? (typeof page.extraSelect === "function" ? page.extraSelect(options.locale || "en") : page.extraSelect) : [];
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
    selects.push(knex.raw("COALESCE(string_agg(pgt.item_type::text, ', ' ORDER BY pgt.item_type), '') as item_types"));
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
  "party-groups": "/party-groups",
  "account-groups": "/account-groups",
  departments: "/departments",
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
  "party-groups": "master_data.basic_info.party_groups",
  "account-groups": "master_data.basic_info.account_groups",
  departments: "master_data.basic_info.departments",
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
    const modalOpen = flashMatch ? ["create", "edit"].includes(modalMode) : false;
    const basePath = `${req.baseUrl}${ROUTE_MAP[type]}`;
    const defaults = { ...(hydrated.defaults || {}) };
    const scopeKey = BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`;
    const canBrowse = res.locals.can("SCREEN", scopeKey, "navigate");
    const rows = canBrowse
      ? await fetchRows(hydrated, {
          branchId: req.user?.isAdmin ? null : req.branchId,
          locale: req.locale,
        })
      : [];
    return renderPage(req, res, "../../master_data/basic-info/index", hydrated, {
      rows,
      basePath,
      scopeKey,
      values: flashMatch ? flashMatch.values : defaults,
      error: flashMatch ? flashMatch.error : null,
      modalOpen,
      modalMode,
    });
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
    setCookie(res, FLASH_COOKIE, "", { path: `${path}/`, maxAge: 0, sameSite: "Lax" });
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
const renderIndexError = async (req, res, page, values, error, modalMode, basePath, type) => {
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
  if (!hasField(page, "code") && !page.autoCodeFromName) {
    delete values.code;
  }
  const missing = page.fields.filter((field) => field.required).filter((field) => !values[field.name]);
  const basePath = `${req.baseUrl}${ROUTE_MAP[type]}`;

  if (missing.length) {
    return renderIndexError(req, res, page, values, res.locals.t("error_required_fields"), "create", basePath, type);
  }

  try {
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
        const existing = await knex(page.table).whereRaw("lower(code) = ?", [codeValue.toLowerCase()]).first();
        if (existing) {
          return renderIndexError(req, res, page, values, res.locals.t("unit_code_exists"), "create", basePath, type);
        }
      }
    }
    if (page.itemTypeMap) {
      const { item_types: itemTypes = [], ...rest } = values;
      if (!itemTypes.length) {
        return renderIndexError(req, res, page, values, res.locals.t("error_required_fields"), "create", basePath, type);
      }
      const approval = await handleScreenApproval({
        req,
        scopeKey: BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`,
        action: "create",
        entityType: getBasicInfoEntityType(type),
        entityId: "NEW",
        summary: `${res.locals.t("create")} ${res.locals.t(page.titleKey)}`,
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
          scopeKey: BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`,
          action: "create",
          entityType: getBasicInfoEntityType(type),
          entityId: "NEW",
          summary: `${res.locals.t("create")} ${res.locals.t(page.titleKey)}`,
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
          scopeKey: BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`,
          action: "create",
          entityType: getBasicInfoEntityType(type),
          entityId: "NEW",
          summary: `${res.locals.t("create")} ${res.locals.t(page.titleKey)}`,
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
        const [row] = await knex(page.table).insert(insertValues).returning("id");
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
    return renderIndexError(req, res, page, values, err?.message || res.locals.t("error_unable_save"), "create", basePath, type);
  }
};

const updateHandler = (type) => async (req, res, next) => {
  const page = getPageConfig(type);
  const id = Number(req.params.id);
  if (!page || !id) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  const values = buildValues(page, req.body);
  if (!hasField(page, "code") && !page.autoCodeFromName) {
    delete values.code;
  }
  const missing = page.fields.filter((field) => field.required).filter((field) => !values[field.name]);

  const basePath = `${req.baseUrl}${ROUTE_MAP[type]}`;

  if (missing.length) {
    return renderIndexError(req, res, page, values, res.locals.t("error_required_fields"), "edit", basePath, type);
  }

  try {
    const existingRow = await knex(page.table).where({ id }).first();
    if (!existingRow) {
      return renderIndexError(req, res, page, values, res.locals.t("error_not_found"), "edit", basePath, type);
    }
    if (hasField(page, "code") && existingRow.code) {
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
      const existing = await knex(page.table).select("code").where({ id }).first();
      if (existing && existing.code !== values.code) {
        const usedInItems = await knex("erp.items").where({ base_uom_id: id }).first();
        const usedInConversions = await knex("erp.uom_conversions").where({ from_uom_id: id }).orWhere({ to_uom_id: id }).first();
        if (usedInItems || usedInConversions) {
          return renderIndexError(req, res, page, values, res.locals.t("error_unit_code_locked"), "edit", basePath, type);
        }
      }
    }
    if (page.itemTypeMap) {
      const { item_types: itemTypes = [], ...rest } = values;
      if (!itemTypes.length) {
        return renderIndexError(req, res, page, values, res.locals.t("error_required_fields"), "edit", basePath, type);
      }
      const approval = await handleScreenApproval({
        req,
        scopeKey: BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`,
        action: "edit",
        entityType: getBasicInfoEntityType(type),
        entityId: id,
        summary: `${res.locals.t("edit")} ${res.locals.t(page.titleKey)}`,
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
      const auditFields = page.hasUpdatedFields === false ? {} : { updated_by: req.user ? req.user.id : null, updated_at: knex.fn.now() };
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
      const auditFields = page.hasUpdatedFields === false ? {} : { updated_by: req.user ? req.user.id : null, updated_at: knex.fn.now() };
      if (page.branchMap) {
        const { branch_ids: branchIds = [], ...rest } = values;
        const approval = await handleScreenApproval({
          req,
          scopeKey: BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`,
          action: "edit",
          entityType: getBasicInfoEntityType(type),
          entityId: id,
          summary: `${res.locals.t("edit")} ${res.locals.t(page.titleKey)}`,
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
          scopeKey: BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`,
          action: "edit",
          entityType: getBasicInfoEntityType(type),
          entityId: id,
          summary: `${res.locals.t("edit")} ${res.locals.t(page.titleKey)}`,
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
    return renderIndexError(req, res, page, values, err?.message || res.locals.t("error_unable_save"), "edit", basePath, type);
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
    const current = await knex(page.table).select("is_active").where({ id }).first();
    if (!current) {
      return next(new HttpError(404, "Record not found"));
    }
    const scopeKey = BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`;
    const entityType = getBasicInfoEntityType(type);
    const summary = `${res.locals.t("deactivate")} ${res.locals.t(page.titleKey)}`;
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
    const auditFields = page.hasUpdatedFields === false ? {} : { updated_by: req.user ? req.user.id : null, updated_at: knex.fn.now() };
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
    return renderIndexError(req, res, page, {}, err?.message || res.locals.t("error_update_status"), "delete", basePath, type);
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
      return renderIndexError(req, res, page, {}, res.locals.t("error_not_found"), "delete", basePath, type);
    }
    const scopeKey = BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`;
    const entityType = getBasicInfoEntityType(type);
    const summary = `${res.locals.t("delete")} ${res.locals.t(page.titleKey)}`;
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
    await knex(page.table).where({ id }).del();
    queueAuditLog(req, {
      entityType: getBasicInfoEntityType(type),
      entityId: id,
      action: "DELETE",
    });
    return res.redirect(basePath);
  } catch (err) {
    return renderIndexError(req, res, page, {}, err?.message || res.locals.t("error_delete"), "delete", basePath, type);
  }
};

Object.entries(ROUTE_MAP).forEach(([type, path]) => {
  const scopeKey = BASIC_INFO_SCOPE_KEYS[type] || `master_data.basic_info.${type}`;
  router.get(path, requirePermission("SCREEN", scopeKey, "view"), listHandler(type));
  router.get(`${path}/new`, requirePermission("SCREEN", scopeKey, "create"), newHandler(type));
  router.post(path, requirePermission("SCREEN", scopeKey, "navigate"), createHandler(type));
  router.post(`${path}/:id`, requirePermission("SCREEN", scopeKey, "navigate"), updateHandler(type));
  router.post(`${path}/:id/toggle`, requirePermission("SCREEN", scopeKey, "navigate"), toggleHandler(type));
  router.post(`${path}/:id/delete`, requirePermission("SCREEN", scopeKey, "navigate"), deleteHandler(type));
});

router.get("/groups/products/product-groups", (req, res) => {
  res.redirect(`${req.baseUrl}${ROUTE_MAP.groups}`);
});
router.get("/groups/products/product-subgroups", (req, res) => {
  res.redirect(`${req.baseUrl}${ROUTE_MAP["product-subgroups"]}`);
});
router.get("/groups/products/product-types", (req, res) => {
  res.redirect(`${req.baseUrl}${ROUTE_MAP["product-types"]}`);
});
router.get("/groups/party-groups", (req, res) => {
  res.redirect(`${req.baseUrl}${ROUTE_MAP["party-groups"]}`);
});
router.get("/groups/account-groups", (req, res) => {
  res.redirect(`${req.baseUrl}${ROUTE_MAP["account-groups"]}`);
});
router.get("/groups/departments", (req, res) => {
  res.redirect(`${req.baseUrl}${ROUTE_MAP.departments}`);
});

router.get("/:type", (req, res, next) => {
  const target = ROUTE_MAP[req.params.type];
  if (target) {
    return res.redirect(`${req.baseUrl}${target}`);
  }
  return next(new HttpError(404, "Basic information page not found"));
});

router.preview = {
  getPageConfig,
  hydratePage,
};

module.exports = router;
