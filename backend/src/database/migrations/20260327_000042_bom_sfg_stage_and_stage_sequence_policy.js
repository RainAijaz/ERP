exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.bom_stage_routing
      ADD COLUMN IF NOT EXISTS enforce_sequence boolean;
  `);

  await knex.raw(`
    UPDATE erp.bom_stage_routing
    SET enforce_sequence = true
    WHERE enforce_sequence IS NULL;
  `);

  await knex.raw(`
    ALTER TABLE erp.bom_stage_routing
      ALTER COLUMN enforce_sequence SET DEFAULT true,
      ALTER COLUMN enforce_sequence SET NOT NULL;
  `);

  await knex.raw(`
    ALTER TABLE erp.bom_sfg_line
      ADD COLUMN IF NOT EXISTS consumed_in_stage_id bigint;
  `);

  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'bom_sfg_line_consumed_in_stage_id_fkey'
          AND conrelid = 'erp.bom_sfg_line'::regclass
      ) THEN
        ALTER TABLE erp.bom_sfg_line
          ADD CONSTRAINT bom_sfg_line_consumed_in_stage_id_fkey
          FOREIGN KEY (consumed_in_stage_id)
          REFERENCES erp.production_stages(id)
          ON DELETE RESTRICT;
      END IF;
    END $$;
  `);

  await knex.raw(`
    UPDATE erp.bom_sfg_line bsl
    SET consumed_in_stage_id = (
      SELECT bsr.stage_id
      FROM erp.bom_stage_routing bsr
      WHERE bsr.bom_id = bsl.bom_id
      ORDER BY bsr.sequence_no DESC
      LIMIT 1
    )
    WHERE bsl.consumed_in_stage_id IS NULL;
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_bom_sfg_line_consumed_stage
      ON erp.bom_sfg_line(consumed_in_stage_id);
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS erp.idx_bom_sfg_line_consumed_stage;
  `);

  await knex.raw(`
    ALTER TABLE erp.bom_sfg_line
      DROP CONSTRAINT IF EXISTS bom_sfg_line_consumed_in_stage_id_fkey;
  `);

  await knex.raw(`
    ALTER TABLE erp.bom_sfg_line
      DROP COLUMN IF EXISTS consumed_in_stage_id;
  `);

  await knex.raw(`
    ALTER TABLE erp.bom_stage_routing
      DROP COLUMN IF EXISTS enforce_sequence;
  `);
};
