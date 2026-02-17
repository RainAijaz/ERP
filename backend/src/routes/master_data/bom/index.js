const express = require("express");
const knex = require("../../../db/knex");
const { requirePermission } = require("../../../middleware/access/role-permissions");
const { friendlyErrorMessage } = require("../../../middleware/errors/friendly-error");
const { setCookie } = require("../../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../../middleware/core/ui-notice");
const { handleScreenApproval } = require("../../../middleware/approvals/screen-approval");
const { SCREEN_ENTITY_TYPES } = require("../../../utils/approval-entity-map");
const bomService = require("../../../services/bom/service");

const router = express.Router();
const BOM_SCOPE = "master_data.bom";
const BOM_ENTITY_TYPE = SCREEN_ENTITY_TYPES[BOM_SCOPE];
const debugEnabled = process.env.DEBUG_BOM === "1";

const debugBom = (...args) => {
  if (debugEnabled) console.log("[DEBUG][BOM][route]", ...args);
};

const setUiNotice = (res, message, options = {}) => {
  if (!message) return;
  setCookie(res, UI_NOTICE_COOKIE, JSON.stringify({ message, ...options }), { path: "/", maxAge: 30, sameSite: "Lax" });
};

const renderPage = (req, res, view, title, payload = {}) =>
  res.render("base/layouts/main", {
    title,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view,
    t: res.locals.t,
    ...payload,
  });

const buildEmptyFormState = () => ({
  header: {
    id: null,
    bom_no: "",
    item_id: null,
    level: "FINISHED",
    output_qty: 1,
    output_uom_id: null,
    status: "DRAFT",
    version_no: 1,
  },
  rm_lines: [],
  sfg_lines: [],
  labour_lines: [],
  variant_rules: [],
});

const renderForm = async (req, res, params = {}) => {
  const options = await bomService.loadFormOptions(knex, req.locale);
  const formState = params.formState || buildEmptyFormState();
  const formMode = params.formMode || "create";
  const errors = params.errors || [];
  const errorMessage = params.errorMessage || null;
  return renderPage(req, res, "../../master_data/bom/form", formMode === "edit" ? res.locals.t("bom_edit_title") || "Edit BOM" : res.locals.t("bom_new_title") || "Add BOM", {
    options,
    formState,
    formMode,
    errors,
    errorMessage,
    basePath: req.baseUrl,
  });
};

const getSnapshotForApproval = async (id) => {
  const form = await bomService.getBomForForm(knex, id);
  if (!form) return null;
  return {
    header: {
      item_id: form.header.item_id,
      level: form.header.level,
      output_qty: form.header.output_qty,
      output_uom_id: form.header.output_uom_id,
      status: form.header.status,
      version_no: form.header.version_no,
    },
    rm_lines: form.rm_lines,
    sfg_lines: form.sfg_lines,
    labour_lines: form.labour_lines,
    variant_rules: form.variant_rules,
  };
};

const queueOrSaveDraft = async ({ req, res, bomId, input }) => {
  const action = bomId ? "edit" : "create";
  const approvalPayload = bomService.buildApprovalPayload({
    action: bomId ? "update" : "create",
    input,
    bomId: bomId || null,
  });

  const oldValue = bomId ? await getSnapshotForApproval(bomId) : null;
  const approval = await handleScreenApproval({
    req,
    scopeKey: BOM_SCOPE,
    action,
    entityType: BOM_ENTITY_TYPE,
    entityId: bomId || "NEW",
    summary: `${res.locals.t(action === "create" ? "create" : "edit")} ${res.locals.t("bom")}`,
    oldValue,
    newValue: approvalPayload,
    t: res.locals.t,
  });

  if (approval.queued) {
    debugBom("Draft action queued for approval", { action, bomId, requestId: approval.requestId });
    return { queued: true, id: bomId || null };
  }

  const result = await bomService.saveBomDraft(knex, {
    input,
    bomId: bomId || null,
    userId: req.user?.id || null,
    requestId: null,
    t: res.locals.t,
  });
  debugBom("Draft action saved directly", { action, bomId: result.id });
  return { queued: false, id: result.id };
};

const safeJsonArray = (raw) => {
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
};

const buildSubmittedFormState = (reqBody = {}, bomId = null) => ({
  header: {
    id: bomId || null,
    bom_no: reqBody.bom_no || "",
    item_id: reqBody.item_id || null,
    level: reqBody.level || "FINISHED",
    output_qty: reqBody.output_qty || "",
    output_uom_id: reqBody.output_uom_id || "",
    status: "DRAFT",
    version_no: reqBody.version_no || 1,
  },
  rm_lines: safeJsonArray(reqBody.rm_lines_json),
  sfg_lines: safeJsonArray(reqBody.sfg_lines_json),
  labour_lines: safeJsonArray(reqBody.labour_lines_json),
  variant_rules: safeJsonArray(reqBody.variant_rules_json),
});

router.get("/", requirePermission("SCREEN", BOM_SCOPE, "view"), async (req, res, next) => {
  try {
    const filters = {
      q: req.query.q || "",
      status: req.query.status || "",
      level: req.query.level || "",
    };
    const rows = await bomService.listBoms(knex, filters);
    return renderPage(req, res, "../../master_data/bom/index", res.locals.t("bom_list"), {
      rows,
      filters,
      basePath: req.baseUrl,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/new", requirePermission("SCREEN", BOM_SCOPE, "navigate"), async (req, res, next) => {
  try {
    return await renderForm(req, res, { formMode: "create", formState: buildEmptyFormState() });
  } catch (err) {
    return next(err);
  }
});

router.get("/approval", requirePermission("SCREEN", "master_data.bom.approval", "view"), (req, res) => {
  return res.redirect("/administration/approvals?status=PENDING");
});

router.get("/versions", requirePermission("SCREEN", "master_data.bom.versions", "view"), async (req, res, next) => {
  try {
    const filters = {
      item_id: req.query.item_id || "",
      level: req.query.level || "",
    };
    const [rows, options] = await Promise.all([bomService.listVersions(knex, filters), bomService.loadFormOptions(knex, req.locale)]);
    return renderPage(req, res, "../../master_data/bom/versions", res.locals.t("bom_versions"), {
      rows,
      filters,
      options,
      basePath: req.baseUrl,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", requirePermission("SCREEN", BOM_SCOPE, "view"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.redirect(req.baseUrl);
    const formState = await bomService.getBomForForm(knex, id);
    if (!formState) {
      setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
      return res.redirect(req.baseUrl);
    }
    return await renderForm(req, res, { formMode: "edit", formState });
  } catch (err) {
    return next(err);
  }
});

const handleSaveDraft = async (req, res, next, bomId = null) => {
  try {
    const parsed = bomService.parseBomFormPayload(req.body);
    const result = await queueOrSaveDraft({
      req,
      res,
      bomId,
      input: parsed,
    });
    if (result.queued) {
      return res.redirect(req.get("referer") || req.baseUrl);
    }
    setUiNotice(res, res.locals.t("save_changes"), { autoClose: true });
    return res.redirect(`${req.baseUrl}/${result.id}`);
  } catch (err) {
    debugBom("Save draft failed", { bomId, error: err?.message || err });
    if (err?.code === "BOM_VALIDATION") {
      const formState = buildSubmittedFormState(req.body, bomId);
      return await renderForm(req, res, {
        formMode: bomId ? "edit" : "create",
        formState,
        errors: err.details || [],
        errorMessage: err.message,
      });
    }
    const message = friendlyErrorMessage(err, res.locals.t);
    return await renderForm(req, res, {
      formMode: bomId ? "edit" : "create",
      formState: buildSubmittedFormState(req.body, bomId),
      errors: [],
      errorMessage: message,
    });
  }
};

router.post("/save-draft", requirePermission("SCREEN", BOM_SCOPE, "navigate"), async (req, res, next) => handleSaveDraft(req, res, next, null));
router.post("/:id/save-draft", requirePermission("SCREEN", BOM_SCOPE, "navigate"), async (req, res, next) => handleSaveDraft(req, res, next, Number(req.params.id)));

router.post("/:id/send-for-approval", requirePermission("SCREEN", BOM_SCOPE, "navigate"), async (req, res, next) => {
  const bomId = Number(req.params.id);
  if (!bomId) return res.redirect(req.baseUrl);
  try {
    const current = await bomService.getBomForForm(knex, bomId);
    if (!current) {
      setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
      return res.redirect(req.baseUrl);
    }

    if (current.header.status !== "DRAFT") {
      setUiNotice(res, res.locals.t("bom_error_approve_requires_draft") || "Only draft BOM can be approved.", { autoClose: true });
      return res.redirect(`${req.baseUrl}/${bomId}`);
    }

    if (req.user?.isAdmin) {
      await bomService.approveBomDirect(knex, {
        bomId,
        userId: req.user?.id || null,
        requestId: null,
        t: res.locals.t,
      });
      setUiNotice(res, res.locals.t("approval_approved"), { autoClose: true });
      return res.redirect(`${req.baseUrl}/${bomId}`);
    }

    const alreadyPending = await bomService.hasPendingApprovalForBom(knex, bomId);
    if (alreadyPending) {
      setUiNotice(res, res.locals.t("bom_error_already_pending") || "A pending approval already exists for this BOM.", { autoClose: true });
      return res.redirect(`${req.baseUrl}/${bomId}`);
    }

    const approval = await handleScreenApproval({
      req,
      scopeKey: BOM_SCOPE,
      action: "approve",
      entityType: BOM_ENTITY_TYPE,
      entityId: bomId,
      summary: `${res.locals.t("approve")} ${res.locals.t("bom")} #${current.header.bom_no}`,
      oldValue: current,
      newValue: bomService.buildApproveDraftPayload({
        bomId,
        snapshot: current,
      }),
      t: res.locals.t,
    });
    if (!approval.queued) {
      await bomService.approveBomDirect(knex, {
        bomId,
        userId: req.user?.id || null,
        requestId: null,
        t: res.locals.t,
      });
    } else {
      await bomService.setBomPending(knex, {
        bomId,
        t: res.locals.t,
      });
    }

    return res.redirect(`${req.baseUrl}/${bomId}`);
  } catch (err) {
    debugBom("send-for-approval failed", { bomId, error: err?.message || err });
    setUiNotice(res, friendlyErrorMessage(err, res.locals.t), { autoClose: true });
    return res.redirect(`${req.baseUrl}/${bomId}`);
  }
});

router.post("/:id/create-new-version", requirePermission("SCREEN", BOM_SCOPE, "navigate"), async (req, res, next) => {
  const sourceId = Number(req.params.id);
  if (!sourceId) return res.redirect(req.baseUrl);
  try {
    if (!req.user?.isAdmin) {
      const approval = await handleScreenApproval({
        req,
        scopeKey: BOM_SCOPE,
        action: "create",
        entityType: BOM_ENTITY_TYPE,
        entityId: sourceId,
        summary: `${res.locals.t("bom_create_new_version") || "Create new BOM version"} #${sourceId}`,
        oldValue: null,
        newValue: {
          schema_version: 1,
          _action: "create_version_from",
          source_bom_id: sourceId,
        },
        t: res.locals.t,
      });
      if (approval.queued) return res.redirect(`${req.baseUrl}/${sourceId}`);
    }

    const created = await bomService.createNewVersionFromApproved(knex, {
      sourceBomId: sourceId,
      userId: req.user?.id || null,
      t: res.locals.t,
    });
    setUiNotice(res, res.locals.t("bom_version_created") || "New version created.", { autoClose: true });
    return res.redirect(`${req.baseUrl}/${created.id}`);
  } catch (err) {
    debugBom("create-new-version failed", { sourceId, error: err?.message || err });
    setUiNotice(res, friendlyErrorMessage(err, res.locals.t), { autoClose: true });
    return res.redirect(`${req.baseUrl}/${sourceId}`);
  }
});

module.exports = router;
