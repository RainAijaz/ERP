exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp._archive_bom_advanced_rules (
      id           bigserial PRIMARY KEY,
      source_table text NOT NULL,
      source_id    bigint NOT NULL,
      bom_id       bigint,
      row_data     jsonb NOT NULL,
      archived_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_archive_bom_advanced_rules_source
    ON erp._archive_bom_advanced_rules (source_table, source_id)
  `);

  await knex.raw(`
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
    END
    $$;
  `);

  await knex.raw(`
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
    END
    $$;
  `);

  await knex.raw("DROP INDEX IF EXISTS erp.ux_bom_variant_rule_unique");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_bom_sku_override_line_bom_sku");
  await knex.raw("DROP INDEX IF EXISTS erp.ux_bom_sku_override_line_unique");

  await knex.raw(`
    DO $$
    BEGIN
      IF to_regclass('erp.bom_variant_rule') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_bom_variant_rule_validate_target_rm ON erp.bom_variant_rule;
      END IF;
    END
    $$;
  `);

  await knex.raw("DROP TABLE IF EXISTS erp.bom_sku_override_line");
  await knex.raw("DROP TABLE IF EXISTS erp.bom_variant_rule");
  await knex.raw("DROP FUNCTION IF EXISTS erp.trg_bom_variant_rule_validate_target_rm()");
  await knex.raw("DROP TYPE IF EXISTS erp.bom_rule_action_type");
};

exports.down = async function down(knex) {
  await knex.raw(`
    DO $$
    BEGIN
      CREATE TYPE erp.bom_rule_action_type AS ENUM ('ADD_RM','REMOVE_RM','REPLACE_RM','ADJUST_QTY','CHANGE_LOSS');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END
    $$;
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.bom_variant_rule (
      id                 bigserial PRIMARY KEY,
      bom_id             bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,
      size_scope         erp.bom_scope NOT NULL DEFAULT 'ALL',
      size_id            bigint REFERENCES erp.sizes(id),
      packing_scope      erp.bom_scope NOT NULL DEFAULT 'ALL',
      packing_type_id    bigint REFERENCES erp.packing_types(id),
      color_scope        erp.bom_scope NOT NULL DEFAULT 'ALL',
      color_id           bigint REFERENCES erp.colors(id),
      action_type        erp.bom_rule_action_type NOT NULL,
      material_scope     erp.bom_scope NOT NULL,
      target_rm_item_id  bigint REFERENCES erp.items(id),
      new_value          jsonb NOT NULL DEFAULT '{}'::jsonb,
      CHECK (
        (size_scope = 'ALL' AND size_id IS NULL)
        OR
        (size_scope = 'SPECIFIC' AND size_id IS NOT NULL)
      ),
      CHECK (
        (packing_scope = 'ALL' AND packing_type_id IS NULL)
        OR
        (packing_scope = 'SPECIFIC' AND packing_type_id IS NOT NULL)
      ),
      CHECK (
        (color_scope = 'ALL' AND color_id IS NULL)
        OR
        (color_scope = 'SPECIFIC' AND color_id IS NOT NULL)
      ),
      CHECK (
        (material_scope = 'ALL' AND target_rm_item_id IS NULL)
        OR
        (material_scope = 'SPECIFIC' AND target_rm_item_id IS NOT NULL)
      )
    )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_bom_variant_rule_unique
    ON erp.bom_variant_rule (
      bom_id,
      size_scope,        COALESCE(size_id, 0),
      packing_scope,     COALESCE(packing_type_id, 0),
      color_scope,       COALESCE(color_id, 0),
      action_type,
      material_scope,    COALESCE(target_rm_item_id, 0)
    )
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.bom_sku_override_line (
      id                     bigserial PRIMARY KEY,
      bom_id                 bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,
      sku_id                 bigint NOT NULL REFERENCES erp.skus(id) ON DELETE RESTRICT,
      target_rm_item_id      bigint NOT NULL REFERENCES erp.items(id) ON DELETE RESTRICT,
      dept_id                bigint REFERENCES erp.departments(id) ON DELETE RESTRICT,
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
    ON erp.bom_sku_override_line (bom_id, sku_id, target_rm_item_id, COALESCE(dept_id, 0::bigint))
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_bom_sku_override_line_bom_sku
    ON erp.bom_sku_override_line (bom_id, sku_id)
  `);
};
