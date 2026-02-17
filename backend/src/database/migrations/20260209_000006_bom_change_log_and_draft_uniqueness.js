exports.up = async function up(knex) {
  await knex.raw("ALTER TABLE erp.bom_header DROP CONSTRAINT IF EXISTS bom_header_check");

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.bom_change_log (
      id          bigserial PRIMARY KEY,
      bom_id      bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,
      version_no  int NOT NULL,
      request_id  bigint REFERENCES erp.approval_request(id) ON DELETE SET NULL,
      section     text NOT NULL,
      entity_key  text NOT NULL,
      change_type text NOT NULL,
      old_value   jsonb,
      new_value   jsonb,
      changed_by  bigint REFERENCES erp.users(id) ON DELETE SET NULL,
      changed_at  timestamptz NOT NULL DEFAULT now(),
      CHECK (change_type IN ('ADDED', 'UPDATED', 'REMOVED'))
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_header_single_draft
    ON erp.bom_header (item_id, level)
    WHERE status = 'DRAFT'
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_bom_change_log_bom_version
    ON erp.bom_change_log (bom_id, version_no, changed_at DESC)
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.bom_header
    ADD CONSTRAINT bom_header_check
    CHECK ((approved_by IS NULL) OR (approved_by <> created_by))
  `);

  await knex.raw("DROP INDEX IF EXISTS erp.idx_bom_change_log_bom_version");
  await knex.raw("DROP INDEX IF EXISTS erp.ux_bom_header_single_draft");
  await knex.raw("DROP TABLE IF EXISTS erp.bom_change_log");
};
