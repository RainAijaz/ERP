const knex = require("../../db/knex");
const { HttpError } = require("../errors/http-error");

// Prevents a user from approving or finalizing their own changes.
module.exports = async (req, res, next) => {
  if (!req.user) return next();

  const requestId = req.body?.approval_request_id || req.body?.request_id;
  if (!requestId) return next();

  try {
    const approval = await knex("erp.approval_request")
      .select("id", "requested_by", "status")
      .where({ id: requestId })
      .first();

    if (!approval) {
      return next(new HttpError(404, "Approval request not found"));
    }

    if (approval.requested_by === req.user.id) {
      return next(new HttpError(403, "Creator cannot approve own request"));
    }

    if (approval.status !== "PENDING") {
      return next(new HttpError(400, "Approval request already decided"));
    }

    next();
  } catch (err) {
    next(err);
  }
};

