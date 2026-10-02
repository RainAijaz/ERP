exports.up = async (knex) => {
  await knex.raw(`
    ALTER TABLE erp.bom_sfg_line
      ADD COLUMN IF NOT EXISTS output_sku_id bigint REFERENCES erp.skus(id) ON DELETE RESTRICT;
    ALTER TABLE erp.bom_sfg_line
      DROP CONSTRAINT IF EXISTS bom_sfg_line_bom_id_fg_size_id_sfg_sku_id_key;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_sfg_legacy_size_input
      ON erp.bom_sfg_line (bom_id, fg_size_id, sfg_sku_id)
      WHERE output_sku_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_sfg_output_sku_input
      ON erp.bom_sfg_line (bom_id, output_sku_id, sfg_sku_id)
      WHERE output_sku_id IS NOT NULL;

    CREATE OR REPLACE FUNCTION erp.trg_bom_sfg_output_sku_validate()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      parent_item_id bigint;
      output_item_id bigint;
      output_size_id bigint;
    BEGIN
      IF NEW.output_sku_id IS NULL THEN RETURN NEW; END IF;
      SELECT item_id INTO parent_item_id
        FROM erp.bom_header WHERE id = NEW.bom_id;
      SELECT v.item_id, v.size_id INTO output_item_id, output_size_id
        FROM erp.skus s JOIN erp.variants v ON v.id = s.variant_id
        WHERE s.id = NEW.output_sku_id;
      IF parent_item_id IS NULL OR output_item_id IS DISTINCT FROM parent_item_id
         OR output_size_id IS DISTINCT FROM NEW.fg_size_id THEN
        RAISE EXCEPTION 'SFG output SKU must belong to the BOM item and match its size.';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS trg_bom_sfg_output_sku_validate ON erp.bom_sfg_line;
    CREATE TRIGGER trg_bom_sfg_output_sku_validate
      BEFORE INSERT OR UPDATE ON erp.bom_sfg_line
      FOR EACH ROW EXECUTE FUNCTION erp.trg_bom_sfg_output_sku_validate();
  `);
};

exports.down = async (knex) => {
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_bom_sfg_output_sku_validate ON erp.bom_sfg_line;
    DROP FUNCTION IF EXISTS erp.trg_bom_sfg_output_sku_validate();
    DROP INDEX IF EXISTS erp.ux_bom_sfg_output_sku_input;
    DROP INDEX IF EXISTS erp.ux_bom_sfg_legacy_size_input;
    ALTER TABLE erp.bom_sfg_line
      ADD CONSTRAINT bom_sfg_line_bom_id_fg_size_id_sfg_sku_id_key
      UNIQUE (bom_id, fg_size_id, sfg_sku_id);
    ALTER TABLE erp.bom_sfg_line DROP COLUMN IF EXISTS output_sku_id;
  `);
};
