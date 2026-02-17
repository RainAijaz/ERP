const knex = require("../../db/knex");
const { HttpError } = require("../errors/http-error");
const { setCookie } = require("../utils/cookies");
const { UI_NOTICE_COOKIE } = require("../core/ui-notice");
const { insertActivityLog } = require("../../utils/audit-log");
const { notifyPendingApprovalAdmins } = require("../../utils/approval-notifications");

// Routes actions through pending approval where configured.
module.exports = async (req, res, next) => {
  if (!req.user) return next();

  const request = req.approvalRequest;
  if (!request) return next();

  const {
    branchId = req.branchId,
    requestType,
    entityType,
    entityId,
    summary,
    oldValue,
    newValue,
  } = request;

  if (!branchId || !requestType || !entityType || !entityId) {
    return next(new HttpError(400, "Approval request is missing required fields"));
  }

  try {
    const [created] = await knex("erp.approval_request")
      .insert({
        branch_id: branchId,
        request_type: requestType,
        entity_type: entityType,
        entity_id: String(entityId),
        summary: summary || null,
        old_value: oldValue || null,
        new_value: newValue || null,
        requested_by: req.user.id,
      })
      .returning(["id"]);

    req.approvalRequestId = created?.id || null;

    await insertActivityLog(knex, {
      branch_id: branchId,
      user_id: req.user.id,
      entity_type: entityType,
      entity_id: String(entityId),
      action: "SUBMIT",
      ip_address: req.ip,
      context: {
        approval_request_id: req.approvalRequestId,
        request_type: requestType,
        summary: summary || null,
        old_value: oldValue || null,
        new_value: newValue || null,
        source: "approval-required",
      },
    });

    notifyPendingApprovalAdmins({
      knex,
      approvalRequestId: req.approvalRequestId,
      requestType,
      entityType,
      entityId: String(entityId),
      summary,
      oldValue,
      newValue,
      requestedByName: req.user?.username || null,
      branchId,
      t: res.locals.t,
    }).catch((err) => {
      console.error("[approval-required] admin email notify failed", {
        approvalRequestId: req.approvalRequestId,
        entityType,
        error: err?.message || err,
      });
    });

    if (res?.locals?.t) {
      if (process.env.DEBUG_UI_NOTICE === "1") {
        console.log("[UI NOTICE] set from approval-required", {
          path: req.path,
          entityType,
          entityId,
        });
      }
      setCookie(
        res,
        UI_NOTICE_COOKIE,
        JSON.stringify({
          message: res.locals.t("approval_sent") || res.locals.t("approval_submitted"),
          autoClose: true,
        }),
        { path: "/", maxAge: 30, sameSite: "Lax" },
      );
    }

    if (request.block === true) {
      return res.status(202).json({
        status: "PENDING",
        approval_request_id: req.approvalRequestId,
      });
    }

    next();
  } catch (err) {
    next(err);
  }
};

