const express = require("express");
const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");

const router = express.Router();

const requireAdmin = (req, res, next) => {
  if (!req.user || !req.user.isAdmin) {
    return next(new HttpError(403, "Admin access required"));
  }
  next();
};

router.get("/", requireAdmin, async (req, res, next) => {
  const status = (req.query.status || "PENDING").toUpperCase();

  try {
    const query = knex("erp.approval_request")
      .select(
        "id",
        "branch_id",
        "request_type",
        "entity_type",
        "entity_id",
        "summary",
        "status",
        "requested_by",
        "requested_at",
        "decided_by",
        "decided_at"
      )
      .where("status", status)
      .orderBy("requested_at", "desc");

    if (req.applyBranchScope) {
      req.applyBranchScope(query, "branch_id");
    }

    const rows = await query;
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/approve", requireAdmin, async (req, res, next) => {
  const approvalId = Number(req.params.id);
  if (!approvalId) {
    return next(new HttpError(400, "Invalid approval request id"));
  }

  try {
    const approval = await knex("erp.approval_request")
      .select("id", "requested_by", "status")
      .where({ id: approvalId })
      .first();

    if (!approval) {
      return next(new HttpError(404, "Approval request not found"));
    }

    if (approval.status !== "PENDING") {
      return next(new HttpError(400, "Approval request already decided"));
    }

    if (approval.requested_by === req.user.id) {
      return next(new HttpError(403, "Creator cannot approve own request"));
    }

    await knex("erp.approval_request")
      .where({ id: approvalId })
      .update({
        status: "APPROVED",
        decided_by: req.user.id,
        decided_at: knex.fn.now(),
        decision_notes: req.body?.decision_notes || null,
      });

    res.json({ status: "APPROVED", id: approvalId });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/reject", requireAdmin, async (req, res, next) => {
  const approvalId = Number(req.params.id);
  if (!approvalId) {
    return next(new HttpError(400, "Invalid approval request id"));
  }

  try {
    const approval = await knex("erp.approval_request")
      .select("id", "requested_by", "status")
      .where({ id: approvalId })
      .first();

    if (!approval) {
      return next(new HttpError(404, "Approval request not found"));
    }

    if (approval.status !== "PENDING") {
      return next(new HttpError(400, "Approval request already decided"));
    }

    if (approval.requested_by === req.user.id) {
      return next(new HttpError(403, "Creator cannot reject own request"));
    }

    await knex("erp.approval_request")
      .where({ id: approvalId })
      .update({
        status: "REJECTED",
        decided_by: req.user.id,
        decided_at: knex.fn.now(),
        decision_notes: req.body?.decision_notes || null,
      });

    res.json({ status: "REJECTED", id: approvalId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
