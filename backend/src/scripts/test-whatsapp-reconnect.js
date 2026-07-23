/*
 * Regression test for the WhatsApp reconnect path.
 *
 * Bug this guards: when client.initialize() rejects AFTER Chrome has launched
 * (network blip, timeout), the old code set `client = null` and re-initialised
 * without destroying the orphaned browser. That browser kept a lock on the
 * session profile, so every later attempt failed with
 *   "The browser is already running for <userDataDir>"
 * — a permanent reconnect loop that leaked Chrome processes and silently killed
 * WhatsApp until the service was restarted by hand.
 *
 * whatsapp-web.js is stubbed, so this runs offline and launches no browser.
 *
 *   npm run test:whatsapp-reconnect
 */
require("dotenv").config();
const path = require("path");

let failures = 0;
const check = (name, cond) => {
  const ok = Boolean(cond);
  console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}`);
  if (!ok) failures += 1;
};

// --- Stub whatsapp-web.js so no real browser is launched ---
const wwebPath = require.resolve("whatsapp-web.js");
const created = []; // every Client we construct
let failNextInit = true;

class FakeClient {
  constructor() {
    this.destroyed = false;
    this.initCalls = 0;
    this.handlers = {};
    created.push(this);
  }
  on(evt, fn) {
    this.handlers[evt] = fn;
  }
  async initialize() {
    this.initCalls += 1;
    if (failNextInit) {
      failNextInit = false;
      // Mirrors reality: Chrome is already up even though this rejects.
      throw new Error("Protocol error (Runtime.callFunctionOn): Execution context was destroyed.");
    }
    return true;
  }
  async destroy() {
    this.destroyed = true;
  }
}

require.cache[wwebPath] = {
  id: wwebPath,
  filename: wwebPath,
  loaded: true,
  exports: { Client: FakeClient, LocalAuth: class {} },
};

// qrcode-terminal / qrcode are only used in event handlers we never fire.
const { initWhatsApp } = require(path.join(__dirname, "..", "utils", "whatsapp.js"));

(async () => {
  console.log("=== WhatsApp reconnect regression ===");

  // Reconnect backoff is 30s for an init failure; don't wait for it in a test.
  const realSetTimeout = global.setTimeout;
  const pendingTimers = [];
  global.setTimeout = (fn, ms) => {
    // Capture the reconnect timer so we can fire it immediately.
    if (ms >= 1000) {
      pendingTimers.push(fn);
      return { unref() {} };
    }
    return realSetTimeout(fn, ms);
  };

  initWhatsApp();
  // Let the rejected initialize() settle.
  await new Promise((r) => realSetTimeout(r, 50));

  check("first client was constructed", created.length === 1);
  check("init was attempted and failed", created[0].initCalls === 1);
  check("a reconnect was scheduled", pendingTimers.length === 1);
  check("stale client NOT yet destroyed (waits for the timer)", created[0].destroyed === false);

  // Fire the scheduled reconnect.
  await pendingTimers[0]();
  await new Promise((r) => realSetTimeout(r, 50));

  // The actual regression: the orphaned browser must be torn down, otherwise it
  // keeps the profile locked and every retry dies with "already running".
  check("stale client WAS destroyed before re-init", created[0].destroyed === true);
  check("a fresh client was constructed", created.length === 2);
  check("fresh client initialised successfully", created[1].initCalls === 1);
  check("fresh client is alive (not destroyed)", created[1].destroyed === false);

  global.setTimeout = realSetTimeout;

  console.log(`\n${failures === 0 ? "ALL PASSED ✓" : failures + " CHECK(S) FAILED ✗"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("Test error:", e);
  process.exit(1);
});
