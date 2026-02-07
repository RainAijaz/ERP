// backend/src/db/knex.js
const knex = require("knex");
const config = require("../../knexfile");

const env = process.env.NODE_ENV || "development";
const instance = knex(config[env]);

const logPool = (label, err) => {
  if (process.env.DEBUG_DB_POOL_SERVER !== "1") return;
  const pool = instance?.client?.pool;
  const stats = pool
    ? {
        used: pool.numUsed?.(),
        free: pool.numFree?.(),
        pending: pool.numPendingAcquires?.(),
        pendingCreates: pool.numPendingCreates?.(),
        size: pool.size,
      }
    : null;
  // eslint-disable-next-line no-console
  console.log("[DB POOL SERVER]", label, stats || "no-pool", err ? { error: err.message } : "");
};

if (process.env.DEBUG_DB_POOL_SERVER === "1") {
  const pool = instance?.client?.pool;
  if (pool?.on) {
    pool.on("acquireRequest", () => logPool("acquireRequest"));
    pool.on("acquireSuccess", () => logPool("acquireSuccess"));
    pool.on("acquireFail", (err) => logPool("acquireFail", err));
    pool.on("release", () => logPool("release"));
    pool.on("createFail", (err) => logPool("createFail", err));
  }
}

module.exports = instance;
