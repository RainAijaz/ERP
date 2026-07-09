const express = require("express");
const knex = require("../../../db/knex");
const {
  requirePermission,
} = require("../../../middleware/access/role-permissions");
const {
  friendlyErrorMessage,
} = require("../../../middleware/errors/friendly-error");
const { setCookie } = require("../../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../../middleware/core/ui-notice");
const {
  handleScreenApproval,
} = require("../../../middleware/approvals/screen-approval");
const { SCREEN_ENTITY_TYPES } = require("../../../utils/approval-entity-map");
const { queueAuditLog } = require("../../../utils/audit-log");
const bomService = require("../../../services/bom/service");
const bomCopyService = require("../../../services/bom/copy-service");
const bomReportsRoutes = require("./reports");
const bomCascadeRoutes = require("./cascade");

const router = express.Router();
const BOM_SCOPE = "master_data.bom";
const BOM_ENTITY_TYPE = SCREEN_ENTITY_TYPES[BOM_SCOPE];
const debugEnabled = process.env.DEBUG_BOM === "1";

const debugBom = (...args) => {
  if (debugEnabled) console.log("[DEBUG][BOM][route]", ...args);
};

const BOM_TYPE_LABELS = { FINISHED: "FG", SEMI_FINISHED: "SFG" };

// Builds a human-friendly BOM label for approval summaries, e.g. "Cotton Shirt (FG)"
// instead of the opaque BOM number. Falls back to the BOM number when the article
// name cannot be resolved.
const buildBomArticleLabel = async (db, { header, bomId } = {}) => {
  let hdr = header;
  if (!hdr && bomId) {
    hdr = await db("erp.bom_header")
      .select("bom_no", "item_id", "level")
      .where({ id: bomId })
      .first();
  }
  if (!hdr) return bomId ? `#${bomId}` : "";
  const itemId = Number(hdr.item_id || 0);
  let name = "";
  if (itemId) {
    const item = await db("erp.items")
      .select("name")
      .where({ id: itemId })
      .first();
    name = item?.name || "";
  }
  const type = BOM_TYPE_LABELS[String(hdr.level || "").toUpperCase()] || "";
  if (name) return type ? `${name} (${type})` : name;
  return hdr.bom_no ? `#${hdr.bom_no}` : bomId ? `#${bomId}` : "";
};

const setUiNotice = (res, message, options = {}) => {
  if (!message) return;
  setCookie(res, UI_NOTICE_COOKIE, JSON.stringify({ message, ...options }), {
    path: "/",
    maxAge: 30,
    sameSite: "Lax",
  });
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

const canAccessBomDraft = (formState, user) => {
  const status = String(formState?.header?.status || "").toUpperCase();
  if (status !== "DRAFT") return true;
  const draftOwnerId = Number(formState?.header?.created_by || 0);
  const viewerId = Number(user?.id || 0);
  return Boolean(draftOwnerId && viewerId && draftOwnerId === viewerId);
};

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
    copied_from_bom_id: null,
  },
  rm_lines: [],
  sfg_lines: [],
  labour_lines: [],
  stage_routes: [],
  variant_rules: [],
  sku_overrides: [],
});

const renderForm = async (req, res, params = {}) => {
  const formState = params.formState || buildEmptyFormState();
  const formMode = params.formMode || "create";
  const options = await bomService.loadFormOptions(knex, req.locale, {
    excludeExistingBomItems: formMode === "create",
    includeItemId: formState?.header?.item_id || null,
    requesterUserId: req.user?.id || null,
  });
  const errors = params.errors || [];
  const errorMessage = params.errorMessage || null;
  return renderPage(
    req,
    res,
    "../../master_data/bom/form",
    formMode === "edit"
      ? res.locals.t("bom_edit_title")
      : res.locals.t("bom_new_title"),
    {
      options,
      formState,
      formMode,
      errors,
      errorMessage,
      basePath: req.baseUrl,
    },
  );
};

const resetBomFromPendingForAdmin = async (bomId, userId) => {
  await knex("erp.approval_request")
    .where({ entity_type: "BOM", entity_id: String(bomId), status: "PENDING" })
    .update({ status: "REJECTED", decided_by: userId || null, decided_at: knex.fn.now() });
  await knex("erp.bom_header")
    .where({ id: bomId })
    .update({ status: "DRAFT", approved_by: null, approved_at: null });
};

const queueOrSaveDraft = async ({ req, res, bomId, input, allowPendingEdit = false }) => {
  const result = await bomService.saveBomDraft(knex, {
    input,
    bomId: bomId || null,
    userId: req.user?.id || null,
    requestId: null,
    t: res.locals.t,
    allowPendingEdit,
  });
  debugBom("Draft action saved directly", { bomId: result.id });
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
    copied_from_bom_id: reqBody.copied_from_bom_id || null,
  },
  rm_lines: safeJsonArray(reqBody.rm_lines_json),
  sfg_lines: safeJsonArray(reqBody.sfg_lines_json),
  labour_lines: safeJsonArray(reqBody.labour_lines_json),
  stage_routes: safeJsonArray(reqBody.stage_routes_json),
  variant_rules: [],
  sku_overrides: [],
});

const requestHasBomDraftPayload = (body = {}) => {
  const keys = [
    "rm_lines_json",
    "sku_rules_json",
    "sfg_lines_json",
    "labour_lines_json",
    "stage_routes_json",
  ];
  return keys.some((key) =>
    Object.prototype.hasOwnProperty.call(body || {}, key),
  );
};

router.get(
  "/",
  requirePermission("SCREEN", BOM_SCOPE, "view"),
  async (req, res, next) => {
    try {
      const rowsRaw = String(req.query.rows || "25")
        .trim()
        .toLowerCase();
      const rowsFilter = ["10", "25", "50", "all"].includes(rowsRaw)
        ? rowsRaw
        : "25";
      const rawStatusQuery = String(req.query.status || "").trim();
      const rawStatusUpper = rawStatusQuery.toUpperCase();
      const rawStatusLower = rawStatusQuery.toLowerCase();
      const legacyWorkflowFromStatus = [
        "DRAFT",
        "PENDING",
        "APPROVED",
        "REJECTED",
      ].includes(rawStatusUpper)
        ? rawStatusUpper
        : "";
      const legacyLifecycleFromStatus = ["active", "inactive", "all"].includes(
        rawStatusLower,
      )
        ? rawStatusLower
        : "";

      const filters = {
        q: req.query.q || "",
        lifecycle: req.query.lifecycle || legacyLifecycleFromStatus || "all",
        workflow:
          req.query.workflow ||
          req.query.stage ||
          legacyWorkflowFromStatus ||
          "all",
        bom_type: req.query.bom_type || req.query.level || "all",
        rows: rowsFilter,
      };
      const rows = await bomService.listBoms(knex, filters, {
        viewerUserId: req.user?.id || null,
      });
      return renderPage(
        req,
        res,
        "../../master_data/bom/index",
        res.locals.t("bom_list"),
        {
          rows: rows,
          filters,
          basePath: req.baseUrl,
        },
      );
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  "/new",
  requirePermission("SCREEN", BOM_SCOPE, "navigate"),
  async (req, res, next) => {
    try {
      const requestedLevel = String(req.query.level || "")
        .trim()
        .toUpperCase();
      const requestedItemId = Number(req.query.item_id || 0);
      const requestedOutputQtyRaw = String(req.query.output_qty || "").trim();
      const requestedOutputQty = Number(requestedOutputQtyRaw || 0);
      const requestedOutputUomId = Number(req.query.output_uom_id || 0);

      if (
        requestedItemId > 0 &&
        ["FINISHED", "SEMI_FINISHED"].includes(requestedLevel)
      ) {
        const existingDraftId = await bomService.findDraftBomByItemLevel(knex, {
          itemId: requestedItemId,
          level: requestedLevel,
          createdBy: req.user?.id || null,
        });
        if (existingDraftId) {
          return res.redirect(`${req.baseUrl}/${existingDraftId}`);
        }
      }

      const formState = buildEmptyFormState();
      if (["FINISHED", "SEMI_FINISHED"].includes(requestedLevel)) {
        formState.header.level = requestedLevel;
      }
      if (requestedItemId > 0) {
        formState.header.item_id = requestedItemId;
      }
      if (Number.isFinite(requestedOutputQty) && requestedOutputQty > 0) {
        formState.header.output_qty = requestedOutputQty;
      }
      if (Number.isFinite(requestedOutputUomId) && requestedOutputUomId > 0) {
        formState.header.output_uom_id = requestedOutputUomId;
      }
      return await renderForm(req, res, { formMode: "create", formState });
    } catch (err) {
      return next(err);
    }
  },
);

router.get(
  "/approval",
  requirePermission("SCREEN", "master_data.bom.approval", "view"),
  (req, res) => {
    return res.redirect("/administration/approvals?status=PENDING");
  },
);

router.use("/reports", bomReportsRoutes);
router.use("/cascade", bomCascadeRoutes);

router.get(
  "/copy-sources",
  requirePermission("SCREEN", BOM_SCOPE, "view"),
  async (req, res) => {
    try {
      const level = String(req.query.level || "")
        .trim()
        .toUpperCase();
      if (!["FINISHED", "SEMI_FINISHED"].includes(level)) {
        return res
          .status(400)
          .json({ ok: false, message: res.locals.t("bom_error_level_required") });
      }
      const sources = await bomCopyService.listApprovedCopySources(knex, {
        level,
        excludeItemId: Number(req.query.exclude_item_id || 0) || null,
      });
      return res.json({ ok: true, sources });
    } catch (err) {
      debugBom("copy-sources failed", err?.message);
      return res
        .status(500)
        .json({ ok: false, message: friendlyErrorMessage(err, res.locals.t) });
    }
  },
);

router.get(
  "/:id/copy-payload",
  requirePermission("SCREEN", BOM_SCOPE, "view"),
  async (req, res) => {
    try {
      const payload = await bomCopyService.buildCopyPayload(knex, {
        sourceBomId: Number(req.params.id || 0),
        targetItemId: Number(req.query.target_item_id || 0),
        targetLevel: String(req.query.target_level || ""),
        sections: String(req.query.sections || ""),
        t: res.locals.t,
        locale: req.locale,
      });
      return res.json({ ok: true, ...payload });
    } catch (err) {
      if (err?.code === "BOM_COPY_INVALID") {
        return res.status(400).json({ ok: false, message: err.message });
      }
      debugBom("copy-payload failed", err?.message);
      return res
        .status(500)
        .json({ ok: false, message: friendlyErrorMessage(err, res.locals.t) });
    }
  },
);

router.get(
  "/:id",
  requirePermission("SCREEN", BOM_SCOPE, "view"),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.redirect(req.baseUrl);
      const formState = await bomService.getBomForForm(knex, id);
      if (!formState) {
        setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
        return res.redirect(req.baseUrl);
      }
      if (!canAccessBomDraft(formState, req.user)) {
        setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
        return res.redirect(req.baseUrl);
      }
      return await renderForm(req, res, { formMode: "edit", formState });
    } catch (err) {
      return next(err);
    }
  },
);

const handleSaveDraft = async (req, res, next, bomId = null) => {
  const toSingleText = (raw) =>
    Array.isArray(raw)
      ? String(raw.find((v) => String(v || "").trim()) || "").trim()
      : String(raw || "").trim();
  const switchAfterSave = toSingleText(req.body?.switch_after_save) === "1";
  const switchLevel = toSingleText(req.body?.switch_level).toUpperCase();
  const switchItemId = Number(toSingleText(req.body?.switch_item_id) || 0);
  const switchOutputQtyRaw = toSingleText(req.body?.switch_output_qty);
  const switchOutputQty = Number(switchOutputQtyRaw || 0);
  const switchOutputUomId = Number(
    toSingleText(req.body?.switch_output_uom_id) || 0,
  );
  let targetBomId = bomId || null;
  try {
    let currentBom = null;
    if (bomId) {
      currentBom = await bomService.getBomForForm(knex, bomId);
      if (!currentBom) {
        setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
        return res.redirect(req.baseUrl);
      }
      if (!canAccessBomDraft(currentBom, req.user)) {
        setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
        return res.redirect(req.baseUrl);
      }
    }
    const parsed = bomService.parseBomFormPayload(req.body);
    const isPendingAdminSave = Boolean(req.user?.isAdmin && currentBom?.header?.status === "PENDING");
    const result = await queueOrSaveDraft({
      req,
      res,
      bomId,
      input: parsed,
      allowPendingEdit: isPendingAdminSave,
    });
    targetBomId = result.id || targetBomId;
    if (
      switchAfterSave &&
      switchItemId > 0 &&
      ["FINISHED", "SEMI_FINISHED"].includes(switchLevel)
    ) {
      const existingDraftId = await bomService.findDraftBomByItemLevel(knex, {
        itemId: switchItemId,
        level: switchLevel,
        excludeBomId: result.id || null,
        createdBy: req.user?.id || null,
      });
      if (existingDraftId) {
        return res.redirect(`${req.baseUrl}/${existingDraftId}`);
      }
      const query = new URLSearchParams({
        level: switchLevel,
        item_id: String(switchItemId),
      });
      if (Number.isFinite(switchOutputQty) && switchOutputQty > 0) {
        query.set("output_qty", String(switchOutputQty));
      }
      if (Number.isFinite(switchOutputUomId) && switchOutputUomId > 0) {
        query.set("output_uom_id", String(switchOutputUomId));
      }
      return res.redirect(`${req.baseUrl}/new?${query.toString()}`);
    }
    if (result.queued) {
      return res.redirect(req.get("referer") || req.baseUrl);
    }
    const submitIntent = toSingleText(req.body?.submit_intent);
    if (submitIntent === "send_for_approval" && result.id) {
      return res.redirect(307, `${req.baseUrl}/${result.id}/send-for-approval`);
    }
    queueAuditLog(req, {
      entityType: BOM_ENTITY_TYPE,
      entityId: result.id,
      action: bomId ? "UPDATE" : "CREATE",
    });
    setUiNotice(res, res.locals.t("draft_saved"), { autoClose: true });
    return res.redirect(`${req.baseUrl}/${result.id}`);
  } catch (err) {
    debugBom("Save draft failed", { bomId, error: err?.message || err });
    if (err?.code === "BOM_VALIDATION") {
      const formState = buildSubmittedFormState(req.body, targetBomId);
      return await renderForm(req, res, {
        formMode: targetBomId ? "edit" : "create",
        formState,
        errors: err.details || [],
        errorMessage: err.message,
      });
    }
    const message = friendlyErrorMessage(err, res.locals.t);
    return await renderForm(req, res, {
      formMode: targetBomId ? "edit" : "create",
      formState: buildSubmittedFormState(req.body, targetBomId),
      errors: [],
      errorMessage: message,
    });
  }
};

router.post(
  "/save-draft",
  requirePermission("SCREEN", BOM_SCOPE, "navigate"),
  async (req, res, next) => handleSaveDraft(req, res, next, null),
);
router.post(
  "/:id/save-draft",
  requirePermission("SCREEN", BOM_SCOPE, "navigate"),
  async (req, res, next) =>
    handleSaveDraft(req, res, next, Number(req.params.id)),
);

router.post(
  "/:id/approve-draft",
  requirePermission("SCREEN", BOM_SCOPE, "navigate"),
  async (req, res, next) => {
    const bomId = Number(req.params.id);
    if (!bomId) return res.redirect(req.baseUrl);
    if (!req.user?.isAdmin) {
      setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
      return res.redirect(req.baseUrl);
    }
    let current = null;
    try {
      current = await bomService.getBomForForm(knex, bomId);
      if (!current) {
        setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
        return res.redirect(req.baseUrl);
      }
      if (!canAccessBomDraft(current, req.user)) {
        setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
        return res.redirect(req.baseUrl);
      }
      if (current.header.status === "PENDING") {
        await resetBomFromPendingForAdmin(bomId, req.user?.id);
        current = await bomService.getBomForForm(knex, bomId);
      }
      if (current.header.status !== "DRAFT") {
        setUiNotice(res, res.locals.t("bom_error_approve_requires_draft"), {
          autoClose: true,
        });
        return res.redirect(`${req.baseUrl}/${bomId}`);
      }

      if (requestHasBomDraftPayload(req.body)) {
        const parsed = bomService.parseBomFormPayload(req.body);
        await queueOrSaveDraft({
          req,
          res,
          bomId,
          input: parsed,
        });
        current = await bomService.getBomForForm(knex, bomId);
      }

      await bomService.validateDraftReadyForApproval(knex, {
        bomId,
        t: res.locals.t,
        locale: req.locale,
        intent: "approve",
      });

      await bomService.approveBomDirect(knex, {
        bomId,
        userId: req.user?.id || null,
        requestId: null,
        t: res.locals.t,
      });
      queueAuditLog(req, {
        entityType: BOM_ENTITY_TYPE,
        entityId: bomId,
        action: "APPROVE",
      });
      const { message: approvedNoticeMessage, hasDependents, reviewUrl } =
        await bomCopyService.buildApprovedNoticeMessage(knex, {
          itemId: current.header.item_id,
          level: current.header.level,
          excludeBomId: bomId,
          baseMessage: res.locals.t("approval_approved"),
          t: res.locals.t,
        });
      setUiNotice(
        res,
        approvedNoticeMessage,
        hasDependents
          ? { link: { href: reviewUrl, label: res.locals.t("bom_cascade_review_link") } }
          : { autoClose: true },
      );
      return res.redirect(`${req.baseUrl}/${bomId}`);
    } catch (err) {
      debugBom("approve-draft failed", { bomId, error: err?.message || err });
      if (err?.code === "BOM_VALIDATION") {
        const formState = current || (await bomService.getBomForForm(knex, bomId));
        if (formState) {
          return await renderForm(req, res, {
            formMode: "edit",
            formState,
            errors: err.details || [],
            errorMessage: err.message,
          });
        }
      }
      const message = friendlyErrorMessage(err, res.locals.t);
      const formState =
        current || (await bomService.getBomForForm(knex, bomId));
      if (formState) {
        return await renderForm(req, res, {
          formMode: "edit",
          formState,
          errors: [],
          errorMessage: message,
        });
      }
      setUiNotice(res, message, { autoClose: true });
      return res.redirect(`${req.baseUrl}/${bomId}`);
    }
  },
);

router.post(
  "/:id/send-for-approval",
  requirePermission("SCREEN", BOM_SCOPE, "navigate"),
  async (req, res, next) => {
    const bomId = Number(req.params.id);
    if (!bomId) return res.redirect(req.baseUrl);
    let current = null;
    try {
      current = await bomService.getBomForForm(knex, bomId);
      if (!current) {
        setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
        return res.redirect(req.baseUrl);
      }
      if (!canAccessBomDraft(current, req.user)) {
        setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
        return res.redirect(req.baseUrl);
      }

      if (current.header.status !== "DRAFT") {
        setUiNotice(res, res.locals.t("bom_error_approve_requires_draft"), {
          autoClose: true,
        });
        return res.redirect(`${req.baseUrl}/${bomId}`);
      }

      if (requestHasBomDraftPayload(req.body)) {
        const parsed = bomService.parseBomFormPayload(req.body);
        await queueOrSaveDraft({
          req,
          res,
          bomId,
          input: parsed,
        });
        current = await bomService.getBomForForm(knex, bomId);
      }

      await bomService.validateDraftReadyForApproval(knex, {
        bomId,
        t: res.locals.t,
        locale: req.locale,
        intent: "send",
      });

      if (req.user?.isAdmin) {
        await bomService.approveBomDirect(knex, {
          bomId,
          userId: req.user?.id || null,
          requestId: null,
          t: res.locals.t,
        });
        queueAuditLog(req, {
          entityType: BOM_ENTITY_TYPE,
          entityId: bomId,
          action: "APPROVE",
        });
        const { message: approvedNoticeMessage, hasDependents, reviewUrl } =
          await bomCopyService.buildApprovedNoticeMessage(knex, {
            itemId: current.header.item_id,
            level: current.header.level,
            excludeBomId: bomId,
            baseMessage: res.locals.t("approval_approved"),
            t: res.locals.t,
          });
        setUiNotice(
          res,
          approvedNoticeMessage,
          hasDependents
            ? { link: { href: reviewUrl, label: res.locals.t("bom_cascade_review_link") } }
            : { autoClose: true },
        );
        return res.redirect(`${req.baseUrl}/${bomId}`);
      }

      const alreadyPending = await bomService.hasPendingApprovalForBomTarget(
        knex,
        {
          bomId,
          itemId: current?.header?.item_id || null,
          actions: ["approve_draft"],
        },
      );
      if (alreadyPending) {
        setUiNotice(res, res.locals.t("bom_error_already_pending"), {
          autoClose: true,
        });
        return res.redirect(`${req.baseUrl}/${bomId}`);
      }

      const approval = await handleScreenApproval({
        req,
        scopeKey: BOM_SCOPE,
        action: "approve",
        entityType: BOM_ENTITY_TYPE,
        entityId: bomId,
        summary: `${res.locals.t("approve")} ${res.locals.t("bom")} ${await buildBomArticleLabel(knex, { header: current.header })}`,
        oldValue: current,
        newValue: bomService.buildApproveDraftPayload({
          bomId,
          snapshot: current,
        }),
        t: res.locals.t,
        forceQueue: true,
      });
      if (approval.queued) {
        await bomService.setBomPending(knex, {
          bomId,
          t: res.locals.t,
        });
        queueAuditLog(req, {
          entityType: BOM_ENTITY_TYPE,
          entityId: bomId,
          action: "REQUEST_APPROVAL",
        });
      } else {
        setUiNotice(res, res.locals.t("generic_error"), { autoClose: true });
      }

      return res.redirect(`${req.baseUrl}/${bomId}`);
    } catch (err) {
      debugBom("send-for-approval failed", {
        bomId,
        error: err?.message || err,
      });
      if (err?.code === "BOM_VALIDATION") {
        const formState = current || (await bomService.getBomForForm(knex, bomId));
        if (formState) {
          return await renderForm(req, res, {
            formMode: "edit",
            formState,
            errors: err.details || [],
            errorMessage: err.message,
          });
        }
      }
      const message = friendlyErrorMessage(err, res.locals.t);
      const formState =
        current || (await bomService.getBomForForm(knex, bomId));
      if (formState) {
        return await renderForm(req, res, {
          formMode: "edit",
          formState,
          errors: [],
          errorMessage: message,
        });
      }
      setUiNotice(res, message, { autoClose: true });
      return res.redirect(`${req.baseUrl}/${bomId}`);
    }
  },
);

router.post(
  "/:id/delete-draft",
  requirePermission("SCREEN", BOM_SCOPE, "navigate"),
  async (req, res, next) => {
    const bomId = Number(req.params.id);
    if (!bomId) return res.redirect(req.baseUrl);
    try {
      const current = await bomService.getBomForForm(knex, bomId);
      if (!current) {
        setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
        return res.redirect(req.baseUrl);
      }
      if (!canAccessBomDraft(current, req.user)) {
        setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
        return res.redirect(req.baseUrl);
      }
      if (String(current.header?.status || "").toUpperCase() !== "DRAFT") {
        setUiNotice(res, res.locals.t("bom_error_only_draft_editable"), {
          autoClose: true,
        });
        return res.redirect(`${req.baseUrl}/${bomId}`);
      }

      await bomService.deleteDraftBom(knex, {
        bomId,
        userId: req.user?.id || null,
        isAdmin: Boolean(req.user?.isAdmin),
        t: res.locals.t,
      });
      queueAuditLog(req, {
        entityType: BOM_ENTITY_TYPE,
        entityId: bomId,
        action: "DELETE",
      });
      setUiNotice(
        res,
        res.locals.t("deleted_successfully") || res.locals.t("save_changes"),
        { autoClose: true },
      );
      return res.redirect(req.baseUrl);
    } catch (err) {
      setUiNotice(res, friendlyErrorMessage(err, res.locals.t), {
        autoClose: true,
      });
      return res.redirect(req.get("referer") || req.baseUrl);
    }
  },
);

router.post(
  "/:id/create-new-version",
  requirePermission("SCREEN", BOM_SCOPE, "navigate"),
  async (req, res, next) => {
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
          summary: `${res.locals.t("bom_create_new_version")} ${await buildBomArticleLabel(knex, { bomId: sourceId })}`,
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
      queueAuditLog(req, {
        entityType: BOM_ENTITY_TYPE,
        entityId: created.id,
        action: "CREATE_VERSION",
      });
      setUiNotice(res, res.locals.t("bom_version_created"), {
        autoClose: true,
      });
      return res.redirect(`${req.baseUrl}/${created.id}`);
    } catch (err) {
      debugBom("create-new-version failed", {
        sourceId,
        error: err?.message || err,
      });
      setUiNotice(res, friendlyErrorMessage(err, res.locals.t), {
        autoClose: true,
      });
      return res.redirect(`${req.baseUrl}/${sourceId}`);
    }
  },
);

router.post(
  "/:id/toggle-lifecycle",
  requirePermission("SCREEN", BOM_SCOPE, "delete"),
  async (req, res, next) => {
    const bomId = Number(req.params.id);
    if (!bomId) return res.redirect(req.baseUrl);
    try {
      const current = await bomService.getBomForForm(knex, bomId);
      if (!current) {
        setUiNotice(res, res.locals.t("error_not_found"), { autoClose: true });
        return res.redirect(req.baseUrl);
      }
      if (String(current.header?.status || "").toUpperCase() !== "APPROVED") {
        setUiNotice(
          res,
          res.locals.t("bom_error_lifecycle_requires_approved"),
          { autoClose: true },
        );
        return res.redirect(req.get("referer") || req.baseUrl);
      }
      const nextIsActive = !(current.header?.is_active !== false);
      const actionLabel = nextIsActive
        ? res.locals.t("activate")
        : res.locals.t("deactivate");

      const approval = await handleScreenApproval({
        req,
        scopeKey: BOM_SCOPE,
        action: "delete",
        entityType: BOM_ENTITY_TYPE,
        entityId: bomId,
        summary: `${actionLabel} ${res.locals.t("bom")} ${await buildBomArticleLabel(knex, { header: current.header, bomId })}`,
        oldValue: {
          id: current.header?.id || bomId,
          is_active: current.header?.is_active !== false,
        },
        newValue: {
          schema_version: 1,
          _action: "toggle_lifecycle",
          bom_id: bomId,
          is_active: nextIsActive,
        },
        t: res.locals.t,
      });

      if (!approval.queued) {
        await bomService.toggleBomLifecycle(knex, {
          bomId,
          isActive: nextIsActive,
          t: res.locals.t,
        });
        queueAuditLog(req, {
          entityType: BOM_ENTITY_TYPE,
          entityId: bomId,
          action: nextIsActive ? "ACTIVATE" : "DEACTIVATE",
        });
      }

      setUiNotice(res, res.locals.t("save_changes"), { autoClose: true });
      return res.redirect(req.get("referer") || req.baseUrl);
    } catch (err) {
      setUiNotice(res, friendlyErrorMessage(err, res.locals.t), {
        autoClose: true,
      });
      return res.redirect(req.get("referer") || req.baseUrl);
    }
  },
);

module.exports = router;
