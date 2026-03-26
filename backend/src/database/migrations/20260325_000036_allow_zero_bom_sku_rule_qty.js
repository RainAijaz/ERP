exports.up = async function up(knex) {
  await knex.raw(`
    DO $$
    BEGIN
      IF to_regclass('erp.bom_sku_override_line') IS NOT NULL THEN
        ALTER TABLE erp.bom_sku_override_line
        DROP CONSTRAINT IF EXISTS bom_sku_override_line_override_qty_check;

        ALTER TABLE erp.bom_sku_override_line
        ADD CONSTRAINT bom_sku_override_line_override_qty_check
        CHECK (override_qty IS NULL OR override_qty >= 0);
      END IF;
    END
    $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DO $$
    BEGIN
      IF to_regclass('erp.bom_sku_override_line') IS NOT NULL THEN
        ALTER TABLE erp.bom_sku_override_line
        DROP CONSTRAINT IF EXISTS bom_sku_override_line_override_qty_check;

        ALTER TABLE erp.bom_sku_override_line
        ADD CONSTRAINT bom_sku_override_line_override_qty_check
        CHECK (override_qty IS NULL OR override_qty > 0);
      END IF;
    END
    $$;
  `);
};
