// approval-events.js
// Purpose: Manages server-sent events (SSE) for real-time approval notifications to users.
// Handles registration of event streams, queuing of pending events, and delivery of approval decisions.
// Used by the backend to push approval status changes to the frontend in real time.
//
// Key functions:
// - registerApprovalStream: Registers a user's SSE connection and sends queued events.
// - notifyApprovalDecision: Queues or sends approval decision events to the correct user.
// - sendEvent: Helper to format and send SSE events.

const connections = new Map();
const pendingEvents = new Map();

const sendEvent = (res, event, data) => {
  if (!res || res.writableEnded) return;
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
};

const registerApprovalStream = (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const userId = req.user?.id;
  if (!userId) {
    res.end();
    return;
  }

  const set = connections.get(userId) || new Set();
  set.add(res);
  connections.set(userId, set);

  const queued = pendingEvents.get(userId);
  if (queued && queued.length) {
    queued.forEach((payload) => sendEvent(res, "approval_decision", payload));
    pendingEvents.delete(userId);
  }

  sendEvent(res, "ready", { ok: true });

  const keepAlive = setInterval(() => {
    if (res.writableEnded) return;
    res.write(": ping\n\n");
  }, 25000);

  req.on("close", () => {
    clearInterval(keepAlive);
    const current = connections.get(userId);
    if (current) {
      current.delete(res);
      if (current.size === 0) {
        connections.delete(userId);
      }
    }
  });
};

const notifyApprovalDecision = ({ userId, payload }) => {
  if (!userId) return;
  const set = connections.get(userId);
  if (!set || set.size === 0) {
    const queue = pendingEvents.get(userId) || [];
    queue.push(payload);
    pendingEvents.set(userId, queue.slice(-10));
    return;
  }
  set.forEach((res) => sendEvent(res, "approval_decision", payload));
  pendingEvents.delete(userId);
};

module.exports = {
  registerApprovalStream,
  notifyApprovalDecision,
  ackApprovalDecisions: (userId) => {
    if (!userId) return;
    pendingEvents.delete(userId);
  },
};
