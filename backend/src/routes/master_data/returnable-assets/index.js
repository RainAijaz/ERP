const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");
const { requirePermission } = require("../../../middleware/access/role-permissions");
const { handleScreenApproval } = require("../../../middleware/approvals/screen-approval");
const { SCREEN_ENTITY_TYPES } = require("../../../utils/approval-entity-map");
const { queueAuditLog } = require("../../../utils/audit-log");
const { generateUniqueCode } = require("../../../utils/entity-code");

const router = express.Router();
const SCOPE_KEY = "master_data.returnable_assets";
const ENTITY_TYPE = SCREEN_ENTITY_TYPES[SCOPE_KEY];
let assetColumnSupport;
let assetTypeColumnSupport;

const toPositiveInt = (value) => {
  const parsed = Number(value || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeText = (value, max = 255) => String(value || "").trim().slice(0, max);

const getAssetColumnSupport = async () => {
  if (assetColumnSupport) return assetColumnSupport;
  const hasColumn = async (column) =>
    knex.schema.withSchema("erp").hasColumn("assets", column);
  assetColumnSupport = {
    name: await hasColumn("name"),
    name_ur: await hasColumn("name_ur"),
    created_by: await hasColumn("created_by"),
    created_at: await hasColumn("created_at"),
    updated_by: await hasColumn("updated_by"),
    updated_at: await hasColumn("updated_at"),
  };
  return assetColumnSupport;
};

const getAssetTypeColumnSupport = async () => {
  if (assetTypeColumnSupport) return assetTypeColumnSupport;
  const hasColumn = async (column) =>
    knex.schema.withSchema("erp").hasColumn("asset_type_registry", column);
  assetTypeColumnSupport = {
    name_ur: await hasColumn("name_ur"),
  };
  return assetTypeColumnSupport;
};

const getAllowedBranchIds = (req) => {
  if (req?.user?.isAdmin) return [];
  return Array.isArray(req?.branchScope)
    ? req.branchScope.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
    : [];
};

const loadOptions = async (req) => {
  const assetTypeColumns = await getAssetTypeColumnSupport();
  const useUr = req.locale === "ur" && assetTypeColumns.name_ur;
  const [assetTypes, branches] = await Promise.all([
    knex("erp.asset_type_registry")
      .select("code", useUr ? knex.raw("COALESCE(name_ur, name) as name") : "name")
      .where({ is_active: true })
      .orderBy("name", "asc"),
    knex("erp.branches")
      .select("id", "name")
      .where({ is_active: true })
      .orderBy("name", "asc"),
  ]);
  const allowed = req?.user?.isAdmin ? null : new Set(getAllowedBranchIds(req));
  return {
    assetTypes,
    branches: allowed ? branches.filter((row) => allowed.has(Number(row.id))) : branches,
  };
};

const loadRows = async (req) => {
  const columns = await getAssetColumnSupport();
  const assetTypeColumns = await getAssetTypeColumnSupport();
  const assetTypeNameExpr =
    req.locale === "ur" && assetTypeColumns.name_ur
      ? "COALESCE(atr.name_ur, atr.name) as asset_type_name"
      : "atr.name as asset_type_name";
  const nameExpr =
    req.locale === "ur" && columns.name_ur
      ? "COALESCE(a.name_ur, a.name, a.description) as name"
      : columns.name
        ? "a.name as name"
        : "a.description as name";
  const nameUrExpr = columns.name_ur ? "a.name_ur as name_ur" : "NULL::text as name_ur";

  const query = knex("erp.assets as a")
    .leftJoin("erp.asset_type_registry as atr", "atr.code", "a.asset_type_code")
    .leftJoin("erp.branches as b", "b.id", "a.home_branch_id")
    .select(
      "a.id",
      "a.asset_code",
      "a.description",
      "a.asset_type_code",
      "a.home_branch_id",
      "a.is_active",
      knex.raw(assetTypeNameExpr),
      "b.name as home_branch_name",
      knex.raw(nameExpr),
      knex.raw(nameUrExpr),
      knex.raw(columns.created_at ? "a.created_at as created_at" : "NULL::timestamp as created_at"),
      knex.raw("NULL::text as created_by_name"),
    )
    .orderBy("a.id", "desc");

  if (columns.created_by) {
    query
      .leftJoin("erp.users as cu", "cu.id", "a.created_by")
      .clearSelect()
      .select(
        "a.id",
        "a.asset_code",
        "a.description",
        "a.asset_type_code",
        "a.home_branch_id",
        "a.is_active",
        knex.raw(assetTypeNameExpr),
        "b.name as home_branch_name",
        knex.raw(nameExpr),
        knex.raw(nameUrExpr),
        knex.raw(columns.created_at ? "a.created_at as created_at" : "NULL::timestamp as created_at"),
        "cu.username as created_by_name",
      );
  }

  if (!req?.user?.isAdmin) {
    query.where((builder) => {
      builder.whereNull("a.home_branch_id");
      if (req.branchId) builder.orWhere("a.home_branch_id", req.branchId);
    });
  }

  return query;
};

const renderIndex = async (req, res, payload = {}) => {
  const options = await loadOptions(req);
  const canBrowse = res.locals.can("SCREEN", SCOPE_KEY, "navigate");
  const rows = canBrowse ? await loadRows(req) : [];
  const page = {
    titleKey: "asset_master",
    description: "asset_master_description",
    fields: [
      { name: "name", label: "asset_name" },
      { name: "name_ur", label: "name_ur" },
      { name: "asset_type_code", label: "asset_type" },
      { name: "home_branch_id", label: "branch" },
    ],
  };

  return res.render("base/layouts/main", {
    title: res.locals.t("asset_master"),
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    isAdmin: req.user?.isAdmin || false,
    csrfToken: res.locals.csrfToken,
    view: "../../master_data/returnable-assets/index",
    t: res.locals.t,
    basePath: req.baseUrl,
    page,
    rows,
    options,
    error: null,
    modalOpen: false,
    modalMode: "create",
    ...payload,
  });
};

const validatePayload = async (req, values, options = {}) => {
  const columns = await getAssetColumnSupport();
  const id = options && options.id ? Number(options.id) : null;
  const existing = options && options.existing ? options.existing : null;
  const name = normalizeText(values.name, 150);
  const nameUr = normalizeText(values.name_ur, 150);
  const assetTypeCode = normalizeText(values.asset_type_code, 40).toUpperCase();
  const homeBranchId = toPositiveInt(values.home_branch_id);
  const description = normalizeText(values.description, 500) || name;
  const isActive = values.is_active === "on";

  if (!name || !assetTypeCode || (columns.name_ur && !nameUr)) {
    throw new HttpError(400, req.res.locals.t("error_required_fields"));
  }

  const assetType = await knex("erp.asset_type_registry")
    .select("code")
    .where({ code: assetTypeCode, is_active: true })
    .first();
  if (!assetType) throw new HttpError(400, req.res.locals.t("error_invalid_value"));

  if (homeBranchId) {
    const branch = await knex("erp.branches").select("id").where({ id: homeBranchId, is_active: true }).first();
    if (!branch) throw new HttpError(400, req.res.locals.t("error_invalid_value"));
    if (!req.user?.isAdmin) {
      const allowed = new Set(getAllowedBranchIds(req));
      if (!allowed.has(homeBranchId)) {
        throw new HttpError(400, req.res.locals.t("error_branch_out_of_scope"));
      }
    }
  }

  let assetCode = normalizeText(existing?.asset_code, 80).toUpperCase();
  if (!assetCode) {
    const generatedCode = await generateUniqueCode({
      name,
      prefix: "asset",
      maxLen: 80,
      exists: async (candidate) => {
        const duplicateRow = await knex("erp.assets")
          .select("id")
          .whereRaw("lower(asset_code) = ?", [String(candidate || "").toLowerCase()])
          .modify((query) => {
            if (id) query.whereNot({ id });
          })
          .first();
        return Boolean(duplicateRow);
      },
    });
    assetCode = String(generatedCode || "")
      .trim()
      .toUpperCase();
  }

  const duplicate = await knex("erp.assets")
    .select("id")
    .whereRaw("lower(asset_code) = ?", [assetCode.toLowerCase()])
    .modify((query) => {
      if (id) query.whereNot({ id });
    })
    .first();
  if (duplicate) {
    const err = new HttpError(400, req.res.locals.t("error_duplicate_code"));
    err.code = "DUPLICATE_CODE";
    throw err;
  }

  const payload = {
    asset_code: assetCode,
    asset_type_code: assetTypeCode,
    home_branch_id: homeBranchId,
    description,
    is_active: isActive,
  };
  if (columns.name) payload.name = name;
  if (columns.name_ur) payload.name_ur = nameUr || null;
  return payload;
};

router.get("/", requirePermission("SCREEN", SCOPE_KEY, "view"), async (req, res, next) => {
  try {
    return await renderIndex(req, res);
  } catch (err) {
    console.error("Error in ReturnableAssetsListService:", err);
    return next(err);
  }
});

router.post("/", requirePermission("SCREEN", SCOPE_KEY, "create"), async (req, res, next) => {
  try {
    const columns = await getAssetColumnSupport();
    const values = await validatePayload(req, req.body);
    const approval = await handleScreenApproval({
      req,
      scopeKey: SCOPE_KEY,
      action: "create",
      entityType: ENTITY_TYPE,
      entityId: "NEW",
      summary: `${res.locals.t("create")} ${res.locals.t("assets")}`,
      oldValue: null,
      newValue: values,
      t: res.locals.t,
    });
    if (approval.queued) {
      return res.redirect(req.get("referer") || req.baseUrl);
    }

    const insertPayload = { ...values };
    if (columns.created_by) insertPayload.created_by = req.user?.id || null;
    if (columns.created_at) insertPayload.created_at = knex.fn.now();
    if (columns.updated_by) insertPayload.updated_by = req.user?.id || null;
    if (columns.updated_at) insertPayload.updated_at = knex.fn.now();
    const [created] = await knex("erp.assets")
      .insert(insertPayload)
      .returning("id");
    const createdId = created?.id || created;
    queueAuditLog(req, {
      entityType: ENTITY_TYPE,
      entityId: createdId,
      action: "CREATE",
    });
    return res.redirect(req.baseUrl);
  } catch (err) {
    console.error("Error in ReturnableAssetsCreateService:", err);
    if (err instanceof HttpError) {
      return renderIndex(req, res, {
        error: err.message || res.locals.t("generic_error"),
        modalOpen: true,
        modalMode: "create",
        values: req.body,
      });
    }
    return next(err);
  }
});

router.post("/:id", requirePermission("SCREEN", SCOPE_KEY, "edit"), async (req, res, next) => {
  const id = toPositiveInt(req.params.id);
  if (!id) return next(new HttpError(404, res.locals.t("error_not_found")));

  try {
    const columns = await getAssetColumnSupport();
    const existing = await knex("erp.assets").where({ id }).first();
    if (!existing) return next(new HttpError(404, res.locals.t("error_not_found")));
    const values = await validatePayload(req, req.body, { id, existing });
    const approval = await handleScreenApproval({
      req,
      scopeKey: SCOPE_KEY,
      action: "edit",
      entityType: ENTITY_TYPE,
      entityId: id,
      summary: `${res.locals.t("edit")} ${res.locals.t("assets")}`,
      oldValue: existing,
      newValue: values,
      t: res.locals.t,
    });
    if (approval.queued) {
      return res.redirect(req.get("referer") || req.baseUrl);
    }

    const updatePayload = { ...values };
    if (columns.updated_by) updatePayload.updated_by = req.user?.id || null;
    if (columns.updated_at) updatePayload.updated_at = knex.fn.now();
    await knex("erp.assets").where({ id }).update(updatePayload);
    queueAuditLog(req, {
      entityType: ENTITY_TYPE,
      entityId: id,
      action: "UPDATE",
    });
    return res.redirect(req.baseUrl);
  } catch (err) {
    console.error("Error in ReturnableAssetsUpdateService:", err);
    if (err instanceof HttpError) {
      return renderIndex(req, res, {
        error: err.message || res.locals.t("generic_error"),
        modalOpen: true,
        modalMode: "edit",
        values: { ...req.body, id },
      });
    }
    return next(err);
  }
});

router.post("/:id/toggle", requirePermission("SCREEN", SCOPE_KEY, "delete"), async (req, res, next) => {
  const id = toPositiveInt(req.params.id);
  if (!id) return next(new HttpError(404, res.locals.t("error_not_found")));

  try {
    const columns = await getAssetColumnSupport();
    const existing = await knex("erp.assets").select("id", "is_active").where({ id }).first();
    if (!existing) return next(new HttpError(404, res.locals.t("error_not_found")));

    const nextStatus = !existing.is_active;
    const approval = await handleScreenApproval({
      req,
      scopeKey: SCOPE_KEY,
      action: "delete",
      entityType: ENTITY_TYPE,
      entityId: id,
      summary: `${res.locals.t("deactivate")} ${res.locals.t("assets")}`,
      oldValue: existing,
      newValue: { is_active: nextStatus },
      t: res.locals.t,
    });
    if (approval.queued) {
      return res.redirect(req.get("referer") || req.baseUrl);
    }

    const updatePayload = { is_active: nextStatus };
    if (columns.updated_by) updatePayload.updated_by = req.user?.id || null;
    if (columns.updated_at) updatePayload.updated_at = knex.fn.now();
    await knex("erp.assets").where({ id }).update(updatePayload);
    queueAuditLog(req, {
      entityType: ENTITY_TYPE,
      entityId: id,
      action: "DELETE",
    });
    return res.redirect(req.baseUrl);
  } catch (err) {
    console.error("Error in ReturnableAssetsToggleService:", err);
    return next(err);
  }
});

router.post("/:id/delete", requirePermission("SCREEN", SCOPE_KEY, "hard_delete"), async (req, res, next) => {
  const id = toPositiveInt(req.params.id);
  if (!id) return next(new HttpError(404, res.locals.t("error_not_found")));

  try {
    const existing = await knex("erp.assets").where({ id }).first();
    if (!existing) return next(new HttpError(404, res.locals.t("error_not_found")));
    const approval = await handleScreenApproval({
      req,
      scopeKey: SCOPE_KEY,
      action: "delete",
      entityType: ENTITY_TYPE,
      entityId: id,
      summary: `${res.locals.t("delete")} ${res.locals.t("assets")}`,
      oldValue: existing,
      newValue: { _action: "delete" },
      t: res.locals.t,
    });
    if (approval.queued) {
      return res.redirect(req.get("referer") || req.baseUrl);
    }

    const used = await knex("erp.rgp_outward_line").select("voucher_line_id").where({ asset_id: id }).first();
    if (used) {
      await knex("erp.assets").where({ id }).update({
        is_active: false,
        updated_by: req.user ? req.user.id : null,
        updated_at: knex.fn.now(),
      });
    } else {
      await knex("erp.assets").where({ id }).del();
    }
    queueAuditLog(req, {
      entityType: ENTITY_TYPE,
      entityId: id,
      action: "DELETE",
    });
    return res.redirect(req.baseUrl);
  } catch (err) {
    console.error("Error in ReturnableAssetsDeleteService:", err);
    if (err instanceof HttpError) {
      return renderIndex(req, res, {
        error: err.message || res.locals.t("generic_error"),
        modalOpen: false,
        modalMode: "create",
      });
    }
    return next(err);
  }
});

router.preview = {
  page: {
    titleKey: "assets",
    fields: [
      { name: "name" },
      { name: "name_ur" },
      { name: "asset_type_code" },
      { name: "home_branch_id" },
    ],
  },
  hydratePage: async (page, locale, req) => {
    const options = await loadOptions(req || {});
    return {
      ...page,
      locale,
      fields: page.fields.map((field) => {
        if (field.name === "asset_type_code") {
          return { ...field, options: options.assetTypes.map((row) => ({ value: row.code, label: row.name })) };
        }
        if (field.name === "home_branch_id") {
          return { ...field, options: options.branches.map((row) => ({ value: row.id, label: row.name })) };
        }
        return field;
      }),
    };
  },
};

module.exports = router;
