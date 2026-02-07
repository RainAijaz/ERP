const knex = require("../../db/knex");
const { HttpError } = require("../errors/http-error");
const { sendMail } = require("../../utils/email");
const { setCookie } = require("../utils/cookies");
const { UI_NOTICE_COOKIE } = require("../core/ui-notice");

const notifyAdmins = async ({ subject, html, text }) => {
  const adminRows = await knex("erp.users")
    .join("erp.role_templates", "erp.role_templates.id", "erp.users.primary_role_id")
    .select("erp.users.email")
    .whereRaw("lower(trim(erp.role_templates.name)) = 'admin'")
    .andWhereRaw("lower(trim(erp.users.status)) = 'active'")
    .whereNotNull("erp.users.email");

  const emails = adminRows.map((row) => row.email).filter(Boolean);
  if (!emails.length) return;

  await sendMail({
    to: emails,
    subject,
    html,
    text,
  });
};

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

    await notifyAdmins({
      subject: `ERP approval pending: ${entityType}`,
      text: `Approval request pending for ${entityType} ${entityId}.`,
      html: `<p>Approval request pending for <strong>${entityType}</strong> ${entityId}.</p>`,
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

