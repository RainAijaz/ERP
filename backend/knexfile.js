require("dotenv").config();

/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */
module.exports = {
  development: {
    client: "pg",
    connection: {
      host: process.env.DB_HOST || "localhost",
      port: +(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || "erp",
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "",
    },
    pool: { min: 2, max: 10 },
    migrations: {
      directory: "./src/database/migrations",
      tableName: "knex_migrations",
    },
seeds: { directory: "./src/database/seeds" },
  },

  staging: {
    client: "pg",
    connection: process.env.DATABASE_URL, // optional later
    pool: { min: 2, max: 10 },
    migrations: {
      directory: "./src/database/migrations",
      tableName: "knex_migrations",
    },
    seeds: { directory: "./src/database/seeds" },
  },

  production: {
    client: "pg",
    connection: process.env.DATABASE_URL, // optional later
    pool: { min: 2, max: 10 },
    migrations: {
      directory: "./src/database/migrations",
      tableName: "knex_migrations",
    },
    seeds: { directory: "./src/database/seeds" },
  },
};
