exports.up = async function up(knex) {
  await knex.raw(`
    DO $$
    BEGIN
      IF to_regclass('erp.bom_rm_line') IS NOT NULL THEN
        ALTER TABLE erp.bom_rm_line
        DROP CONSTRAINT IF EXISTS bom_rm_line_qty_check;

        ALTER TABLE erp.bom_rm_line
        ADD CONSTRAINT bom_rm_line_qty_check
        CHECK (qty >= 0);
      END IF;
    END
    $$;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DO $$
    BEGIN
      IF to_regclass('erp.bom_rm_line') IS NOT NULL THEN
        ALTER TABLE erp.bom_rm_line
        DROP CONSTRAINT IF EXISTS bom_rm_line_qty_check;

        ALTER TABLE erp.bom_rm_line
        ADD CONSTRAINT bom_rm_line_qty_check
        CHECK (qty > 0);
      END IF;
    END
    $$;
  `);
};
