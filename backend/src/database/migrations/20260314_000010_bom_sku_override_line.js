exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.bom_sku_override_line (
      id                     bigserial PRIMARY KEY,
      bom_id                 bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,
      sku_id                 bigint NOT NULL REFERENCES erp.skus(id) ON DELETE RESTRICT,
      target_rm_item_id      bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,
      is_excluded            boolean NOT NULL DEFAULT false,
      override_qty           numeric(18,3),
      override_uom_id        bigint REFERENCES erp.uom(id),
      replacement_rm_item_id bigint REFERENCES erp.items(id) ON DELETE RESTRICT,
      rm_color_id            bigint REFERENCES erp.colors(id),
      notes                  text,
      created_at             timestamptz NOT NULL DEFAULT now(),
      CHECK (override_qty IS NULL OR override_qty > 0)
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_sku_override_line_unique
    ON erp.bom_sku_override_line (bom_id, sku_id, target_rm_item_id)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_bom_sku_override_line_bom_sku
    ON erp.bom_sku_override_line (bom_id, sku_id)
  `);
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.idx_bom_sku_override_line_bom_sku");
  await knex.raw("DROP INDEX IF EXISTS erp.ux_bom_sku_override_line_unique");
  await knex.raw("DROP TABLE IF EXISTS erp.bom_sku_override_line");
};
