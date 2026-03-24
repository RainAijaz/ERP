SET search_path = erp;

-- Archive table for one-time capture before dropping legacy advanced BOM rule tables.
CREATE TABLE IF NOT EXISTS erp._archive_bom_advanced_rules (
  id           bigserial PRIMARY KEY,
  source_table text NOT NULL,
  source_id    bigint NOT NULL,
  bom_id       bigint,
  row_data     jsonb NOT NULL,
  archived_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_archive_bom_advanced_rules_source
ON erp._archive_bom_advanced_rules (source_table, source_id);

DO $$
BEGIN
  IF to_regclass('erp.bom_variant_rule') IS NOT NULL THEN
    INSERT INTO erp._archive_bom_advanced_rules (source_table, source_id, bom_id, row_data)
    SELECT
      'bom_variant_rule',
      t.id,
      t.bom_id,
      to_jsonb(t)
    FROM erp.bom_variant_rule AS t
    ON CONFLICT (source_table, source_id) DO NOTHING;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('erp.bom_sku_override_line') IS NOT NULL THEN
    INSERT INTO erp._archive_bom_advanced_rules (source_table, source_id, bom_id, row_data)
    SELECT
      'bom_sku_override_line',
      t.id,
      t.bom_id,
      to_jsonb(t)
    FROM erp.bom_sku_override_line AS t
    ON CONFLICT (source_table, source_id) DO NOTHING;
  END IF;
END $$;

DROP INDEX IF EXISTS erp.ux_bom_variant_rule_unique;
DROP INDEX IF EXISTS erp.idx_bom_sku_override_line_bom_sku;
DROP INDEX IF EXISTS erp.ux_bom_sku_override_line_unique;

DO $$
BEGIN
  IF to_regclass('erp.bom_variant_rule') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_bom_variant_rule_validate_target_rm ON erp.bom_variant_rule;
  END IF;
END $$;

DROP TABLE IF EXISTS erp.bom_sku_override_line;
DROP TABLE IF EXISTS erp.bom_variant_rule;
DROP FUNCTION IF EXISTS erp.trg_bom_variant_rule_validate_target_rm();
DROP TYPE IF EXISTS erp.bom_rule_action_type;
