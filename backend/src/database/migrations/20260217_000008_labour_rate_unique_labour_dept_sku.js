exports.up = async function up(knex) {
  await knex.raw(`
    DELETE FROM erp.labour_rate_rules r
    USING (
      SELECT id
      FROM (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY labour_id, dept_id, sku_id
            ORDER BY id DESC
          ) AS rn
        FROM erp.labour_rate_rules
        WHERE applies_to_all_labours = false
          AND labour_id IS NOT NULL
          AND sku_id IS NOT NULL
      ) t
      WHERE t.rn > 1
    ) d
    WHERE r.id = d.id
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_labour_rate_rules_labour_dept_sku
    ON erp.labour_rate_rules (labour_id, dept_id, sku_id)
    WHERE applies_to_all_labours = false
      AND labour_id IS NOT NULL
      AND sku_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.uq_labour_rate_rules_labour_dept_sku");
};

