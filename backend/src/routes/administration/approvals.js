const express = require("express");
const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { applyMasterDataChange } = require("../../utils/approval-applier");
const { navConfig, getNavScopes } = require("../../utils/nav-config");
const { BASIC_INFO_ENTITY_TYPES, SCREEN_ENTITY_TYPES } = require("../../utils/approval-entity-map");
const { resolveApprovalPreview } = require("../../utils/approval-preview-registry");
const { notifyApprovalDecision } = require("../../utils/approval-events");
const { setCookie } = require("../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../middleware/core/ui-notice");
const basicInfoRoutes = require("../master_data/basic-info");
const uomConversionsRoutes = require("../master_data/basic-info/uom-conversions");
const accountsRoutes = require("../master_data/accounts");
const partiesRoutes = require("../master_data/parties");
const finishedRoutes = require("../master_data/products/finished");
const rawMaterialsRoutes = require("../master_data/products/raw-materials");
const semiFinishedRoutes = require("../master_data/products/semi-finished");
const skuRoutes = require("../master_data/products/skus");

const router = express.Router();

// Helper for rendering
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

const setUiNotice = (res, message, options = {}) => {
  if (!message) return;
  setCookie(res, UI_NOTICE_COOKIE, JSON.stringify({ message, ...options }), { path: "/", maxAge: 30, sameSite: "Lax" });
};

const insertActivityLog = async (trx, payload) => {
  if (!payload?.entity_type || !payload?.entity_id || !payload?.action) return;
  await trx("erp.activity_log").insert({
    branch_id: payload.branch_id || null,
    user_id: payload.user_id || null,
    entity_type: payload.entity_type,
    entity_id: String(payload.entity_id),
    voucher_type_code: payload.voucher_type_code || null,
    action: payload.action,
    ip_address: payload.ip_address || null,
  });
};

const ACTION_LABELS = {
  create: "create",
  update: "edit",
  delete: "delete",
};

const ENTITY_TO_BASIC_INFO = Object.entries(BASIC_INFO_ENTITY_TYPES).reduce((acc, [key, value]) => {
  acc[value] = key;
  return acc;
}, {});

const ENTITY_TO_SCREEN = Object.entries(SCREEN_ENTITY_TYPES).reduce((acc, [screen, entity]) => {
  acc[entity] = screen;
  return acc;
}, {});

const inferAction = (request) => {
  if (request?.new_value?._action) {
    if (request.new_value._action === "toggle") return "delete";
    return request.new_value._action === "update" ? "update" : request.new_value._action;
  }
  if (request?.new_value && request?.entity_id === "NEW") return "create";
  if (!request?.new_value && request?.old_value) return "delete";
  return "update";
};

const getPreviewValues = (request, side) => {
  if (side === "old") return request?.old_value || null;
  return request?.new_value || null;
};

const normalizeArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return Object.values(value);
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const compactJoin = (parts) =>
  parts
    .map((part) => (part == null ? "" : String(part).trim()))
    .filter(Boolean)
    .join(" ");

const buildSkuLabel = ({ skuCode, itemName, sizeName, packingName, gradeName, colorName, suffix }) => {
  const detailed = compactJoin([itemName, sizeName, packingName, gradeName, colorName, suffix]);
  if (detailed) return detailed;
  return skuCode || "-";
};

const safeJson = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
};

const buildPreviewPayload = async (req, res, request, side) => {
  const action = inferAction(request);
  const values = getPreviewValues(request, side) || {};
  const entityType = request.entity_type;
  const locale = req.locale;

  const basePayload = {
    previewAction: action,
    previewLabel: res.locals.t(ACTION_LABELS[action] || action) || action,
    previewValues: values,
    locale,
  };

  const basicInfoKey = ENTITY_TO_BASIC_INFO[entityType];
  if (basicInfoKey) {
    if (basicInfoKey === "uom-conversions") {
      const uoms = await uomConversionsRoutes.preview.fetchUoms();
      return {
        ...basePayload,
        previewType: "basic-info-uom",
        previewTitle: res.locals.t("uom_conversions") || "UOM Conversions",
        formPartial: "../../master_data/basic-info/uom-conversions/form-fields.ejs",
        uoms,
      };
    }

    const page = basicInfoRoutes.preview.getPageConfig(basicInfoKey);
    if (!page) return null;
    const hydrated = await basicInfoRoutes.preview.hydratePage(page, locale);
    return {
      ...basePayload,
      previewType: "basic-info",
      previewTitle: res.locals.t(page.titleKey) || page.titleKey,
      formPartial: "../../master_data/basic-info/form-fields.ejs",
      page: hydrated,
      isAdmin: req.user?.isAdmin || false,
    };
  }

  const screen = ENTITY_TO_SCREEN[entityType];
  if (screen === "master_data.accounts") {
    const hydrated = await accountsRoutes.preview.hydratePage(accountsRoutes.preview.page, locale);
    return {
      ...basePayload,
      previewType: "accounts",
      previewTitle: res.locals.t("accounts") || "Accounts",
      formPartial: "../../master_data/accounts/form-fields.ejs",
      page: hydrated,
      isAdmin: req.user?.isAdmin || false,
    };
  }

  if (screen === "master_data.parties") {
    const hydrated = await partiesRoutes.preview.hydratePage(partiesRoutes.preview.page, locale);
    return {
      ...basePayload,
      previewType: "parties",
      previewTitle: res.locals.t("parties") || "Parties",
      formPartial: "../../master_data/parties/form-fields.ejs",
      page: hydrated,
      isAdmin: req.user?.isAdmin || false,
    };
  }

  if (entityType === "ITEM") {
    const itemType = (values.item_type || request?.old_value?.item_type || request?.new_value?.item_type || "").toUpperCase();
    if (itemType === rawMaterialsRoutes.preview.ITEM_TYPE) {
      const options = await rawMaterialsRoutes.preview.loadOptions();
      return {
        ...basePayload,
        previewType: "raw-materials",
        previewTitle: res.locals.t("raw_materials") || "Raw Materials",
        formPartial: "../../master_data/products/raw-materials/form-fields.ejs",
        ...options,
      };
    }
    if (itemType === semiFinishedRoutes.preview.ITEM_TYPE) {
      const options = await semiFinishedRoutes.preview.loadOptions();
      return {
        ...basePayload,
        previewType: "semi-finished",
        previewTitle: res.locals.t("semi_finished") || "Semi Finished",
        formPartial: "../../master_data/products/semi-finished/form-fields.ejs",
        ...options,
      };
    }
    if (itemType === finishedRoutes.preview.ITEM_TYPE) {
      const options = await finishedRoutes.preview.loadOptions();
      return {
        ...basePayload,
        previewType: "finished",
        previewTitle: res.locals.t("finished") || "Finished",
        formPartial: "../../master_data/products/finished/form-fields.ejs",
        ...options,
      };
    }
  }

  if (entityType === "SKU") {
    let itemType = "FG";
    let lookupValues = values;
    const entityId = request.entity_id;
    if (entityId && entityId !== "NEW") {
      const variant = await knex("erp.variants as v").select("v.item_id", "v.size_id", "v.grade_id", "v.color_id", "v.packing_type_id", "v.sale_rate", "i.item_type").leftJoin("erp.items as i", "v.item_id", "i.id").where("v.id", Number(entityId)).first();
      if (variant) {
        itemType = variant.item_type === "SFG" ? "SFG" : "FG";
        lookupValues = {
          ...values,
          item_id: values.item_id || variant.item_id,
          size_id: values.size_id || variant.size_id,
          grade_id: values.grade_id || variant.grade_id,
          color_id: values.color_id || variant.color_id,
          packing_type_id: values.packing_type_id || variant.packing_type_id,
          sale_rate: values.sale_rate || variant.sale_rate,
        };
      }
    } else if (values.item_type) {
      itemType = values.item_type === "SFG" ? "SFG" : "FG";
    }

    const options = await skuRoutes.preview.loadOptions(itemType);
    const normalized = {
      ...lookupValues,
      size_ids: normalizeArray(lookupValues.size_ids || lookupValues.size_id),
      grade_ids: normalizeArray(lookupValues.grade_ids || lookupValues.grade_id),
      color_ids: normalizeArray(lookupValues.color_ids || lookupValues.color_id),
      packing_type_ids: normalizeArray(lookupValues.packing_type_ids || lookupValues.packing_type_id),
    };

    return {
      ...basePayload,
      previewValues: normalized,
      previewType: "skus",
      previewTitle: res.locals.t("skus") || "SKUs",
      formPartial: "../../administration/approvals/preview-sku-compact.ejs",
      ...options,
    };
  }

  return null;
};

// GET / - Dashboard
router.get("/", requirePermission("SCREEN", "administration.approvals", "navigate"), async (req, res, next) => {
  try {
    const status = (req.query.status || "PENDING").toUpperCase();

    const rowsQuery = knex("erp.approval_request as ar")
      .select("ar.*", "u.username as requester_name", "v.id as variant_id")
      .leftJoin("erp.users as u", "ar.requested_by", "u.id")
      // Left join variant to get SKU context if entity_type is SKU
      .leftJoin("erp.variants as v", function () {
        this.on("ar.entity_id", "=", knex.raw("CAST(v.id AS TEXT)")).andOn("ar.entity_type", "=", knex.raw("'SKU'"));
      })
      .where("ar.status", status)
      .orderBy("ar.requested_at", "desc");

    if (!req.user?.isAdmin) {
      rowsQuery.andWhere("ar.requested_by", req.user.id);
    }

    const rows = await rowsQuery;

    const skuRows = rows.filter((row) => row.entity_type === "SKU");
    if (skuRows.length) {
      const newValueRows = skuRows.map((row) => ({ row, values: safeJson(row.new_value) })).filter((entry) => entry.values);

      const itemIds = new Set();
      const sizeIds = new Set();
      const gradeIds = new Set();
      const colorIds = new Set();
      const packingIds = new Set();

      newValueRows.forEach(({ values }) => {
        if (values.item_id) itemIds.add(Number(values.item_id));
        if (values.size_id) sizeIds.add(Number(values.size_id));
        if (values.grade_id) gradeIds.add(Number(values.grade_id));
        if (values.color_id) colorIds.add(Number(values.color_id));
        if (values.packing_type_id) packingIds.add(Number(values.packing_type_id));
      });

      const variantIds = skuRows.map((row) => Number(row.entity_id)).filter((id) => Number.isFinite(id) && id > 0);

      const [items, sizes, grades, colors, packings, variants] = await Promise.all([
        itemIds.size
          ? knex("erp.items")
              .select("id", "name", "code")
              .whereIn("id", [...itemIds])
          : Promise.resolve([]),
        sizeIds.size
          ? knex("erp.sizes")
              .select("id", "name")
              .whereIn("id", [...sizeIds])
          : Promise.resolve([]),
        gradeIds.size
          ? knex("erp.grades")
              .select("id", "name")
              .whereIn("id", [...gradeIds])
          : Promise.resolve([]),
        colorIds.size
          ? knex("erp.colors")
              .select("id", "name")
              .whereIn("id", [...colorIds])
          : Promise.resolve([]),
        packingIds.size
          ? knex("erp.packing_types")
              .select("id", "name")
              .whereIn("id", [...packingIds])
          : Promise.resolve([]),
        variantIds.length
          ? knex("erp.variants as v")
              .select("v.id", "i.name as item_name", "s.name as size_name", "g.name as grade_name", "c.name as color_name", "p.name as packing_name", "k.sku_code")
              .leftJoin("erp.items as i", "v.item_id", "i.id")
              .leftJoin("erp.sizes as s", "v.size_id", "s.id")
              .leftJoin("erp.grades as g", "v.grade_id", "g.id")
              .leftJoin("erp.colors as c", "v.color_id", "c.id")
              .leftJoin("erp.packing_types as p", "v.packing_type_id", "p.id")
              .leftJoin("erp.skus as k", "k.variant_id", "v.id")
              .whereIn("v.id", variantIds)
          : Promise.resolve([]),
      ]);

      const itemMap = new Map(items.map((row) => [row.id, row.name]));
      const sizeMap = new Map(sizes.map((row) => [row.id, row.name]));
      const gradeMap = new Map(grades.map((row) => [row.id, row.name]));
      const colorMap = new Map(colors.map((row) => [row.id, row.name]));
      const packingMap = new Map(packings.map((row) => [row.id, row.name]));
      const variantMap = new Map(
        variants.map((row) => [
          row.id,
          buildSkuLabel({
            skuCode: row.sku_code,
            itemName: row.item_name,
            sizeName: row.size_name,
            packingName: row.packing_name,
            gradeName: row.grade_name,
            colorName: row.color_name,
          }),
        ]),
      );

      for (const row of skuRows) {
        const values = safeJson(row.new_value);
        const isNew = row.entity_id === "NEW";
        let label = null;
        if (values && values._summary) {
          label = String(values._summary);
        } else if (isNew && values) {
          label = buildSkuLabel({
            itemName: itemMap.get(Number(values.item_id)),
            sizeName: sizeMap.get(Number(values.size_id)),
            packingName: packingMap.get(Number(values.packing_type_id)),
            gradeName: gradeMap.get(Number(values.grade_id)),
            colorName: values.color_id ? colorMap.get(Number(values.color_id)) : null,
          });
        } else if (!isNew) {
          label = variantMap.get(Number(row.entity_id)) || null;
          if (!label && Number.isFinite(Number(row.entity_id))) {
            const fallback = await knex("erp.variants as v")
              .select("v.id", "i.name as item_name", "s.name as size_name", "g.name as grade_name", "c.name as color_name", "p.name as packing_name", "k.sku_code")
              .leftJoin("erp.items as i", "v.item_id", "i.id")
              .leftJoin("erp.sizes as s", "v.size_id", "s.id")
              .leftJoin("erp.grades as g", "v.grade_id", "g.id")
              .leftJoin("erp.colors as c", "v.color_id", "c.id")
              .leftJoin("erp.packing_types as p", "v.packing_type_id", "p.id")
              .leftJoin("erp.skus as k", "k.variant_id", "v.id")
              .where("v.id", Number(row.entity_id))
              .first();
            if (fallback) {
              label = buildSkuLabel({
                skuCode: fallback.sku_code,
                itemName: fallback.item_name,
                sizeName: fallback.size_name,
                packingName: fallback.packing_name,
                gradeName: fallback.grade_name,
                colorName: fallback.color_name,
              });
            }
          }
        }

        if (label && row.summary) {
          if (row.summary.startsWith("New Variant:")) {
            row.summary = `New Variant: ${label}`;
          } else if (!row.summary.includes(label)) {
            row.summary = `${row.summary}: ${label}`;
          }
        }
      }
    }

    renderPage(req, res, "../../administration/approvals/index", res.locals.t("approvals"), {
      rows,
      currentStatus: status,
      basePath: req.baseUrl,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/preview", requirePermission("SCREEN", "administration.approvals", "navigate"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new HttpError(400, res.locals.t("error_invalid_id")));
  const side = req.query.side === "old" ? "old" : "new";

  try {
    const request = await knex("erp.approval_request").where({ id }).first();
    if (!request) return next(new HttpError(404, res.locals.t("approval_request_not_found")));
    if (process.env.DEBUG_APPROVAL_PREVIEW === "1") {
      console.log("[APPROVAL PREVIEW DEBUG] request", {
        id: request.id,
        side,
        entityType: request.entity_type,
        entityId: request.entity_id,
        oldType: typeof request.old_value,
        newType: typeof request.new_value,
      });
    }

    // First try globally-registered preview providers.
    const payload = (await resolveApprovalPreview({ req, res, request, side })) || (await buildPreviewPayload(req, res, request, side));
    if (process.env.DEBUG_APPROVAL_PREVIEW === "1") {
      console.log("[APPROVAL PREVIEW DEBUG] payload", {
        id: request.id,
        side,
        hasPayload: Boolean(payload),
        previewType: payload?.previewType || null,
        formPartial: payload?.formPartial || null,
        previewValuesType: typeof payload?.previewValues,
        previewValueKeys: payload?.previewValues && typeof payload.previewValues === "object" ? Object.keys(payload.previewValues) : null,
      });
    }
    if (!payload) {
      return res.status(204).send("");
    }

    return res.render("administration/approvals/preview", {
      t: res.locals.t,
      locale: req.locale,
      ...payload,
    });
  } catch (err) {
    next(err);
  }
});

// GET /settings - Approval policy settings (voucher types + screens)
router.get("/settings", requirePermission("SCREEN", "administration.approval_settings", "navigate"), async (req, res, next) => {
  try {
    const [voucherTypes, policyRows] = await Promise.all([knex("erp.voucher_type").select("code", "name").orderBy("name"), knex("erp.approval_policy").select("entity_type", "entity_key", "action", "requires_approval")]);

    const excludedScreens = new Set(["administration.audit_logs", "administration.approvals", "administration.approval_settings", "administration.permissions", "administration.branches"]);

    const shouldIncludeScreen = (scopeKey, route) => {
      if (!scopeKey) return false;
      if (scopeKey.startsWith("administration.")) return false;
      if (excludedScreens.has(scopeKey)) return false;
      if (scopeKey.includes(".approval") || scopeKey.includes(".versions")) return false;
      if (route && route.startsWith("/reports")) return false;
      if (scopeKey.includes("report")) return false;
      if (!route) return false;
      // Only data-entry screens (create/edit/delete flows) live under master-data in this app.
      if (!route.startsWith("/master-data")) return false;
      return true;
    };

    const policyMap = policyRows.reduce((acc, row) => {
      if (!acc[row.entity_type]) acc[row.entity_type] = {};
      if (!acc[row.entity_type][row.entity_key]) acc[row.entity_type][row.entity_key] = {};
      acc[row.entity_type][row.entity_key][row.action] = row.requires_approval;
      return acc;
    }, {});

    const voucherTypeMap = new Map(voucherTypes.map((vt) => [vt.code, vt.name]));

    const buildScreenRows = (nodes, parentPath = "", depth = 0) => {
      let rows = [];
      nodes.forEach((node) => {
        const path = parentPath ? `${parentPath}.${node.key}` : node.key;
        const hasChildren = Array.isArray(node.children) && node.children.length > 0;
        const childRows = hasChildren ? buildScreenRows(node.children, path, depth + 1) : [];
        const isScreen = node.scopeType === "SCREEN" && node.route && shouldIncludeScreen(node.scopeKey, node.route);
        const isVoucher = node.scopeType === "VOUCHER";
        const includeGroup = childRows.length > 0;

        if (isScreen || isVoucher || includeGroup) {
          rows.push({
            key: node.key,
            path,
            parentPath: parentPath || null,
            depth,
            hasChildren: childRows.length > 0,
            scopeKey: isScreen || isVoucher ? node.scopeKey : null,
            scopeType: isVoucher ? "VOUCHER" : "SCREEN",
            labelKey: node.labelKey,
            description: node.labelKey,
            voucherName: isVoucher ? voucherTypeMap.get(node.scopeKey) || null : null,
          });
          rows = rows.concat(childRows);
        }
      });
      return rows;
    };

    let screenRows = buildScreenRows(navConfig);

    renderPage(req, res, "../../administration/approvals/settings", res.locals.t("approval_settings"), {
      screenRows,
      policyMap,
    });
  } catch (err) {
    next(err);
  }
});

// POST /settings - Save approval policy settings
router.post("/settings", requirePermission("SCREEN", "administration.approval_settings", "edit"), async (req, res, next) => {
  const trx = await knex.transaction();
  try {
    const { ...fields } = req.body;

    await trx("erp.approval_policy").whereIn("entity_type", ["VOUCHER_TYPE", "SCREEN"]).del();

    const insertRows = [];
    Object.keys(fields).forEach((key) => {
      if (!key.includes(":")) return;
      const [entityType, entityKey, action] = key.split(":");
      if (!entityType || !entityKey || !action) return;
      insertRows.push({
        entity_type: entityType,
        entity_key: entityKey,
        action,
        requires_approval: true,
        updated_by: req.user?.id || null,
      });
    });

    if (insertRows.length) {
      await trx("erp.approval_policy").insert(insertRows);
    }

    await trx.commit();
    res.redirect(`${req.baseUrl}/settings?success=1`);
  } catch (err) {
    await trx.rollback();
    next(err);
  }
});

// POST /:id/approve
router.post("/:id/approve", requirePermission("SCREEN", "administration.approvals", "approve"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new HttpError(400, res.locals.t("error_invalid_id")));

  try {
    let applyError = null;
    let requestSnapshot = null;
    await knex.transaction(async (trx) => {
      const request = await trx("erp.approval_request").where({ id }).first();
      if (!request || request.status !== "PENDING") {
        throw new Error(res.locals.t("approval_request_not_found"));
      }
      requestSnapshot = request;

      // EXECUTE CHANGE
      if (request.request_type === "MASTER_DATA_CHANGE") {
        try {
          const applied = await applyMasterDataChange(trx, request, req.user.id);
          console.log("[DEBUG][Approval] applyMasterDataChange result:", applied);
          if (!applied) {
            throw new Error(res.locals.t("approval_apply_failed"));
          }
        } catch (err) {
          // Custom error for duplicate name
          if (err && err.code === "DUPLICATE_NAME") {
            applyError = { message: res.locals.t("error_duplicate_name") };
          } else {
            applyError = err;
          }
          console.error("[ERROR][Approval] Error in applyMasterDataChange:", err);
        }
      }
      await trx("erp.approval_request");
      if (!applyError) {
        await trx("erp.approval_request").where({ id }).update({
          status: "APPROVED",
          decided_by: req.user.id,
          decided_at: trx.fn.now(),
          decision_notes: null,
        });
      }

      if (!applyError) {
        await insertActivityLog(trx, {
          branch_id: request.branch_id,
          user_id: req.user.id,
          entity_type: request.entity_type,
          entity_id: request.entity_id,
          voucher_type_code: request.voucher_type_code || null,
          action: "APPROVE",
          ip_address: req.ip,
        });
      }
    });

    if (applyError) {
      // Always show the most specific error, prefer duplicate name, and log it
      let msg;
      if (applyError && applyError.code === "DUPLICATE_NAME") {
        msg = res.locals.t("error_duplicate_name");
      } else if (applyError && applyError.message) {
        msg = applyError.message;
      } else {
        msg = res.locals.t("approval_apply_failed");
      }
      console.log("[DEBUG][Approval] UI Notice message:", msg);
      setUiNotice(res, msg, { autoClose: true });
      return res.redirect(`${req.baseUrl}?status=PENDING`);
    }
    if (requestSnapshot?.requested_by) {
      notifyApprovalDecision({
        userId: requestSnapshot.requested_by,
        payload: {
          status: "APPROVED",
          requestId: requestSnapshot.id,
          summary: requestSnapshot.summary || "",
          link: "/administration/approvals?status=APPROVED",
          message: (res.locals.t("approval_approved_detail") || "Your approval request was approved: {summary}").replace("{summary}", requestSnapshot.summary || ""),
          sticky: true,
        },
      });
    }
    setUiNotice(res, res.locals.t("approval_approved"), { autoClose: true });
    return res.redirect(`${req.baseUrl}?status=PENDING`);
  } catch (err) {
    next(err);
  }
});

// POST /:id/reject
router.post("/:id/reject", requirePermission("SCREEN", "administration.approvals", "approve"), async (req, res, next) => {
  const id = Number(req.params.id);

  try {
    let requestSnapshot = null;
    await knex.transaction(async (trx) => {
      const request = await trx("erp.approval_request").where({ id }).first();
      if (!request || request.status !== "PENDING") {
        throw new Error(res.locals.t("approval_request_not_found"));
      }
      requestSnapshot = request;

      await trx("erp.approval_request").where({ id }).update({
        status: "REJECTED",
        decided_by: req.user.id,
        decided_at: trx.fn.now(),
      });

      await insertActivityLog(trx, {
        branch_id: request.branch_id,
        user_id: req.user.id,
        entity_type: request.entity_type,
        entity_id: request.entity_id,
        voucher_type_code: request.voucher_type_code || null,
        action: "REJECT",
        ip_address: req.ip,
      });
    });
    if (requestSnapshot?.requested_by) {
      notifyApprovalDecision({
        userId: requestSnapshot.requested_by,
        payload: {
          status: "REJECTED",
          requestId: requestSnapshot.id,
          summary: requestSnapshot.summary || "",
          link: "/administration/approvals?status=REJECTED",
          message: (res.locals.t("approval_rejected_detail") || "Your approval request was rejected: {summary}").replace("{summary}", requestSnapshot.summary || ""),
          sticky: true,
        },
      });
    }
    setUiNotice(res, res.locals.t("approval_rejected"), { autoClose: true });
    res.redirect(`${req.baseUrl}?status=PENDING`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
