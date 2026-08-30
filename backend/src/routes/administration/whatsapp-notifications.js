const express = require("express");
const knex = require("../../db/knex");
const {
  requirePermission,
} = require("../../middleware/access/role-permissions");
const {
  getWhatsAppStatus,
  listPendingMessages,
  cancelPendingMessage,
  clearPendingMessages,
} = require("../../utils/whatsapp");

const router = express.Router();

const SCOPE = ["SCREEN", "administration.whatsapp_notifications"];

// Cancelling stops the retry worker from ever picking the row up again: the
// sweep selects on status='QUEUED', so flipping the status is what actually
// takes it out. message_body is cleared too, so nothing can re-send it later.
const CANCEL_PATCH = (knex) => ({
  status: "FAILED",
  failure_reason: "cancelled",
  next_retry_at: null,
  message_body: null,
  resolved_at: knex.fn.now(),
});

// GET / — list WhatsApp payment-notification failures (default: unresolved only).
router.get(
  "/",
  requirePermission(...SCOPE, "view"),
  async (req, res, next) => {
    try {
      const requestedStatus = String(req.query.status || "FAILED").toUpperCase();
      const status = ["ALL", "QUEUED", "FAILED"].includes(requestedStatus)
        ? requestedStatus
        : "FAILED";
      const includeResolved = String(req.query.resolved || "") === "1";
      const page = Math.max(1, Number(req.query.page) || 1);
      const pageSize = Math.min(500, Math.max(25, Number(req.query.page_size) || 100));
      const offset = (page - 1) * pageSize;

      const baseQuery = knex("erp.whatsapp_notification_log as wl")
        .leftJoin("erp.branches as b", "b.id", "wl.branch_id")
        .modify((qb) => {
          if (status === "FAILED") {
            qb.where("wl.status", "FAILED");
            if (!includeResolved) qb.whereNull("wl.resolved_at");
          } else if (status === "QUEUED") {
            qb.where("wl.status", "QUEUED");
          }
          // "ALL" leaves every status visible (SENT / FAILED / QUEUED).
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
            "wl.attempts",
            "wl.next_retry_at",
            "b.name as branch_name",
          )
          .orderBy("wl.created_at", "desc")
          .limit(pageSize)
          .offset(offset),
        baseQuery.clone().count("* as total").first(),
      ]);

      const total = Number(totalRow?.total || 0);
      const totalPages = Math.max(1, Math.ceil(total / pageSize));

      // How many rows the retry worker still owns, regardless of the current
      // filter — so the "cancel all" control can state what it will affect even
      // while you are looking at the FAILED tab.
      const queuedRow = await knex("erp.whatsapp_notification_log")
        .where({ status: "QUEUED" })
        .modify((qb) => {
          if (req.applyBranchScope) req.applyBranchScope(qb, "branch_id");
        })
        .count("* as total")
        .first();

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
        // Connection state up front: a queue that is filling up because the
        // session is unlinked looks identical to one failing per-recipient, and
        // the page previously showed neither.
        waStatus: getWhatsAppStatus(),
        queuedCount: Number(queuedRow?.total || 0),
        // The OTHER queue. Rate-change and new-article broadcasts never get a
        // row in whatsapp_notification_log — they buffer in memory inside
        // whatsapp.js — so cancelling queued rows above left them untouched and
        // invisible, still primed to fire at the group on the next reconnect.
        // Not branch-scoped: there is one group chat, not one per branch.
        pendingMessages: listPendingMessages(),
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

// POST /:id/cancel — stop retrying one queued notification.
router.post(
  "/:id/cancel",
  requirePermission(...SCOPE, "view"),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (Number.isInteger(id) && id > 0) {
        const query = knex("erp.whatsapp_notification_log")
          .where({ id, status: "QUEUED" });
        if (req.applyBranchScope) req.applyBranchScope(query, "branch_id");
        await query.update(CANCEL_PATCH(knex));
      }
      return res.redirect(`${req.baseUrl}?status=QUEUED`);
    } catch (err) {
      next(err);
    }
  },
);

// POST /cancel-queued — stop retrying everything still queued.
//
// The escape hatch for a bad batch. Without it the only way to stop the worker
// was UPDATE-ing the table by hand, which meant a WhatsApp outage could not be
// contained by whoever was actually watching the screen. It also matters right
// before re-linking a dropped session: onWhatsAppReady drains the whole backlog
// at once, so a day-old queue would fire stale payment confirmations at real
// payees the moment the QR is scanned.
router.post(
  "/cancel-queued",
  requirePermission(...SCOPE, "view"),
  async (req, res, next) => {
    try {
      const query = knex("erp.whatsapp_notification_log").where({ status: "QUEUED" });
      if (req.applyBranchScope) req.applyBranchScope(query, "branch_id");
      const cancelled = await query.update(CANCEL_PATCH(knex));
      console.log(
        `[WhatsApp] ${cancelled} queued notification(s) cancelled by user ${req.user?.id ?? "?"}`,
      );
      return res.redirect(`${req.baseUrl}?status=QUEUED`);
    } catch (err) {
      next(err);
    }
  },
);

// POST /pending/:id/cancel — drop one buffered group broadcast.
//
// Separate from /:id/cancel because these are not database rows: they live in
// the in-memory outbox and are addressed by a per-process sequence number, not
// by a whatsapp_notification_log id. The two id spaces overlap, so the paths
// must not.
router.post(
  "/pending/:id/cancel",
  requirePermission(...SCOPE, "view"),
  async (req, res, next) => {
    try {
      const removed = cancelPendingMessage(req.params.id);
      console.log(
        `[WhatsApp] pending message ${req.params.id} cancelled by user ` +
          `${req.user?.id ?? "?"} — ${removed ? "removed" : "not in queue"}`,
      );
      return res.redirect(req.baseUrl);
    } catch (err) {
      next(err);
    }
  },
);

// POST /pending/cancel-all — empty the in-memory outbox.
//
// The counterpart to cancel-queued, and the missing half of "stop everything
// before re-linking": reconnecting flushes this buffer at the sales group before
// the durable retry sweep even starts, so clearing only the database left the
// stale rate broadcasts to go out anyway.
router.post(
  "/pending/cancel-all",
  requirePermission(...SCOPE, "view"),
  async (req, res, next) => {
    try {
      const cleared = clearPendingMessages();
      console.log(
        `[WhatsApp] ${cleared} pending group message(s) cancelled by user ${req.user?.id ?? "?"}`,
      );
      return res.redirect(req.baseUrl);
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
