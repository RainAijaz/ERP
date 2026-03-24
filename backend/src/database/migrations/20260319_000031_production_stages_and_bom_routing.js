exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.production_stages (
      id          bigserial PRIMARY KEY,
      code        text NOT NULL UNIQUE,
      name        text NOT NULL UNIQUE,
      name_ur     text,
      dept_id     bigint NOT NULL REFERENCES erp.departments(id) ON DELETE RESTRICT,
      is_active   boolean NOT NULL DEFAULT true,
      created_by  bigint REFERENCES erp.users(id),
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  bigint REFERENCES erp.users(id),
      updated_at  timestamptz,
      CHECK (code = upper(trim(code)))
    );

    CREATE INDEX IF NOT EXISTS idx_production_stages_dept_id
      ON erp.production_stages(dept_id);

    CREATE TABLE IF NOT EXISTS erp.bom_stage_routing (
      id           bigserial PRIMARY KEY,
      bom_id       bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,
      stage_id     bigint NOT NULL REFERENCES erp.production_stages(id) ON DELETE RESTRICT,
      sequence_no  int NOT NULL CHECK (sequence_no > 0),
      is_required  boolean NOT NULL DEFAULT true,
      created_at   timestamptz NOT NULL DEFAULT now(),
      UNIQUE (bom_id, stage_id),
      UNIQUE (bom_id, sequence_no)
    );

    CREATE INDEX IF NOT EXISTS idx_bom_stage_routing_bom_seq
      ON erp.bom_stage_routing(bom_id, sequence_no);
  `);

  await knex.raw(`
    ALTER TABLE IF EXISTS erp.dcv_header
      ADD COLUMN IF NOT EXISTS stage_id bigint;
    ALTER TABLE IF EXISTS erp.production_line
      ADD COLUMN IF NOT EXISTS stage_id bigint;
    ALTER TABLE IF EXISTS erp.abnormal_loss_line
      ADD COLUMN IF NOT EXISTS stage_id bigint;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'dcv_header_stage_id_fkey'
          AND conrelid = 'erp.dcv_header'::regclass
      ) THEN
        ALTER TABLE erp.dcv_header
          ADD CONSTRAINT dcv_header_stage_id_fkey
          FOREIGN KEY (stage_id)
          REFERENCES erp.production_stages(id)
          ON DELETE RESTRICT;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'production_line_stage_id_fkey'
          AND conrelid = 'erp.production_line'::regclass
      ) THEN
        ALTER TABLE erp.production_line
          ADD CONSTRAINT production_line_stage_id_fkey
          FOREIGN KEY (stage_id)
          REFERENCES erp.production_stages(id)
          ON DELETE RESTRICT;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'abnormal_loss_line_stage_id_fkey'
          AND conrelid = 'erp.abnormal_loss_line'::regclass
      ) THEN
        ALTER TABLE erp.abnormal_loss_line
          ADD CONSTRAINT abnormal_loss_line_stage_id_fkey
          FOREIGN KEY (stage_id)
          REFERENCES erp.production_stages(id)
          ON DELETE RESTRICT;
      END IF;
    END $$;
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_production_line_stage_id
      ON erp.production_line(stage_id);
    CREATE INDEX IF NOT EXISTS idx_dcv_header_stage_id
      ON erp.dcv_header(stage_id);
    CREATE INDEX IF NOT EXISTS idx_abnormal_loss_line_stage_id
      ON erp.abnormal_loss_line(stage_id);
  `);
};

exports.down = async function down(knex) {
  await knex.raw("DROP INDEX IF EXISTS erp.idx_abnormal_loss_line_stage_id");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_dcv_header_stage_id");
  await knex.raw("DROP INDEX IF EXISTS erp.idx_production_line_stage_id");

  await knex.raw(`
    ALTER TABLE IF EXISTS erp.abnormal_loss_line DROP COLUMN IF EXISTS stage_id;
    ALTER TABLE IF EXISTS erp.production_line DROP COLUMN IF EXISTS stage_id;
    ALTER TABLE IF EXISTS erp.dcv_header DROP COLUMN IF EXISTS stage_id;
  `);

  await knex.raw("DROP INDEX IF EXISTS erp.idx_bom_stage_routing_bom_seq");
  await knex.schema.withSchema("erp").dropTableIfExists("bom_stage_routing");

  await knex.raw("DROP INDEX IF EXISTS erp.idx_production_stages_dept_id");
  await knex.schema.withSchema("erp").dropTableIfExists("production_stages");
};
