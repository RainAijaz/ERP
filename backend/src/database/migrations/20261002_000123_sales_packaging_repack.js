exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.packaging_conversion_rule (
      id bigserial PRIMARY KEY,
      item_id bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,
      source_packing_type_id bigint NOT NULL REFERENCES erp.packing_types(id) ON DELETE RESTRICT,
      target_packing_type_id bigint NOT NULL REFERENCES erp.packing_types(id) ON DELETE RESTRICT,
      consume_rm_item_id bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,
      pairs_per_pack integer NOT NULL DEFAULT 1 CHECK (pairs_per_pack > 0),
      consume_qty_per_pack numeric(18,3) NOT NULL CHECK (consume_qty_per_pack > 0),
      consume_color_id bigint REFERENCES erp.colors(id),
      consume_size_id bigint REFERENCES erp.sizes(id),
      recover_rm_item_id bigint REFERENCES erp.items(id) ON DELETE RESTRICT,
      recover_qty_per_pair numeric(18,3) NOT NULL DEFAULT 0 CHECK (recover_qty_per_pair >= 0),
      recover_color_id bigint REFERENCES erp.colors(id),
      recover_size_id bigint REFERENCES erp.sizes(id),
      is_active boolean NOT NULL DEFAULT false,
      created_by bigint REFERENCES erp.users(id),
      updated_by bigint REFERENCES erp.users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (item_id, source_packing_type_id, target_packing_type_id),
      CHECK (source_packing_type_id <> target_packing_type_id),
      CHECK ((recover_rm_item_id IS NULL AND recover_qty_per_pair = 0)
          OR (recover_rm_item_id IS NOT NULL AND recover_qty_per_pair > 0))
    )
  `);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.sales_packaging_conversion (
      id bigserial PRIMARY KEY,
      voucher_header_id bigint NOT NULL REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
      voucher_line_id bigint REFERENCES erp.voucher_line(id) ON DELETE SET NULL,
      rule_id bigint REFERENCES erp.packaging_conversion_rule(id) ON DELETE SET NULL,
      source_sku_id bigint NOT NULL REFERENCES erp.skus(id) ON DELETE RESTRICT,
      target_sku_id bigint NOT NULL REFERENCES erp.skus(id) ON DELETE RESTRICT,
      qty_pairs integer NOT NULL CHECK (qty_pairs > 0),
      is_packed boolean NOT NULL,
      source_value numeric(18,2) NOT NULL CHECK (source_value >= 0),
      packaging_value numeric(18,2) NOT NULL CHECK (packaging_value >= 0),
      recovered_value numeric(18,2) NOT NULL DEFAULT 0 CHECK (recovered_value >= 0),
      had_recovery boolean NOT NULL DEFAULT false,
      consume_ledger_id bigint REFERENCES erp.stock_ledger(id) ON DELETE SET NULL,
      recover_ledger_id bigint REFERENCES erp.stock_ledger(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_packaging_conversion_one_active_target
    ON erp.packaging_conversion_rule(item_id, target_packing_type_id)
    WHERE is_active = true`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sales_packaging_conversion_voucher
    ON erp.sales_packaging_conversion(voucher_header_id, voucher_line_id)`);
  await knex("erp.entity_type_registry")
    .insert({ code: "PACKAGING_CONVERSION_RULE", name: "Packaging conversion rule", is_active: true })
    .onConflict("code").ignore();
};

exports.down = async function down(knex) {
  await knex.raw("DROP TABLE IF EXISTS erp.sales_packaging_conversion");
  await knex.raw("DROP TABLE IF EXISTS erp.packaging_conversion_rule");
};
