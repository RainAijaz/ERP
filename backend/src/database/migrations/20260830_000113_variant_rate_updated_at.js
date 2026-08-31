// 20260830_000113_variant_rate_updated_at.js
//
// Adds erp.variants.rate_updated_at: the moment sale_rate last actually changed.
//
// Why a new column instead of reusing updated_at: updated_at is bumped by every
// write that touches the row -- the active toggle, the rate_editable toggle, a
// master-data import that rewrites an unchanged rate, and the bulk rate screen,
// which UPDATEs every variant submitted with the form whether or not its rate
// moved. Reading it as "the rate changed" would highlight rows nobody repriced.
//
// The column is stamped only when the new rate actually differs from the stored
// one (see routes/master_data/products/skus.js, utils/approval-applier.js and
// services/master-data/master-data-import-service.js). Creating a variant
// deliberately leaves it NULL: a brand-new SKU has an opening rate, not a rate
// change, and created_at already records it.
//
// BACKFILL: only the approvals trail carries dated, valued rate history --
// approved SKU edits and SKU_BULK_RATE_UPDATE batches both store the new rate
// alongside decided_at. Rate edits applied directly (approval not required)
// left no valued history anywhere -- erp.activity_log records SKU/UPDATE with
// no old/new values, and it cannot be told apart from a rate_editable toggle --
// so those rows stay NULL rather than guessed at. The column is exact from this
// migration forward.

exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.variants
      ADD COLUMN IF NOT EXISTS rate_updated_at timestamptz;
  `);

  await knex.raw(`
    UPDATE erp.variants v
    SET rate_updated_at = src.changed_at
    FROM (
      SELECT variant_id, MAX(decided_at) AS changed_at
      FROM (
        -- Single-SKU rate edit: entity_id is the variant id.
        SELECT (ar.entity_id)::bigint AS variant_id, ar.decided_at
        FROM erp.approval_request ar
        WHERE ar.entity_type = 'SKU'
          AND ar.status = 'APPROVED'
          AND ar.decided_at IS NOT NULL
          AND ar.entity_id ~ '^[0-9]+$'
          AND COALESCE(ar.new_value->>'_action', 'update') = 'update'

        UNION ALL

        -- Bulk rate update: one request, one row per repriced variant in the
        -- payload. CASE guard is load-bearing -- jsonb_array_elements runs
        -- before the WHERE clause and errors on a non-array payload.
        SELECT (item->>'id')::bigint AS variant_id, ar.decided_at
        FROM erp.approval_request ar
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(ar.new_value->'variants') = 'array'
              THEN ar.new_value->'variants'
            ELSE '[]'::jsonb
          END
        ) AS item
        WHERE ar.entity_type = 'SKU_BULK_RATE_UPDATE'
          AND ar.status = 'APPROVED'
          AND ar.decided_at IS NOT NULL
          AND item->>'id' ~ '^[0-9]+$'
      ) changes
      GROUP BY variant_id
    ) src
    WHERE v.id = src.variant_id;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.variants
      DROP COLUMN IF EXISTS rate_updated_at;
  `);
};
