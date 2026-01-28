const express = require("express");
const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");

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
router.get("/", async (req, res, next) => {
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

    renderPage(req, res, "../../administration/approvals/index", res.locals.t("approvals"), {
      rows,
      currentStatus: status,
    });
  } catch (err) {
    next(err);
  }
});

// POST /:id/approve
router.post("/:id/approve", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new HttpError(400, "Invalid ID"));

  try {
    await knex.transaction(async (trx) => {
      const request = await trx("erp.approval_request").where({ id }).first();
      if (!request || request.status !== "PENDING") {
        throw new Error("Request not found or not pending");
      }

      // EXECUTE CHANGE
      if (request.request_type === "MASTER_DATA_CHANGE" && request.entity_type === "SKU") {
        const newValue = request.new_value; // JSONB
        if (newValue && newValue.sale_rate) {
          await trx("erp.variants")
            .where({ id: Number(request.entity_id) })
            .update({
              sale_rate: newValue.sale_rate,
              updated_at: trx.fn.now(),
            });
        }
      }

      // UPDATE STATUS
      await trx("erp.approval_request").where({ id }).update({
        status: "APPROVED",
        decided_by: req.user.id,
        decided_at: trx.fn.now(),
      });
    });

    res.redirect(`${req.baseUrl}?status=PENDING&success=approved`);
  } catch (err) {
    next(err);
  }
});

// POST /:id/reject
router.post("/:id/reject", async (req, res, next) => {
  const id = Number(req.params.id);

  try {
    await knex("erp.approval_request").where({ id }).update({
      status: "REJECTED",
      decided_by: req.user.id,
      decided_at: knex.fn.now(),
    });
    res.redirect(`${req.baseUrl}?status=PENDING&success=rejected`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
