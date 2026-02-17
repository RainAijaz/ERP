exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.labour_rate_rule_exclusions (
      id bigserial PRIMARY KEY,
      rule_id bigint NOT NULL REFERENCES erp.labour_rate_rules(id) ON DELETE CASCADE,
      sku_id bigint NOT NULL REFERENCES erp.skus(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_labour_rate_rule_exclusions_rule_sku
    ON erp.labour_rate_rule_exclusions (rule_id, sku_id)
  `);
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.uq_labour_rate_rule_exclusions_rule_sku");
  await knex.raw("DROP TABLE IF EXISTS erp.labour_rate_rule_exclusions");
};

