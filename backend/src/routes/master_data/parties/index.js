const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");
const { requirePermission } = require("../../../middleware/access/role-permissions");
const { handleScreenApproval } = require("../../../middleware/approvals/screen-approval");
const { SCREEN_ENTITY_TYPES } = require("../../../utils/approval-entity-map");
const { parseCookies, setCookie } = require("../../../middleware/utils/cookies");
const { friendlyErrorMessage } = require("../../../middleware/errors/friendly-error");
const { queueAuditLog } = require("../../../utils/audit-log");

const router = express.Router();

const toCode = (value) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);

const normalizeCredit = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isNaN(numberValue) ? null : numberValue;
};

const hasField = (page, name) => page.fields.some((field) => field.name === name);

const page = {
  titleKey: "parties",
  description: "Manage customer and supplier master records.",
  table: "erp.parties",
  hasUpdatedFields: true,
  branchScoped: true,
  translateMode: "transliterate",
  autoCodeFromName: true,
  defaults: {
    credit_allowed: true,
    credit_limit: 500000,
  },
  branchMap: {
    table: "erp.party_branch",
    key: "party_id",
    branchKey: "branch_id",
  },
  joins: [
    { table: { pg: "erp.party_groups" }, on: ["t.group_id", "pg.id"] },
    { table: { c: "erp.cities" }, on: ["t.city_id", "c.id"] },
  ],
  extraSelect: (locale) => [
    locale === "ur" ? knex.raw("COALESCE(pg.name_ur, pg.name) as group_name") : "pg.name as group_name",
    locale === "ur" ? knex.raw("COALESCE(c.name_ur, c.name, t.city) as city_name") : knex.raw("COALESCE(c.name, t.city) as city_name"),
    knex.raw("COALESCE(NULLIF(t.phone1, ''), NULLIF(t.phone2, '')) as phone_primary"),
    knex.raw(
      `(SELECT COALESCE(string_agg(b.name, ', ' ORDER BY b.name), '')
        FROM erp.party_branch pb
        JOIN erp.branches b ON b.id = pb.branch_id
        WHERE pb.party_id = t.id) as branch_names`,
    ),
    knex.raw(
      `(SELECT COALESCE(string_agg(pb.branch_id::text, ',' ORDER BY pb.branch_id), '')
        FROM erp.party_branch pb
        WHERE pb.party_id = t.id) as branch_ids`,
    ),
  ],
  columns: [
    { key: "id", label: "ID" },
    { key: "name", label: "party_name" },
    { key: "name_ur", label: "Name (Urdu)" },
    { key: "party_type", label: "party_type" },
    { key: "group_name", label: "party_group" },
    { key: "branch_names", label: "branches" },
    { key: "city_name", label: "city" },
    { key: "phone_primary", label: "phone_primary", adminOnlyTable: true },
  ],
  fields: [
    {
      name: "name",
      label: "party_name",
      placeholder: "Hamza Traders",
      required: true,
    },
    {
      name: "name_ur",
      label: "Name (Urdu)",
      placeholder: "Urdu name",
      required: true,
    },
    {
      name: "party_type",
      label: "party_type",
      type: "select",
      required: true,
      options: [
        { value: "CUSTOMER", label: "Customer" },
        { value: "SUPPLIER", label: "Supplier" },
      ],
    },
    {
      name: "group_id",
      label: "party_group",
      type: "select",
      required: false,
      optionsQuery: {
        table: "erp.party_groups",
        valueKey: "id",
        labelKey: "name",
        select: ["id", "name", "name_ur", "party_type"],
        orderBy: "name",
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
      name: "city_id",
      label: "city",
      type: "select",
      required: true,
      optionsQuery: {
        table: "erp.cities",
        valueKey: "id",
        labelKey: "name",
        orderBy: "name",
        where: { is_active: true },
      },
    },
    {
      name: "phone1",
      label: "phone_primary",
      placeholder: "0300-0000000",
      required: true,
    },
    {
      name: "phone2",
      label: "phone_secondary",
      placeholder: "Optional",
      // adminOnly: true, // Only show in table for admin, not in modal
    },
    {
      name: "address",
      label: "address",
      placeholder: "Street, area, city",
      type: "textarea",
    },
    {
      name: "credit_allowed",
      label: "credit_allowed",
      type: "checkbox",
      helpText: "Only allowed for customers. Requires a credit limit.",
    },
    {
      name: "credit_limit",
      label: "credit_limit",
      type: "number",
      min: 0,
      step: "0.01",
    },
  ],
};

page.columns = (page.columns || [])
  .filter((column) => column.key !== "is_active")
  .map((column) => {
    if (column.key === "created_by_name") {
      return { ...column, cellClass: "col-export-only" };
    }
    return column;
  });

if (!page.columns.some((column) => column.key === "created_at")) {
  page.columns.push({ key: "created_at", label: "Created At", cellClass: "col-export-only" });
}

const ACTIVE_OPTION_TABLES = new Set(["erp.party_groups", "erp.account_groups", "erp.product_groups", "erp.product_subgroups", "erp.cities", "erp.branches", "erp.departments", "erp.grades", "erp.packing_types", "erp.sizes", "erp.colors", "erp.uom"]);

const hydratePage = async (pageConfig, locale) => {
  const fields = [];
  for (const field of pageConfig.fields) {
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
          partyType: row.party_type || "",
        };
      }),
    });
  }
  return { ...pageConfig, fields };
};

const renderPage = (req, res, hydrated, data) =>
  res.render("base/layouts/main", {
    title: `${res.locals.t(hydrated.titleKey)} - Master Data`,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    isAdmin: req.user?.isAdmin || false,
    csrfToken: res.locals.csrfToken,
    view: "../../master_data/parties/index",
    t: res.locals.t,
    page: hydrated,
    ...data,
  });

const fetchRows = (pageConfig, options = {}) => {
  let query = knex({ t: pageConfig.table }).leftJoin({ u: "erp.users" }, "t.created_by", "u.id");
  if (pageConfig.hasUpdatedFields !== false) {
    query = query.leftJoin({ uu: "erp.users" }, "t.updated_by", "uu.id");
  }
  if (pageConfig.joins) {
    pageConfig.joins.forEach((join) => {
      query = query.leftJoin(join.table, join.on[0], join.on[1]);
    });
  }
  if (pageConfig.branchScoped && options.branchId) {
    query = query.where((builder) => {
      builder
        .whereExists(function () {
          this.select(1).from(pageConfig.branchMap.table).whereRaw(`${pageConfig.branchMap.table}.${pageConfig.branchMap.key} = t.id`).andWhere(`${pageConfig.branchMap.table}.${pageConfig.branchMap.branchKey}`, options.branchId);
        })
        .orWhere("t.branch_id", options.branchId);
    });
  }
  const selects = ["t.*", "u.username as created_by_name"];
  if (pageConfig.hasUpdatedFields !== false) {
    selects.push("uu.username as updated_by_name");
  }
  let extraSelect = pageConfig.extraSelect ? (typeof pageConfig.extraSelect === "function" ? pageConfig.extraSelect(options.locale || "en") : pageConfig.extraSelect) : [];
  if (!Array.isArray(extraSelect)) {
    extraSelect = [extraSelect];
  }
  if (extraSelect.length) {
    selects.push(...extraSelect);
  }
  return query.select(selects).orderBy("t.id", "desc");
};

const buildValues = (pageConfig, body) =>
  pageConfig.fields.reduce((acc, field) => {
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

const FLASH_COOKIE = "parties_flash";

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

const renderIndexError = async (req, res, values, error, modalMode, basePath) => {
  const message = friendlyErrorMessage(error, res.locals.t);
  const payload = { values, error: message, modalMode };
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

router.get("/", requirePermission("SCREEN", "master_data.parties", "view"), async (req, res, next) => {
  try {
    const hydrated = await hydratePage(page, req.locale);
    const flash = readFlash(req, res, req.baseUrl);
    const modalMode = flash ? flash.modalMode : "create";
    const modalOpen = flash ? ["create", "edit"].includes(modalMode) : false;
    const canBrowse = res.locals.can("SCREEN", "master_data.parties", "navigate");
    const rows = canBrowse
      ? await fetchRows(hydrated, {
          branchId: req.user?.isAdmin ? null : req.branchId,
          locale: req.locale,
        })
      : [];
    const basePath = req.baseUrl;
    const defaults = { ...(hydrated.defaults || {}) };
    if (!flash && req.branchId) {
      defaults.branch_ids = [String(req.branchId)];
    }
    return renderPage(req, res, hydrated, {
      rows,
      basePath,
      values: flash ? flash.values : defaults,
      error: flash ? flash.error : null,
      modalOpen,
      modalMode,
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/", requirePermission("SCREEN", "master_data.parties", "navigate"), async (req, res, next) => {
  console.log("[parties:POST /] route hit", {
    user: req.user && { id: req.user.id, username: req.user.username, isAdmin: req.user.isAdmin },
    body: req.body,
    path: req.path,
    method: req.method,
  });
  const values = buildValues(page, req.body);
  if (page.autoCodeFromName && !values.code) {
    values.code = toCode(values.name);
  }
  if (!hasField(page, "code") && !page.autoCodeFromName) {
    delete values.code;
  }
  const missing = page.fields.filter((field) => field.required).filter((field) => !values[field.name]);
  const basePath = req.baseUrl;

  if (missing.length) {
    console.log("[parties:POST /] missing required fields", { missing });
    return renderIndexError(req, res, values, res.locals.t("error_required_fields"), "create", basePath);
  }

  try {
    console.log("[parties:POST /] calling handleScreenApproval", {
      user: req.user && { id: req.user.id, username: req.user.username, isAdmin: req.user.isAdmin },
      values,
    });
    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.parties",
      action: "create",
      entityType: SCREEN_ENTITY_TYPES["master_data.parties"],
      entityId: "NEW",
      summary: `${res.locals.t("create")} ${res.locals.t(page.titleKey)}`,
      oldValue: null,
      newValue: values,
      t: res.locals.t,
    });
    console.log("[parties:POST /] handleScreenApproval result", approval);

    if (approval.queued) {
      console.log("[parties:POST /] approval was queued, redirecting");
      return res.redirect(req.get("referer") || basePath);
    }

    const branchIds = Array.isArray(values.branch_ids) ? values.branch_ids : [];
    if (values.group_id) {
      const groupRow = await knex("erp.party_groups").select("party_type", "is_active").where({ id: values.group_id }).first();
      if (!groupRow || groupRow.is_active === false) {
        return renderIndexError(req, res, values, res.locals.t("error_select_party_group"), "create", basePath);
      }
      if (groupRow.party_type && groupRow.party_type !== "BOTH" && groupRow.party_type !== values.party_type) {
        return renderIndexError(req, res, values, res.locals.t("error_party_group_type"), "create", basePath);
      }
    }
    if (!branchIds.length) {
      return renderIndexError(req, res, values, res.locals.t("error_select_branch"), "create", basePath);
    }
    if (!values.city_id) {
      return renderIndexError(req, res, values, res.locals.t("error_select_city"), "create", basePath);
    }
    if (req.user?.isAdmin && !values.phone1) {
      return renderIndexError(req, res, values, res.locals.t("error_select_phone"), "create", basePath);
    }
    const hasCreditAllowed = Object.prototype.hasOwnProperty.call(values, "credit_allowed");
    const hasCreditLimit = Object.prototype.hasOwnProperty.call(values, "credit_limit");
    if (!hasCreditAllowed && !hasCreditLimit) {
      values.credit_allowed = true;
      values.credit_limit = page.defaults?.credit_limit ?? 500000;
    }
    const creditAllowed = values.credit_allowed === true;
    const creditLimit = normalizeCredit(values.credit_limit);
    const codeValue = values.code || (page.autoCodeFromName ? toCode(values.name) : "");
    const nameValue = values.name || "";
    if (codeValue && (await knex(page.table).whereRaw("lower(code) = ?", [codeValue.toLowerCase()]).first())) {
      return renderIndexError(req, res, values, res.locals.t("error_duplicate_code"), "create", basePath);
    }
    if (nameValue && (await knex(page.table).whereRaw("lower(name) = ?", [nameValue.toLowerCase()]).first())) {
      return renderIndexError(req, res, values, res.locals.t("error_duplicate_name"), "create", basePath);
    }
    values.credit_limit = creditAllowed ? String(creditLimit || 0) : "0";
    values.branch_id = req.branchId;
    values.branch_ids = (branchIds.length ? branchIds : [req.branchId]).map(String);

    const { branch_ids: branchIdsInsert = [], ...rest } = values;
    await knex.transaction(async (trx) => {
      const [row] = await trx(page.table)
        .insert({
          ...rest,
          ...(page.autoCodeFromName ? { code: toCode(rest.name) } : {}),
          created_by: req.user ? req.user.id : null,
        })
        .returning("id");
      const partyId = row && row.id ? row.id : row;
      if (branchIdsInsert.length) {
        await trx(page.branchMap.table).insert(
          branchIdsInsert.map((branchId) => ({
            [page.branchMap.key]: partyId,
            [page.branchMap.branchKey]: branchId,
          })),
        );
      }
      queueAuditLog(req, {
        entityType: SCREEN_ENTITY_TYPES["master_data.parties"],
        entityId: partyId,
        action: "CREATE",
      });
    });
    return res.redirect(basePath);
  } catch (err) {
    console.error("[parties:create]", { error: err });
    return renderIndexError(req, res, values, err?.message || res.locals.t("error_unable_save"), "create", basePath);
  }
});

router.post("/:id", requirePermission("SCREEN", "master_data.parties", "navigate"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) {
    return next(new HttpError(404, res.locals.t("error_not_found")));
  }
  const values = buildValues(page, req.body);
  if (page.autoCodeFromName && !values.code) {
    values.code = toCode(values.name);
  }
  if (!hasField(page, "code") && !page.autoCodeFromName) {
    delete values.code;
  }
  const missing = page.fields.filter((field) => field.required).filter((field) => !values[field.name]);
  const basePath = req.baseUrl;

  if (missing.length) {
    return renderIndexError(req, res, values, res.locals.t("error_required_fields"), "edit", basePath);
  }

  try {
    const existing = await knex(page.table).where({ id }).first();
    if (!existing) {
      return renderIndexError(req, res, values, res.locals.t("error_not_found"), "edit", basePath);
    }
    if (hasField(page, "code") && existing.code) {
      values.code = existing.code;
    }
    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.parties",
      action: "edit",
      entityType: SCREEN_ENTITY_TYPES["master_data.parties"],
      entityId: id,
      summary: `${res.locals.t("edit")} ${res.locals.t(page.titleKey)}`,
      oldValue: existing,
      newValue: values,
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }

    const branchIds = Array.isArray(values.branch_ids) ? values.branch_ids : [];
    if (values.group_id) {
      const groupRow = await knex("erp.party_groups").select("party_type", "is_active").where({ id: values.group_id }).first();
      if (!groupRow || groupRow.is_active === false) {
        return renderIndexError(req, res, values, res.locals.t("error_select_party_group"), "edit", basePath);
      }
      if (groupRow.party_type && groupRow.party_type !== "BOTH" && groupRow.party_type !== values.party_type) {
        return renderIndexError(req, res, values, res.locals.t("error_party_group_type"), "edit", basePath);
      }
    }
    if (!branchIds.length) {
      return renderIndexError(req, res, values, res.locals.t("error_select_branch"), "edit", basePath);
    }
    if (!values.city_id) {
      return renderIndexError(req, res, values, res.locals.t("error_select_city"), "edit", basePath);
    }
    if (req.user?.isAdmin && !values.phone1) {
      return renderIndexError(req, res, values, res.locals.t("error_select_phone"), "edit", basePath);
    }
    const hasCreditAllowed = Object.prototype.hasOwnProperty.call(values, "credit_allowed");
    const hasCreditLimit = Object.prototype.hasOwnProperty.call(values, "credit_limit");
    const creditAllowed = values.credit_allowed === true;
    const creditLimit = normalizeCredit(values.credit_limit);
    if (!hasCreditAllowed && !hasCreditLimit) {
      delete values.credit_allowed;
      delete values.credit_limit;
    }
    const codeValue = values.code || (page.autoCodeFromName ? toCode(values.name) : "");
    const nameValue = values.name || "";
    if (codeValue) {
      const existing = await knex(page.table).whereRaw("lower(code) = ?", [codeValue.toLowerCase()]).andWhereNot({ id }).first();
      if (existing) {
        return renderIndexError(req, res, values, res.locals.t("error_duplicate_code"), "edit", basePath);
      }
    }
    if (nameValue) {
      const existing = await knex(page.table).whereRaw("lower(name) = ?", [nameValue.toLowerCase()]).andWhereNot({ id }).first();
      if (existing) {
        return renderIndexError(req, res, values, res.locals.t("error_duplicate_name"), "edit", basePath);
      }
    }
    if (hasCreditAllowed || hasCreditLimit) {
      values.credit_limit = creditAllowed ? String(creditLimit || 0) : "0";
    }
    values.branch_id = req.branchId;
    values.branch_ids = (branchIds.length ? branchIds : [req.branchId]).map(String);

    const auditFields = { updated_by: req.user ? req.user.id : null, updated_at: knex.fn.now() };
    const { branch_ids: branchIdsUpdate = [], ...rest } = values;
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
      if (branchIdsUpdate.length) {
        await trx(page.branchMap.table).insert(
          branchIdsUpdate.map((branchId) => ({
            [page.branchMap.key]: id,
            [page.branchMap.branchKey]: branchId,
          })),
        );
      }
    });
    queueAuditLog(req, {
      entityType: SCREEN_ENTITY_TYPES["master_data.parties"],
      entityId: id,
      action: "UPDATE",
    });
    return res.redirect(basePath);
  } catch (err) {
    console.error("[parties:update]", { id, error: err });
    return renderIndexError(req, res, values, err?.message || res.locals.t("error_unable_save"), "edit", basePath);
  }
});

router.post("/:id/toggle", requirePermission("SCREEN", "master_data.parties", "delete"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) {
    return next(new HttpError(404, res.locals.t("error_not_found")));
  }
  const basePath = req.baseUrl;

  try {
    const current = await knex(page.table).select("is_active").where({ id }).first();
    if (!current) {
      return next(new HttpError(404, res.locals.t("error_not_found")));
    }
    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.parties",
      action: "delete",
      entityType: SCREEN_ENTITY_TYPES["master_data.parties"],
      entityId: id,
      summary: `${res.locals.t("deactivate")} ${res.locals.t(page.titleKey)}`,
      oldValue: current,
      newValue: { is_active: !current.is_active },
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }
    await knex(page.table)
      .where({ id })
      .update({
        is_active: !current.is_active,
        updated_by: req.user ? req.user.id : null,
        updated_at: knex.fn.now(),
      });
    queueAuditLog(req, {
      entityType: SCREEN_ENTITY_TYPES["master_data.parties"],
      entityId: id,
      action: "DELETE",
    });
    return res.redirect(basePath);
  } catch (err) {
    return renderIndexError(req, res, {}, res.locals.t("error_update_status"), "delete", basePath);
  }
});

router.post("/:id/delete", requirePermission("SCREEN", "master_data.parties", "hard_delete"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) {
    return next(new HttpError(404, res.locals.t("error_not_found")));
  }
  const basePath = req.baseUrl;

  try {
    const existing = await knex(page.table).where({ id }).first();
    if (!existing) {
      return renderIndexError(req, res, {}, res.locals.t("error_not_found"), "delete", basePath);
    }
    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.parties",
      action: "delete",
      entityType: SCREEN_ENTITY_TYPES["master_data.parties"],
      entityId: id,
      summary: `${res.locals.t("delete")} ${res.locals.t(page.titleKey)}`,
      oldValue: existing,
      newValue: null,
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }
    await knex(page.table).where({ id }).del();
    queueAuditLog(req, {
      entityType: SCREEN_ENTITY_TYPES["master_data.parties"],
      entityId: id,
      action: "DELETE",
    });
    return res.redirect(basePath);
  } catch (err) {
    return renderIndexError(req, res, {}, err?.message || res.locals.t("error_delete"), "delete", basePath);
  }
});

router.preview = {
  page,
  hydratePage,
};

module.exports = router;
