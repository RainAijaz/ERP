exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.stock_transfer_out_header
      ADD COLUMN IF NOT EXISTS next_stage_id bigint REFERENCES erp.production_stages(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS stage_dispute boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS stage_dispute_reason varchar(500)
  `);
  await knex.raw(`
    ALTER TABLE erp.stock_transfer_out_header
      ADD CONSTRAINT stock_transfer_out_stage_dispute_check
      CHECK (
        (stage_dispute = false AND stage_dispute_reason IS NULL)
        OR
        (stage_dispute = true AND is_wip_transfer = true
          AND stage_dispute_reason IS NOT NULL
          AND length(trim(stage_dispute_reason)) > 0)
      )
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.stock_transfer_out_header
      DROP CONSTRAINT IF EXISTS stock_transfer_out_stage_dispute_check,
      DROP COLUMN IF EXISTS stage_dispute_reason,
      DROP COLUMN IF EXISTS stage_dispute,
      DROP COLUMN IF EXISTS next_stage_id
  `);
};
