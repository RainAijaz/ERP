const express = require("express");
const knex = require("../../db/knex");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");

const router = express.Router();

const SCOPE = ["SCREEN", "administration.whatsapp_notifications"];

// GET / — list WhatsApp payment-notification failures (default: unresolved only).
router.get(
  "/",
  requirePermission(...SCOPE, "view"),
  async (req, res, next) => {
    try {
      const status =
        String(req.query.status || "FAILED").toUpperCase() === "ALL"
          ? "ALL"
          : "FAILED";
      const includeResolved = String(req.query.resolved || "") === "1";
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(500, Math.max(25, Number(req.query.page_size) || 100));
      const offset = (page - 1) * pageSize;

      const baseQuery = knex("erp.whatsapp_notification_log as wl")
        .leftJoin("erp.branches as b", "b.id", "wl.branch_id")
        .modify((qb) => {
          if (status === "FAILED") qb.where("wl.status", "FAILED");
          if (status === "FAILED" && !includeResolved) qb.whereNull("wl.resolved_at");
        });

      if (req.applyBranchScope) {
        req.applyBranchScope(baseQuery, "wl.branch_id");
      }

      const [rows, totalRow] = await Promise.all([
        baseQuery
          .clone()
          .select(
            "wl.id",
            "wl.created_at",
            "wl.voucher_type_code",
            "wl.voucher_no",
            "wl.recipient_kind",
            "wl.recipient_name",
            "wl.phone_raw",
            "wl.phone_normalized",
            "wl.amount",
            "wl.status",
            "wl.failure_reason",
            "wl.resolved_at",
            "b.name as branch_name",
          )
          .orderBy("wl.created_at", "desc")
          .limit(pageSize)
          .offset(offset),
        baseQuery.clone().count("* as total").first(),
      ]);

      const total = Number(totalRow?.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));

      const buildPageUrl = (targetPage) => {
        const params = new URLSearchParams();
        Object.entries(req.query || {}).forEach(([key, value]) => {
          if (key === "page" || value == null || value === "") return;
          params.append(key, String(value));
        });
        params.set("page", String(targetPage));
        params.set("page_size", String(pageSize));
        return `?${params.toString()}`;
      };

      return res.render("base/layouts/main", {
        title: res.locals.t("whatsapp_notification_failures"),
        user: req.user,
        branchId: req.branchId,
        branchScope: req.branchScope,
        csrfToken: res.locals.csrfToken,
        view: "../../administration/whatsapp-notifications/index",
        t: res.locals.t,
        rows,
        filters: { status, resolved: includeResolved ? "1" : "" },
        pagination: {
          page,
          pageSize,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
          nextUrl: page < totalPages ? buildPageUrl(page + 1) : null,
          prevUrl: page > 1 ? buildPageUrl(page - 1) : null,
        },
        basePath: req.baseUrl,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /:id/resolve — mark a failure as handled so it clears from the alert count.
router.post(
  "/:id/resolve",
  requirePermission(...SCOPE, "view"),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (Number.isInteger(id) && id > 0) {
        await knex("erp.whatsapp_notification_log")
          .where({ id })
          .whereNull("resolved_at")
          .update({ resolved_at: knex.fn.now() });
      }
      return res.redirect(req.baseUrl);
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
