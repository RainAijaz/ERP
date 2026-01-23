const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");
const { parseCookies, setCookie } = require("../../../middleware/utils/cookies");

const router = express.Router();

const toCode = (value) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);

// Page metadata drives form fields, table columns, and DB mapping.
const BASIC_INFO_PAGES = {
  units: {
    titleKey: "units",
    description: "Define the units of measure used across items, vouchers, and stock.",
    table: "erp.uom",
    translateMode: "translate",
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
        name: "code",
        label: "Code",
        placeholder: "PCS, DOZEN, KG",
        required: true,
      },
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
    translateMode: "translate",
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
    ],
  },
  colors: {
    titleKey: "colors",
    description: "Color options for raw materials and finished variants.",
    table: "erp.colors",
    translateMode: "translate",
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
    extraSelect: ["pg.name as group_name"],
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
        name: "code",
        label: "Code",
        helpText: "Short code used in reports and filtering (e.g., cash_bank).",
        placeholder: "cash_bank, receivables",
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
    translateMode: "translate",
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
const hydratePage = async (page) => {
  const fields = [];
  for (const field of page.fields) {
    if (!field.optionsQuery) {
      fields.push(field);
      continue;
    }
    const rows = await knex(field.optionsQuery.table)
      .select(field.optionsQuery.valueKey, field.optionsQuery.labelKey)
      .orderBy(field.optionsQuery.orderBy || field.optionsQuery.labelKey);
    fields.push({
      ...field,
      options: rows.map((row) => ({
        value: row[field.optionsQuery.valueKey],
        label: row[field.optionsQuery.labelKey],
      })),
    });
  }
  return { ...page, fields };
};

const renderPage = (req, res, view, page, extra = {}) =>
  res.render("base/layouts/main", {
    title: `${res.locals.t(page.titleKey)} - Basic Info`,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view,
    t: res.locals.t,
    page,
    ...extra,
  });

// Build the list query with optional joins and item-type aggregation.
const fetchRows = (page) => {
  let query = knex({ t: page.table }).leftJoin({ u: "erp.users" }, "t.created_by", "u.id").leftJoin({ uu: "erp.users" }, "t.updated_by", "uu.id");
  if (page.joins) {
    page.joins.forEach((join) => {
      query = query.leftJoin(join.table, join.on[0], join.on[1]);
    });
  }
  if (page.itemTypeMap) {
    query = query.leftJoin({ pgt: page.itemTypeMap.table }, "t.id", `pgt.${page.itemTypeMap.key}`);
  }
  const selects = ["t.*", "u.username as created_by_name", "uu.username as updated_by_name"];
  if (page.extraSelect) {
    selects.push(...page.extraSelect);
  }
  if (page.itemTypeMap) {
    const extraGroupBys = (page.extraSelect || [])
      .map((select) =>
        String(select)
          .split(/\s+as\s+/i)[0]
          .trim(),
      )
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
  groups: "/product-groups",
  "product-subgroups": "/product-subgroups",
  "product-types": "/product-types",
  "party-groups": "/party-groups",
  "account-groups": "/account-groups",
  departments: "/departments",
};

const listHandler = (type) => async (req, res, next) => {
  const page = getPageConfig(type);
  if (!page) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  try {
    const hydrated = await hydratePage(page);
    const flash = readFlash(req, res, req.baseUrl);
    const flashMatch = flash && flash.type === type ? flash : null;
    const modalMode = flashMatch ? flashMatch.modalMode : "create";
    const modalOpen = flashMatch ? ["create", "edit"].includes(modalMode) : false;
    const rows = await fetchRows(hydrated);
    const basePath = `${req.baseUrl}${ROUTE_MAP[type]}`;
    return renderPage(req, res, "../../master_data/basic-info/index", hydrated, {
      rows,
      basePath,
      values: flashMatch ? flashMatch.values : hydrated.defaults || {},
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
    const hydrated = await hydratePage(page);
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
    acc[field.name] = (body[field.name] || "").trim();
    return acc;
  }, {});

const FLASH_COOKIE = "basic_info_flash";

const clearFlash = (res, path) => {
  setCookie(res, FLASH_COOKIE, "", { path, maxAge: 0, sameSite: "Lax" });
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
  const payload = { type, values, error, modalMode };
  setCookie(res, FLASH_COOKIE, JSON.stringify(payload), {
    path: req.baseUrl,
    maxAge: 60,
    sameSite: "Lax",
  });
  return res.redirect(basePath);
};

const createHandler = (type) => async (req, res, next) => {
  const page = getPageConfig(type);
  if (!page) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  const values = buildValues(page, req.body);
  const missing = page.fields.filter((field) => field.required).filter((field) => !values[field.name]);
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
      type
    );
  }

  try {
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
            type
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
          type
        );
      }
      await knex.transaction(async (trx) => {
        // Insert the main record, then map each selected item type.
        const [row] = await trx(page.table)
          .insert({
            ...rest,
            ...(page.autoCodeFromName ? { code: toCode(rest.name) } : {}),
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
      });
    } else {
      const insertValues = {
        ...values,
        ...(page.autoCodeFromName ? { code: toCode(values.name) } : {}),
        created_by: req.user ? req.user.id : null,
      };
      await knex(page.table).insert(insertValues);
    }
    return res.redirect(basePath);
  } catch (err) {
    console.error("[basic-info:create]", { type, error: err });
    return renderIndexError(
      req,
      res,
      page,
      values,
      res.locals.t("error_unable_save"),
      "create",
      basePath,
      type
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
  const missing = page.fields.filter((field) => field.required).filter((field) => !values[field.name]);

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
      type
    );
  }

  try {
    if (page.table === "erp.uom") {
      const existing = await knex(page.table).select("code").where({ id }).first();
      if (existing && existing.code !== values.code) {
        const usedInItems = await knex("erp.items").where({ base_uom_id: id }).first();
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
            type
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
          type
        );
      }
      await knex.transaction(async (trx) => {
        // Update the main row, then replace item type mappings.
        await trx(page.table)
          .where({ id })
          .update({
            ...rest,
            updated_by: req.user ? req.user.id : null,
            updated_at: knex.fn.now(),
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
      });
    } else {
      await knex(page.table)
        .where({ id })
        .update({
          ...values,
          updated_by: req.user ? req.user.id : null,
          updated_at: knex.fn.now(),
        });
    }
    return res.redirect(basePath);
  } catch (err) {
    console.error("[basic-info:update]", { type, id, error: err });
    return renderIndexError(
      req,
      res,
      page,
      values,
      res.locals.t("error_unable_save"),
      "edit",
      basePath,
      type
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
    const current = await knex(page.table).select("is_active").where({ id }).first();
    if (!current) {
      return next(new HttpError(404, "Record not found"));
    }
    await knex(page.table)
      .where({ id })
      .update({
        is_active: !current.is_active,
        updated_by: req.user ? req.user.id : null,
        updated_at: knex.fn.now(),
      });
    return res.redirect(basePath);
  } catch (err) {
    return renderIndexError(
      req,
      res,
      page,
      {},
      res.locals.t("error_update_status"),
      "delete",
      basePath,
      type
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
    await knex(page.table).where({ id }).del();
    return res.redirect(basePath);
  } catch (err) {
    return renderIndexError(
      req,
      res,
      page,
      {},
      res.locals.t("error_delete"),
      "delete",
      basePath,
      type
    );
  }
};

Object.entries(ROUTE_MAP).forEach(([type, path]) => {
  router.get(path, listHandler(type));
  router.get(`${path}/new`, newHandler(type));
  router.post(path, createHandler(type));
  router.post(`${path}/:id`, updateHandler(type));
  router.post(`${path}/:id/toggle`, toggleHandler(type));
  router.post(`${path}/:id/delete`, deleteHandler(type));
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

module.exports = router;
