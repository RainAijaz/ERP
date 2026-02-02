const express = require("express");
const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { applyMasterDataChange } = require("../../utils/approval-applier");
const { navConfig, getNavScopes } = require("../../utils/nav-config");

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

// GET / - Dashboard
router.get("/", requirePermission("SCREEN", "administration.approvals", "navigate"), async (req, res, next) => {
  try {
    const status = (req.query.status || "PENDING").toUpperCase();

    const rows = await knex("erp.approval_request as ar")
      .select("ar.*", "u.username as requester_name", "v.id as variant_id")
      .leftJoin("erp.users as u", "ar.requested_by", "u.id")
      // Left join variant to get SKU context if entity_type is SKU
      .leftJoin("erp.variants as v", function () {
        this.on("ar.entity_id", "=", knex.raw("CAST(v.id AS TEXT)")).andOn("ar.entity_type", "=", knex.raw("'SKU'"));
      })
      .where("ar.status", status)
      .orderBy("ar.requested_at", "desc");

    const noticeKey = req.query.notice;
    const notice = noticeKey ? res.locals.t(noticeKey) : null;
    renderPage(req, res, "../../administration/approvals/index", res.locals.t("approvals"), {
      rows,
      currentStatus: status,
      notice,
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
      return true;
    };

    const policyMap = policyRows.reduce((acc, row) => {
      if (!acc[row.entity_type]) acc[row.entity_type] = {};
      if (!acc[row.entity_type][row.entity_key]) acc[row.entity_type][row.entity_key] = {};
      acc[row.entity_type][row.entity_key][row.action] = row.requires_approval;
      return acc;
    }, {});

    const voucherTypeMap = new Map(voucherTypes.map((vt) => [vt.code, vt.name]));
    const navScopes = getNavScopes();

    const voucherRows = navScopes
      .filter((scope) => scope.scopeType === "VOUCHER")
      .map((scope) => ({
        code: scope.scopeKey,
        labelKey: scope.description,
        name: voucherTypeMap.get(scope.scopeKey) || null,
      }));

    const navVoucherCodes = new Set(voucherRows.map((row) => row.code));
    voucherTypes.forEach((vt) => {
      if (navVoucherCodes.has(vt.code)) return;
      voucherRows.push({
        code: vt.code,
        labelKey: null,
        name: vt.name,
      });
    });

    const buildScreenRows = (nodes, parentPath = "", depth = 0) => {
      let rows = [];
      nodes.forEach((node) => {
        const path = parentPath ? `${parentPath}.${node.key}` : node.key;
        const hasChildren = Array.isArray(node.children) && node.children.length > 0;
        const childRows = hasChildren ? buildScreenRows(node.children, path, depth + 1) : [];
        const isScreen = node.scopeType === "SCREEN" && node.route && shouldIncludeScreen(node.scopeKey, node.route);
        const includeGroup = childRows.length > 0;

        if (isScreen || includeGroup) {
          rows.push({
            key: node.key,
            path,
            parentPath: parentPath || null,
            depth,
            hasChildren: childRows.length > 0,
            scopeKey: isScreen ? node.scopeKey : null,
            labelKey: node.labelKey,
            description: node.labelKey,
          });
          rows = rows.concat(childRows);
        }
      });
      return rows;
    };

    let screenRows = buildScreenRows(navConfig);

    renderPage(req, res, "../../administration/approvals/settings", res.locals.t("approval_settings"), {
      voucherRows,
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
    await knex.transaction(async (trx) => {
      const request = await trx("erp.approval_request").where({ id }).first();
      if (!request || request.status !== "PENDING") {
        throw new Error(res.locals.t("approval_request_not_found"));
      }

      // EXECUTE CHANGE
      if (request.request_type === "MASTER_DATA_CHANGE") {
        const applied = await applyMasterDataChange(trx, request, req.user.id);
        if (!applied) {
          throw new Error(res.locals.t("approval_apply_failed"));
        }
      }

      if (request.request_type === "VOUCHER" && request.entity_type === "VOUCHER") {
        await trx("erp.voucher_header")
          .where({ id: Number(request.entity_id) })
          .update({
            status: "APPROVED",
            approved_by: req.user.id,
            approved_at: trx.fn.now(),
          });
      }

      // UPDATE STATUS
      await trx("erp.approval_request").where({ id }).update({
        status: "APPROVED",
        decided_by: req.user.id,
        decided_at: trx.fn.now(),
      });
    });

    res.redirect(`${req.baseUrl}?status=PENDING&notice=approval_approved`);
  } catch (err) {
    next(err);
  }
});

// POST /:id/reject
router.post("/:id/reject", requirePermission("SCREEN", "administration.approvals", "approve"), async (req, res, next) => {
  const id = Number(req.params.id);

  try {
    await knex("erp.approval_request").where({ id }).update({
      status: "REJECTED",
      decided_by: req.user.id,
      decided_at: knex.fn.now(),
    });
    res.redirect(`${req.baseUrl}?status=PENDING&notice=approval_rejected`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
