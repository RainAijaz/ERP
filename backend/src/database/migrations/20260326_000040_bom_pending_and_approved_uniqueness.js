exports.up = async function up(knex) {
  const hasIsActive = await knex.schema.withSchema("erp").hasColumn("bom_header", "is_active");

  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY entity_id, COALESCE(new_value ->> '_action', '')
          ORDER BY requested_at DESC, id DESC
        ) AS rn
      FROM erp.approval_request
      WHERE entity_type = 'BOM'
        AND status = 'PENDING'
    )
    DELETE FROM erp.approval_request ar
    USING ranked r
    WHERE ar.id = r.id
      AND r.rn > 1
  `);

  if (hasIsActive) {
    await knex.raw(`
      WITH ranked AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            PARTITION BY item_id, level
            ORDER BY approved_at DESC NULLS LAST, id DESC
          ) AS rn
        FROM erp.bom_header
        WHERE status = 'APPROVED'
          AND is_active = true
      )
      UPDATE erp.bom_header bh
      SET is_active = false
      FROM ranked r
      WHERE bh.id = r.id
        AND r.rn > 1
    `);
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_approval_request_bom_pending_action
    ON erp.approval_request (entity_id, (COALESCE(new_value ->> '_action', '')))
    WHERE entity_type = 'BOM' AND status = 'PENDING'
  `);

  if (hasIsActive) {
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_header_single_approved_active
      ON erp.bom_header (item_id, level)
      WHERE status = 'APPROVED' AND is_active = true
    `);
  }
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.ux_bom_header_single_approved_active");
  await knex.raw("DROP INDEX IF EXISTS erp.ux_approval_request_bom_pending_action");
};
