exports.up = async function up(knex) {
  await knex.raw(`
    DO $$
    BEGIN
      IF to_regclass('erp.production_stages') IS NULL THEN
        RETURN;
      END IF;

      -- Keep one active stage per department; deactivate older duplicates.
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY dept_id
            ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
          ) AS rn
        FROM erp.production_stages
        WHERE is_active = true
      )
      UPDATE erp.production_stages ps
      SET is_active = false,
          updated_at = now()
      FROM ranked r
      WHERE ps.id = r.id
        AND r.rn > 1;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_production_stages_active_dept
      ON erp.production_stages(dept_id)
      WHERE is_active = true;
  `);
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.uq_production_stages_active_dept");
};
