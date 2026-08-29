// Cross-branch WIP transfer: let half-made pairs move between branches mid-routing
// (stages 1-2 at one branch, stage 3 at another) on the existing STN_OUT / GRN_IN rails.
//
// Until now the WIP pool was keyed (branch_id, sku_id, dept_id), so the stage gate in
// production-voucher-service.js could only ever see WIP at the posting user's own branch.
// Stage 3 at another branch was rejected with "previous stage WIP is insufficient", and the
// originating branch was left holding WIP it could never clear.
//
// Treatment mirrors how stock already crosses branches (the virtual-transit model documented
// in 080_inventory.sql): the pool gains a stock_state, STN_OUT moves source ON_HAND ->
// destination IN_TRANSIT, and GRN_IN moves destination IN_TRANSIT -> destination ON_HAND.
//
// erp.stock_state ('ON_HAND','IN_TRANSIT','WITH_THIRD_PARTY') already exists and is reused
// as-is, so this migration adds NO enum value and can run inside the normal transaction.
//
// NOTE on the deliberate non-choice here: WIP is NOT added to erp.stock_category. That enum
// is ('RM','SFG','FG') and is shared by stock_ledger.category, stock_balance_sku.category and
// the month-end snapshots -- a fourth value would leak into every one of them, and
// ALTER TYPE ... ADD VALUE cannot run in a transaction block. A WIP dispatch instead keeps
// the SKU's real category and is marked by is_wip_transfer + stage_id on the header, which
// also makes an RM work-in-process dispatch unrepresentable (correctly).

exports.up = async function up(knex) {
  // ---------------------------------------------------------------------------
  // WIP pool gains a stock_state
  // ---------------------------------------------------------------------------
  // DEFAULT 'ON_HAND' backfills every existing row correctly, so no data pass is needed:
  // all WIP that exists today is on hand at the branch that produced it.
  await knex.raw(`
    ALTER TABLE erp.wip_dept_balance
    ADD COLUMN IF NOT EXISTS stock_state erp.stock_state NOT NULL DEFAULT 'ON_HAND'
  `);

  await knex.raw(`
    ALTER TABLE erp.wip_dept_ledger
    ADD COLUMN IF NOT EXISTS stock_state erp.stock_state NOT NULL DEFAULT 'ON_HAND'
  `);

  // Repoint the balance primary key so a branch can hold the same SKU+dept in both
  // buckets at once. Mirrors stock_balance_sku, which is keyed on stock_state the same way.
  //
  // Every ON CONFLICT against this table must be updated to the new column list in the
  // same change -- a stale 3-column conflict target no longer matches a unique constraint
  // and raises "there is no unique or exclusion constraint matching the ON CONFLICT".
  await knex.raw(`
    ALTER TABLE erp.wip_dept_balance
    DROP CONSTRAINT IF EXISTS wip_dept_balance_pkey
  `);

  await knex.raw(`
    ALTER TABLE erp.wip_dept_balance
    ADD CONSTRAINT wip_dept_balance_pkey
    PRIMARY KEY (branch_id, stock_state, sku_id, dept_id)
  `);

  // ---------------------------------------------------------------------------
  // STN_OUT header learns to describe a WIP dispatch
  // ---------------------------------------------------------------------------
  // stock_type (erp.stock_category) is left alone and keeps meaning the SKU's own category.
  // is_wip_transfer is the discriminator; stage_id says which stage the pairs have completed.
  //
  // GRN_IN deliberately gets neither column -- it reads both from the STN_OUT it is raised
  // against (grn_in_header.against_stn_out_id), so the two can never disagree.
  await knex.raw(`
    ALTER TABLE erp.stock_transfer_out_header
      ADD COLUMN IF NOT EXISTS is_wip_transfer boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS stage_id bigint REFERENCES erp.production_stages(id) ON DELETE RESTRICT
  `);

  // A WIP dispatch is meaningless without the stage it came off; an ordinary stock
  // dispatch must not carry one.
  await knex.raw(`
    ALTER TABLE erp.stock_transfer_out_header
    DROP CONSTRAINT IF EXISTS stock_transfer_out_wip_stage_check
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_transfer_out_header
    ADD CONSTRAINT stock_transfer_out_wip_stage_check
    CHECK (
      (is_wip_transfer = true AND stage_id IS NOT NULL)
      OR
      (is_wip_transfer = false AND stage_id IS NULL)
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_stock_transfer_out_wip_stage
      ON erp.stock_transfer_out_header(stage_id)
      WHERE is_wip_transfer = true
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS erp.idx_stock_transfer_out_wip_stage
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_transfer_out_header
    DROP CONSTRAINT IF EXISTS stock_transfer_out_wip_stage_check
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_transfer_out_header
      DROP COLUMN IF EXISTS stage_id,
      DROP COLUMN IF EXISTS is_wip_transfer
  `);

  // Collapse the pool back to one bucket per (branch, sku, dept) before restoring the old
  // primary key. Anything still IN_TRANSIT is a dispatch that was never received; fold it
  // back into the destination's ON_HAND rather than dropping it, so no quantity or cost is
  // lost by rolling back. Same reasoning for the ledger rows.
  await knex.raw(`
    INSERT INTO erp.wip_dept_balance AS tgt
      (branch_id, stock_state, sku_id, dept_id, qty_pairs, cost_value, last_activity_date)
    SELECT branch_id, 'ON_HAND', sku_id, dept_id, qty_pairs, cost_value, last_activity_date
    FROM erp.wip_dept_balance
    WHERE stock_state <> 'ON_HAND'
    ON CONFLICT (branch_id, stock_state, sku_id, dept_id) DO UPDATE
    SET qty_pairs = tgt.qty_pairs + EXCLUDED.qty_pairs,
        cost_value = tgt.cost_value + EXCLUDED.cost_value,
        last_activity_date = GREATEST(tgt.last_activity_date, EXCLUDED.last_activity_date)
  `);

  await knex.raw(`
    DELETE FROM erp.wip_dept_balance WHERE stock_state <> 'ON_HAND'
  `);

  await knex.raw(`
    ALTER TABLE erp.wip_dept_balance
    DROP CONSTRAINT IF EXISTS wip_dept_balance_pkey
  `);

  await knex.raw(`
    ALTER TABLE erp.wip_dept_balance
    ADD CONSTRAINT wip_dept_balance_pkey
    PRIMARY KEY (branch_id, sku_id, dept_id)
  `);

  await knex.raw(`
    ALTER TABLE erp.wip_dept_ledger DROP COLUMN IF EXISTS stock_state
  `);

  await knex.raw(`
    ALTER TABLE erp.wip_dept_balance DROP COLUMN IF EXISTS stock_state
  `);
};
