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
  // Flush past the compression middleware so small SSE events reach the client
  // immediately instead of sitting in the gzip buffer.
  res.flush?.();
};

const registerApprovalStream = (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  // no-transform tells the compression middleware to pass the stream through
  // uncompressed; X-Accel-Buffering disables proxy buffering (e.g. nginx).
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
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
    res.flush?.();
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

// Generic live push to a user's open SSE connections. Returns true if the
// user had at least one live connection. Unlike notifyApprovalDecision this
// does NOT queue for offline users — callers that need durability (e.g.
// in-app notifications) persist to the DB and rehydrate on page load instead.
const notifyUser = ({ userId, event, payload }) => {
  if (!userId || !event) return false;
  const set = connections.get(userId);
  if (!set || set.size === 0) return false;
  set.forEach((res) => sendEvent(res, event, payload));
  return true;
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
  notifyUser,
  ackApprovalDecisions: (userId) => {
    if (!userId) return;
    pendingEvents.delete(userId);
  },
};
