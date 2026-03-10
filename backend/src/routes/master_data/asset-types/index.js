const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");
const { requirePermission } = require("../../../middleware/access/role-permissions");
const { handleScreenApproval } = require("../../../middleware/approvals/screen-approval");
const { SCREEN_ENTITY_TYPES } = require("../../../utils/approval-entity-map");
const { queueAuditLog } = require("../../../utils/audit-log");
const { generateUniqueCode } = require("../../../utils/entity-code");

const router = express.Router();
const SCOPE_KEY = "master_data.asset_types";
const ENTITY_TYPE = SCREEN_ENTITY_TYPES[SCOPE_KEY];
let assetTypeColumnSupport;

const normalizeCode = (value) =>
  String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

const normalizeText = (value, max = 255) => String(value || "").trim().slice(0, max);

const getAssetTypeColumnSupport = async () => {
  if (assetTypeColumnSupport) return assetTypeColumnSupport;
  const hasNameUr = await knex.schema.withSchema("erp").hasColumn("asset_type_registry", "name_ur");
  assetTypeColumnSupport = {
    name_ur: hasNameUr,
  };
  return assetTypeColumnSupport;
};

const loadRows = async (locale = "en") => {
  const columns = await getAssetTypeColumnSupport();
  return knex("erp.asset_type_registry")
    .select(
      "code as id",
      "code",
      locale === "ur" && columns.name_ur ? knex.raw("COALESCE(name_ur, name) as name") : "name",
      columns.name_ur ? "name_ur" : knex.raw("NULL::text as name_ur"),
      "description",
      "is_active",
    )
    .orderBy("name", "asc");
};

const renderIndex = async (req, res, payload = {}) => {
  const columns = await getAssetTypeColumnSupport();
  const canBrowse = res.locals.can("SCREEN", SCOPE_KEY, "navigate");
  const rows = canBrowse ? await loadRows(req.locale) : [];
  const page = {
    titleKey: "asset_types",
    description: "asset_types_description",
    fields: [
      { name: "name", label: "name" },
      { name: "name_ur", label: "name_ur" },
    ],
  };

  return res.render("base/layouts/main", {
    title: res.locals.t("asset_types"),
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    isAdmin: req.user?.isAdmin || false,
    csrfToken: res.locals.csrfToken,
    view: "../../master_data/asset-types/index",
    t: res.locals.t,
    basePath: req.baseUrl,
    page,
    rows,
    supportsNameUr: columns.name_ur,
    error: null,
    modalOpen: false,
    modalMode: "create",
    ...payload,
  });
};

const validatePayload = async (req, values, options = {}) => {
  const columns = await getAssetTypeColumnSupport();
  const existingCode = normalizeCode(options.existingCode);
  const name = normalizeText(values.name, 120);
  const nameUr = normalizeText(values.name_ur, 120);
  const hasDescriptionInPayload = Object.prototype.hasOwnProperty.call(values || {}, "description");
  const description = hasDescriptionInPayload
    ? normalizeText(values.description, 500) || null
    : options.existingDescription || null;
  const isActive = values.is_active === "on";

  if (!name || (columns.name_ur && !nameUr)) {
    throw new HttpError(400, req.res.locals.t("error_required_fields"));
  }

  let code = existingCode;
  if (!code) {
    const generatedCode = await generateUniqueCode({
      name,
      prefix: "",
      maxLen: 40,
      exists: async (candidate) => {
        const duplicateRow = await knex("erp.asset_type_registry")
          .select("code")
          .whereRaw("lower(code) = ?", [String(candidate || "").toLowerCase()])
          .first();
        return Boolean(duplicateRow);
      },
    });
    code = normalizeCode(generatedCode);
  }

  if (!code || !/^[A-Z0-9_]{2,40}$/.test(code)) {
    throw new HttpError(400, req.res.locals.t("error_invalid_value"));
  }

  const duplicate = await knex("erp.asset_type_registry")
    .select("code")
    .whereRaw("upper(code) = ?", [code])
    .modify((query) => {
      if (existingCode) query.whereRaw("upper(code) <> ?", [String(existingCode).toUpperCase()]);
    })
    .first();
  if (duplicate) {
    const err = new HttpError(400, req.res.locals.t("error_duplicate_code"));
    err.code = "DUPLICATE_CODE";
    throw err;
  }

  return {
    code,
    name,
    ...(columns.name_ur ? { name_ur: nameUr || null } : {}),
    description,
    is_active: isActive,
  };
};

router.get("/", requirePermission("SCREEN", SCOPE_KEY, "view"), async (req, res, next) => {
  try {
    return await renderIndex(req, res);
  } catch (err) {
    console.error("Error in AssetTypesListService:", err);
    return next(err);
  }
});

router.post("/", requirePermission("SCREEN", SCOPE_KEY, "create"), async (req, res, next) => {
  try {
    const values = await validatePayload(req, req.body);
    const approval = await handleScreenApproval({
      req,
      scopeKey: SCOPE_KEY,
      action: "create",
      entityType: ENTITY_TYPE,
      entityId: "NEW",
      summary: `${res.locals.t("create")} ${res.locals.t("asset_types")}`,
      oldValue: null,
      newValue: values,
      t: res.locals.t,
    });
    if (approval.queued) {
      return res.redirect(req.get("referer") || req.baseUrl);
    }

    await knex("erp.asset_type_registry").insert(values);
    queueAuditLog(req, {
      entityType: ENTITY_TYPE,
      entityId: values.code,
      action: "CREATE",
    });
    return res.redirect(req.baseUrl);
  } catch (err) {
    console.error("Error in AssetTypesCreateService:", err);
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

router.post("/:code", requirePermission("SCREEN", SCOPE_KEY, "edit"), async (req, res, next) => {
  const code = normalizeCode(req.params.code);
  if (!code) return next(new HttpError(404, res.locals.t("error_not_found")));

  try {
    const existing = await knex("erp.asset_type_registry").whereRaw("upper(code) = ?", [code]).first();
    if (!existing) return next(new HttpError(404, res.locals.t("error_not_found")));

    const values = await validatePayload(req, req.body, {
      existingCode: existing.code,
      existingDescription: existing.description || null,
    });
    values.code = existing.code;
    const approval = await handleScreenApproval({
      req,
      scopeKey: SCOPE_KEY,
      action: "edit",
      entityType: ENTITY_TYPE,
      entityId: existing.code,
      summary: `${res.locals.t("edit")} ${res.locals.t("asset_types")}`,
      oldValue: existing,
      newValue: values,
      t: res.locals.t,
    });
    if (approval.queued) {
      return res.redirect(req.get("referer") || req.baseUrl);
    }

    await knex("erp.asset_type_registry")
      .whereRaw("upper(code) = ?", [code])
      .update({
        name: values.name,
        description: values.description,
        is_active: values.is_active,
        ...(values.name_ur !== null ? { name_ur: values.name_ur } : {}),
      });
    queueAuditLog(req, {
      entityType: ENTITY_TYPE,
      entityId: existing.code,
      action: "UPDATE",
    });
    return res.redirect(req.baseUrl);
  } catch (err) {
    console.error("Error in AssetTypesUpdateService:", err);
    if (err instanceof HttpError) {
      return renderIndex(req, res, {
        error: err.message || res.locals.t("generic_error"),
        modalOpen: true,
        modalMode: "edit",
        values: { ...req.body, code },
      });
    }
    return next(err);
  }
});

router.post("/:code/toggle", requirePermission("SCREEN", SCOPE_KEY, "delete"), async (req, res, next) => {
  const code = normalizeCode(req.params.code);
  if (!code) return next(new HttpError(404, res.locals.t("error_not_found")));

  try {
    const existing = await knex("erp.asset_type_registry")
      .select("code", "is_active")
      .whereRaw("upper(code) = ?", [code])
      .first();
    if (!existing) return next(new HttpError(404, res.locals.t("error_not_found")));

    const nextStatus = !existing.is_active;
    const approval = await handleScreenApproval({
      req,
      scopeKey: SCOPE_KEY,
      action: "delete",
      entityType: ENTITY_TYPE,
      entityId: existing.code,
      summary: `${res.locals.t("deactivate")} ${res.locals.t("asset_types")}`,
      oldValue: existing,
      newValue: { is_active: nextStatus },
      t: res.locals.t,
    });
    if (approval.queued) {
      return res.redirect(req.get("referer") || req.baseUrl);
    }

    await knex("erp.asset_type_registry")
      .whereRaw("upper(code) = ?", [code])
      .update({ is_active: nextStatus });
    queueAuditLog(req, {
      entityType: ENTITY_TYPE,
      entityId: existing.code,
      action: "DELETE",
    });
    return res.redirect(req.baseUrl);
  } catch (err) {
    console.error("Error in AssetTypesToggleService:", err);
    return next(err);
  }
});

router.post("/:code/delete", requirePermission("SCREEN", SCOPE_KEY, "hard_delete"), async (req, res, next) => {
  const code = normalizeCode(req.params.code);
  if (!code) return next(new HttpError(404, res.locals.t("error_not_found")));

  try {
    const existing = await knex("erp.asset_type_registry").whereRaw("upper(code) = ?", [code]).first();
    if (!existing) return next(new HttpError(404, res.locals.t("error_not_found")));

    const approval = await handleScreenApproval({
      req,
      scopeKey: SCOPE_KEY,
      action: "delete",
      entityType: ENTITY_TYPE,
      entityId: existing.code,
      summary: `${res.locals.t("delete")} ${res.locals.t("asset_types")}`,
      oldValue: existing,
      newValue: { _action: "delete" },
      t: res.locals.t,
    });
    if (approval.queued) {
      return res.redirect(req.get("referer") || req.baseUrl);
    }

    const inUse = await knex("erp.assets")
      .select("id")
      .whereRaw("upper(asset_type_code) = ?", [code])
      .first();
    if (inUse) throw new HttpError(400, res.locals.t("error_record_in_use"));

    await knex("erp.asset_type_registry").whereRaw("upper(code) = ?", [code]).del();
    queueAuditLog(req, {
      entityType: ENTITY_TYPE,
      entityId: existing.code,
      action: "DELETE",
    });
    return res.redirect(req.baseUrl);
  } catch (err) {
    console.error("Error in AssetTypesDeleteService:", err);
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
    titleKey: "asset_types",
    fields: [{ name: "name" }, { name: "name_ur" }],
  },
  hydratePage: async (page, locale) => ({ ...page, locale }),
};

module.exports = router;
