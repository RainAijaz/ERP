// in-app-notifications.js
// Purpose: Persisted in-ERP notifications (the bell + unread count) and their
// live delivery. The durable layer is erp.notification; live delivery reuses
// the approval SSE stream (utils/approval-events.js) via a generic `notification`
// event. On page load / reconnect the client rehydrates from GET /notifications,
// so the SSE push is best-effort and the DB is the source of truth.

const { getActiveApprovalUserIds } = require("./approval-notifications");
const { notifyUser } = require("./approval-events");

const NOTIFICATION_TYPE_APPROVAL_PENDING = "APPROVAL_PENDING";

// How many recent items the bell dropdown shows.
const RECENT_LIMIT = 20;

const getUnreadCount = async (knex, userId) => {
  if (!userId) return 0;
  const row = await knex("erp.notification")
    .where({ user_id: userId, is_read: false })
    .count({ count: "*" })
    .first();
  return Number(row?.count || 0);
};

const listNotifications = async (knex, userId, { limit = RECENT_LIMIT } = {}) => {
  if (!userId) return { unreadCount: 0, items: [] };
  const [items, unreadCount] = await Promise.all([
    knex("erp.notification")
      .where({ user_id: userId })
      .orderBy("created_at", "desc")
      .limit(limit)
      .select(
        "id",
        "type",
        "approval_request_id",
        "title",
        "body",
        "link",
        "is_read",
        "created_at",
      ),
    getUnreadCount(knex, userId),
  ]);
  return { unreadCount, items };
};

const markNotificationRead = async (knex, userId, notificationId) => {
  if (!userId || !notificationId) return 0;
  return knex("erp.notification")
    .where({ id: notificationId, user_id: userId, is_read: false })
    .update({ is_read: true, read_at: knex.fn.now() });
};

const markAllNotificationsRead = async (knex, userId) => {
  if (!userId) return 0;
  return knex("erp.notification")
    .where({ user_id: userId, is_read: false })
    .update({ is_read: true, read_at: knex.fn.now() });
};

// Fan-out an "approval pending" notification to every eligible approver.
// Row-driven: entity/summary/requester/branch/status are read from the
// erp.approval_request row, so callers only supply { knex, approvalRequestId }.
// Self-guards on status='PENDING' (so an approve/reject audit that re-triggers
// this never produces a bogus "new request" notification) and is idempotent
// per approval_request_id. MUST be called after the request row is committed.
const notifyPendingApproval = async ({ knex, approvalRequestId }) => {
  if (!approvalRequestId) return;

  // Idempotency guard: skip if this request already produced notifications.
  const existing = await knex("erp.notification")
    .where({ approval_request_id: approvalRequestId })
    .first("id");
  if (existing) return;

  const request = await knex("erp.approval_request")
    .where({ id: approvalRequestId })
    .first(
      "id",
      "entity_type",
      "entity_id",
      "summary",
      "status",
      "requested_by",
      "branch_id",
    );
  // Only notify for still-pending requests (skip decisions / missing rows).
  if (!request || String(request.status) !== "PENDING") return;

  const recipientIds = await getActiveApprovalUserIds(knex);
  const requesterId = Number(request.requested_by);
  const targets = recipientIds.filter((id) => id !== requesterId);
  if (!targets.length) return;

  // Relative path keeps same-origin navigation robust regardless of base-URL
  // config; the client is always on the same origin as the ERP.
  const link = `/administration/approvals?request_id=${encodeURIComponent(
    String(approvalRequestId),
  )}`;

  const title = "New approval request";
  const body =
    (request.summary && String(request.summary).trim()) ||
    `${request.entity_type || "Request"}${
      request.entity_id ? ` #${request.entity_id}` : ""
    }`;

  const rows = targets.map((userId) => ({
    user_id: userId,
    type: NOTIFICATION_TYPE_APPROVAL_PENDING,
    approval_request_id: approvalRequestId,
    branch_id: request.branch_id || null,
    title,
    body,
    link,
  }));

  // onConflict makes fan-out race-safe: if a concurrent sweep already inserted
  // a row for this (approval_request_id, user_id), it's skipped and NOT
  // returned, so we never double-insert or double-push. Requires the unique
  // index uq_notification_request_user.
  const inserted = await knex("erp.notification")
    .insert(rows)
    .onConflict(["approval_request_id", "user_id"])
    .ignore()
    .returning(["id", "user_id"]);

  // Live-push to any recipient currently connected. Each recipient gets their
  // own notification id and fresh unread count.
  await Promise.all(
    inserted.map(async (rowRef) => {
      const unreadCount = await getUnreadCount(knex, rowRef.user_id);
      notifyUser({
        userId: rowRef.user_id,
        event: "notification",
        payload: {
          id: rowRef.id,
          type: NOTIFICATION_TYPE_APPROVAL_PENDING,
          title,
          body,
          link,
          unreadCount,
        },
      });
    }),
  );
};

// Fire-and-forget wrapper used post-commit (e.g. from the res.finish audit
// hook). Never throws into the caller. notifyPendingApproval self-guards on
// status='PENDING' and idempotency, so it is safe to call for any audited
// event that carries an approval_request_id.
const notifyPendingApprovalPostCommit = (args) => {
  Promise.resolve()
    .then(() => notifyPendingApproval(args))
    .catch((err) => {
      console.error("[in-app-notifications] post-commit notify failed", {
        approvalRequestId: args?.approvalRequestId,
        error: err?.message || err,
      });
    });
};

// Safety-net sweep: generate notifications for recent still-PENDING approval
// requests that don't have any yet. Covers creation paths not wired to an
// instant trigger (e.g. the SKU screen's direct approval_request inserts) and
// any future path. Scoped to a short recency window so a first deploy doesn't
// spam approvers with the entire historical pending backlog. Cheap in steady
// state (NOT EXISTS returns nothing once notifications are generated).
const BACKFILL_WINDOW = "2 days";
const BACKFILL_LIMIT = 50;
const backfillPendingApprovalNotifications = async (knex) => {
  const rows = await knex("erp.approval_request as ar")
    .where("ar.status", "PENDING")
    .andWhereRaw(`ar.requested_at > now() - interval '${BACKFILL_WINDOW}'`)
    .whereNotExists(function existsNotification() {
      this.select(1)
        .from("erp.notification as n")
        .whereRaw("n.approval_request_id = ar.id");
    })
    .orderBy("ar.id", "desc")
    .limit(BACKFILL_LIMIT)
    .select("ar.id");
  for (const row of rows) {
    // Sequential + awaited so the idempotency guard sees prior inserts.
    // eslint-disable-next-line no-await-in-loop
    await notifyPendingApproval({ knex, approvalRequestId: row.id });
  }
};

module.exports = {
  NOTIFICATION_TYPE_APPROVAL_PENDING,
  notifyPendingApprovalPostCommit,
  backfillPendingApprovalNotifications,
  getUnreadCount,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  notifyPendingApproval,
};
