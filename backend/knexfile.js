require("dotenv").config();

/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */
const toNumberOrDefault = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const createPoolConfig = () => {
  const statementTimeoutMs = toNumberOrDefault(
    process.env.DB_STATEMENT_TIMEOUT_MS,
    0,
  );
  const lockTimeoutMs = toNumberOrDefault(process.env.DB_LOCK_TIMEOUT_MS, 0);
  const idleInTxTimeoutMs = toNumberOrDefault(
    process.env.DB_IDLE_IN_TX_TIMEOUT_MS,
    0,
  );

  return {
    min: toNumberOrDefault(process.env.DB_POOL_MIN, 2),
    max: toNumberOrDefault(process.env.DB_POOL_MAX, 20),
    acquireTimeoutMillis: toNumberOrDefault(
      process.env.DB_POOL_TIMEOUT_MS,
      60000,
    ),
    createTimeoutMillis: toNumberOrDefault(
      process.env.DB_POOL_CREATE_TIMEOUT_MS,
      30000,
    ),
    idleTimeoutMillis: toNumberOrDefault(
      process.env.DB_POOL_IDLE_TIMEOUT_MS,
      30000,
    ),
    reapIntervalMillis: toNumberOrDefault(
      process.env.DB_POOL_REAP_INTERVAL_MS,
      1000,
    ),
    createRetryIntervalMillis: toNumberOrDefault(
      process.env.DB_POOL_CREATE_RETRY_MS,
      200,
    ),
    propagateCreateError: false,
    afterCreate: (conn, done) => {
      const sessionStatements = [];
      if (statementTimeoutMs > 0) {
        sessionStatements.push(`SET statement_timeout = ${statementTimeoutMs}`);
      }
      if (lockTimeoutMs > 0) {
        sessionStatements.push(`SET lock_timeout = ${lockTimeoutMs}`);
      }
      if (idleInTxTimeoutMs > 0) {
        sessionStatements.push(
          `SET idle_in_transaction_session_timeout = ${idleInTxTimeoutMs}`,
        );
      }

      if (!sessionStatements.length) {
        done(null, conn);
        return;
      }

      conn.query(sessionStatements.join("; "), (err) => {
        done(err, conn);
      });
    },
  };
};

const createConnectionFromEnv = () => {
  const useSsl = String(process.env.DB_SSL || "false").toLowerCase() === "true";
  return {
    host: process.env.DB_HOST || "localhost",
    port: +(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || "erp",
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  };
};

const resolveConnection = () => process.env.DATABASE_URL || createConnectionFromEnv();

const createKnexConfig = ({ connection }) => ({
  client: "pg",
  connection,
  pool: createPoolConfig(),
  migrations: {
    directory: "./src/database/migrations",
    tableName: "knex_migrations",
  },
  seeds: {
    directory: "./src/database/seeds",
  },
});

module.exports = {
  development: createKnexConfig({
    connection: createConnectionFromEnv(),
  }),

  staging: createKnexConfig({
    connection: resolveConnection(),
  }),

  production: createKnexConfig({
    connection: resolveConnection(),
  }),
};
