const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");
const { requirePermission } = require("../../../middleware/access/role-permissions");
const { handleScreenApproval } = require("../../../middleware/approvals/screen-approval");
const { SCREEN_ENTITY_TYPES } = require("../../../utils/approval-entity-map");
const { parseCookies, setCookie } = require("../../../middleware/utils/cookies");

const router = express.Router();

const toCode = (value) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);

const hasField = (page, name) => page.fields.some((field) => field.name === name);

const page = {
  titleKey: "accounts",
  description: "Maintain chart of accounts used in vouchers and reporting.",
  table: "erp.accounts",
  translateMode: "transliterate",
  hasUpdatedFields: true,
  autoCodeFromName: true,
  branchScoped: true,
  branchMap: {
    table: "erp.account_branch",
    key: "account_id",
    branchKey: "branch_id",
  },
  joins: [{ table: { ag: "erp.account_groups" }, on: ["t.subgroup_id", "ag.id"] }],
  extraSelect: (locale) => [
    locale === "ur" ? knex.raw("COALESCE(ag.name_ur, ag.name) as group_name") : "ag.name as group_name",
    "ag.account_type as account_type",
    knex.raw(
      `(SELECT COALESCE(string_agg(b.name, ', ' ORDER BY b.name), '')
        FROM erp.account_branch ab
        JOIN erp.branches b ON b.id = ab.branch_id
        WHERE ab.account_id = t.id) as branch_names`,
    ),
    knex.raw(
      `(SELECT COALESCE(string_agg(ab.branch_id::text, ',' ORDER BY ab.branch_id), '')
        FROM erp.account_branch ab
        WHERE ab.account_id = t.id) as branch_ids`,
    ),
  ],
  columns: [
    { key: "id", label: "ID" },
    { key: "name", label: "account_name" },
    { key: "name_ur", label: "Name (Urdu)" },
    { key: "account_type", label: "account_type" },
    { key: "group_name", label: "account_group" },
    { key: "branch_names", label: "branches" },
    { key: "lock_posting", label: "lock_posting", type: "boolean" },
  ],
  fields: [
    {
      name: "name",
      label: "account_name",
      placeholder: "Cash Main, Bank Alfalah",
      required: true,
    },
    {
      name: "name_ur",
      label: "Name (Urdu)",
      placeholder: "Urdu name",
      required: true,
    },
    {
      name: "subgroup_id",
      label: "account_group",
      type: "select",
      required: true,
      optionsQuery: {
        table: "erp.account_groups",
        valueKey: "id",
        labelKey: "name",
        select: ["id", "name", "name_ur", "account_type"],
        orderBy: ["account_type", "name"],
      },
      labelFormat: (row, locale) => `${row.account_type} - ${locale === "ur" && row.name_ur ? row.name_ur : row.name}`,
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
      name: "lock_posting",
      label: "lock_posting",
      helpText: "Prevent vouchers from posting to this account.",
      type: "checkbox",
    },
  ],
};

page.columns = (page.columns || [])
  .filter((column) => column.key !== "is_active")
  .map((column) => {
    if (column.key === "created_by_name" || column.key === "created_at") {
      return { ...column, cellClass: "col-export-only" };
    }
    return column;
  });

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
    view: "../../master_data/accounts/index",
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
      builder.whereExists(function () {
        this.select(1).from(pageConfig.branchMap.table).whereRaw(`${pageConfig.branchMap.table}.${pageConfig.branchMap.key} = t.id`).andWhere(`${pageConfig.branchMap.table}.${pageConfig.branchMap.branchKey}`, options.branchId);
      });
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
    acc[field.name] = (body[field.name] || "").trim();
    return acc;
  }, {});

const FLASH_COOKIE = "accounts_flash";

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
  const payload = { values, error, modalMode };
  setCookie(res, FLASH_COOKIE, JSON.stringify(payload), {
    path: req.baseUrl,
    maxAge: 60,
    sameSite: "Lax",
  });
  return res.redirect(basePath);
};

router.get("/", requirePermission("SCREEN", "master_data.accounts", "navigate"), async (req, res, next) => {
  try {
    const hydrated = await hydratePage(page, req.locale);
    const flash = readFlash(req, res, req.baseUrl);
    const modalMode = flash ? flash.modalMode : "create";
    const modalOpen = flash ? ["create", "edit"].includes(modalMode) : false;
    const rows = await fetchRows(hydrated, {
      branchId: req.user?.isAdmin ? null : req.branchId,
      locale: req.locale,
    });
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

router.post("/", requirePermission("SCREEN", "master_data.accounts", "navigate"), async (req, res, next) => {
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
    return renderIndexError(req, res, values, res.locals.t("error_required_fields"), "create", basePath);
  }

  try {
    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.accounts",
      action: "create",
      entityType: SCREEN_ENTITY_TYPES["master_data.accounts"],
      entityId: "NEW",
      summary: `${res.locals.t("create")} ${res.locals.t(page.titleKey)}`,
      oldValue: null,
      newValue: values,
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect("/administration/approvals?status=PENDING&notice=approval_submitted");
    }

    const branchIds = Array.isArray(values.branch_ids) ? values.branch_ids : [];
    if (!branchIds.length) {
      return renderIndexError(req, res, values, res.locals.t("error_select_branch"), "create", basePath);
    }
    const codeValue = values.code || (page.autoCodeFromName ? toCode(values.name) : "");
    const nameValue = values.name || "";
    if (codeValue && (await knex(page.table).whereRaw("lower(code) = ?", [codeValue.toLowerCase()]).first())) {
      return renderIndexError(req, res, values, res.locals.t("error_duplicate_code"), "create", basePath);
    }
    if (nameValue && (await knex(page.table).whereRaw("lower(name) = ?", [nameValue.toLowerCase()]).first())) {
      return renderIndexError(req, res, values, res.locals.t("error_duplicate_name"), "create", basePath);
    }
    const { branch_ids: branchIdsInsert = [], ...rest } = values;
    await knex.transaction(async (trx) => {
      const [row] = await trx(page.table)
        .insert({
          ...rest,
          ...(page.autoCodeFromName ? { code: toCode(rest.name) } : {}),
          created_by: req.user ? req.user.id : null,
        })
        .returning("id");
      const accountId = row && row.id ? row.id : row;
      if (branchIdsInsert.length) {
        await trx(page.branchMap.table).insert(
          branchIdsInsert.map((branchId) => ({
            [page.branchMap.key]: accountId,
            [page.branchMap.branchKey]: branchId,
          })),
        );
      }
    });
    return res.redirect(basePath);
  } catch (err) {
    console.error("[accounts:create]", { error: err });
    return renderIndexError(req, res, values, err?.message || res.locals.t("error_unable_save"), "create", basePath);
  }
});

router.post("/:id", requirePermission("SCREEN", "master_data.accounts", "navigate"), async (req, res, next) => {
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
    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.accounts",
      action: "edit",
      entityType: SCREEN_ENTITY_TYPES["master_data.accounts"],
      entityId: id,
      summary: `${res.locals.t("edit")} ${res.locals.t(page.titleKey)}`,
      oldValue: existing,
      newValue: values,
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect("/administration/approvals?status=PENDING&notice=approval_submitted");
    }

    const branchIds = Array.isArray(values.branch_ids) ? values.branch_ids : [];
    if (!branchIds.length) {
      return renderIndexError(req, res, values, res.locals.t("error_select_branch"), "edit", basePath);
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
    return res.redirect(basePath);
  } catch (err) {
    console.error("[accounts:update]", { id, error: err });
    return renderIndexError(req, res, values, err?.message || res.locals.t("error_unable_save"), "edit", basePath);
  }
});

router.post("/:id/toggle", requirePermission("SCREEN", "master_data.accounts", "delete"), async (req, res, next) => {
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
      scopeKey: "master_data.accounts",
      action: "edit",
      entityType: SCREEN_ENTITY_TYPES["master_data.accounts"],
      entityId: id,
      summary: `${res.locals.t("edit")} ${res.locals.t(page.titleKey)}`,
      oldValue: current,
      newValue: { is_active: !current.is_active },
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect("/administration/approvals?status=PENDING&notice=approval_submitted");
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
    return renderIndexError(req, res, {}, res.locals.t("error_update_status"), "delete", basePath);
  }
});

router.post("/:id/delete", requirePermission("SCREEN", "master_data.accounts", "hard_delete"), async (req, res, next) => {
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
      scopeKey: "master_data.accounts",
      action: "delete",
      entityType: SCREEN_ENTITY_TYPES["master_data.accounts"],
      entityId: id,
      summary: `${res.locals.t("delete")} ${res.locals.t(page.titleKey)}`,
      oldValue: existing,
      newValue: null,
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect("/administration/approvals?status=PENDING&notice=approval_submitted");
    }
    await knex(page.table).where({ id }).del();
    return res.redirect(basePath);
  } catch (err) {
    return renderIndexError(req, res, {}, err?.message || res.locals.t("error_delete"), "delete", basePath);
  }
});

module.exports = router;
