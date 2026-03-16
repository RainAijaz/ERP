exports.up = async function up(knex) {
  await knex.raw(`
    DO $$
    BEGIN
      IF to_regclass('erp.bom_sku_override_line') IS NOT NULL THEN
        ALTER TABLE erp.bom_sku_override_line
        ADD COLUMN IF NOT EXISTS dept_id bigint REFERENCES erp.departments(id) ON DELETE RESTRICT;

        WITH single_dept_rm AS (
          SELECT
            bom_id,
            rm_item_id,
            MIN(dept_id) AS dept_id
          FROM erp.bom_rm_line
          GROUP BY bom_id, rm_item_id
          HAVING COUNT(DISTINCT dept_id) = 1
        )
        UPDATE erp.bom_sku_override_line AS o
        SET dept_id = s.dept_id
        FROM single_dept_rm AS s
        WHERE
          o.dept_id IS NULL
          AND o.bom_id = s.bom_id
          AND o.target_rm_item_id = s.rm_item_id;
      END IF;
    END
    $$;
  `);

  await knex.raw("DROP INDEX IF EXISTS erp.ux_bom_sku_override_line_unique");
  await knex.raw(`
    DO $$
    BEGIN
      IF to_regclass('erp.bom_sku_override_line') IS NOT NULL THEN
        CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_sku_override_line_unique
        ON erp.bom_sku_override_line (bom_id, sku_id, target_rm_item_id, COALESCE(dept_id, 0::bigint));
      END IF;
    END
    $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.ux_bom_sku_override_line_unique");
  await knex.raw(`
    DO $$
    BEGIN
      IF to_regclass('erp.bom_sku_override_line') IS NOT NULL THEN
        CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_sku_override_line_unique
        ON erp.bom_sku_override_line (bom_id, sku_id, target_rm_item_id);
        ALTER TABLE erp.bom_sku_override_line
        DROP COLUMN IF EXISTS dept_id;
      END IF;
    END
    $$;
  `);
};
