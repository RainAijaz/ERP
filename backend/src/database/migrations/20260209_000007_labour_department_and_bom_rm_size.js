exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.labour_department (
      labour_id bigint NOT NULL REFERENCES erp.labours(id) ON DELETE CASCADE,
      dept_id   bigint NOT NULL REFERENCES erp.departments(id) ON DELETE RESTRICT,
      PRIMARY KEY (labour_id, dept_id)
    )
  `);

  await knex.raw(`
    INSERT INTO erp.labour_department (labour_id, dept_id)
    SELECT l.id, l.dept_id
    FROM erp.labours l
    WHERE l.dept_id IS NOT NULL
    ON CONFLICT (labour_id, dept_id) DO NOTHING
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_labour_department_dept_id
    ON erp.labour_department (dept_id)
  `);

  await knex.raw("ALTER TABLE erp.bom_rm_line ADD COLUMN IF NOT EXISTS size_id bigint REFERENCES erp.sizes(id)");

  await knex.raw("ALTER TABLE erp.bom_rm_line DROP CONSTRAINT IF EXISTS bom_rm_line_bom_id_rm_item_id_dept_id_color_id_key");
  await knex.raw("ALTER TABLE erp.bom_rm_line DROP CONSTRAINT IF EXISTS bom_rm_line_bom_id_rm_item_id_dept_id_color_id_size_id_key");
  await knex.raw(`
    ALTER TABLE erp.bom_rm_line
    ADD CONSTRAINT bom_rm_line_bom_id_rm_item_id_dept_id_color_id_size_id_key
    UNIQUE (bom_id, rm_item_id, dept_id, color_id, size_id)
  `);
};

exports.down = async function down(knex) {
  await knex.raw("ALTER TABLE erp.bom_rm_line DROP CONSTRAINT IF EXISTS bom_rm_line_bom_id_rm_item_id_dept_id_color_id_size_id_key");
  await knex.raw(`
    ALTER TABLE erp.bom_rm_line
    ADD CONSTRAINT bom_rm_line_bom_id_rm_item_id_dept_id_color_id_key
    UNIQUE (bom_id, rm_item_id, dept_id, color_id)
  `);
  await knex.raw("ALTER TABLE erp.bom_rm_line DROP COLUMN IF EXISTS size_id");

  await knex.raw("DROP INDEX IF EXISTS erp.idx_labour_department_dept_id");
  await knex.raw("DROP TABLE IF EXISTS erp.labour_department");
};
