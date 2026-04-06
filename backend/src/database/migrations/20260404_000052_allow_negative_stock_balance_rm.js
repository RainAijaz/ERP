exports.up = async function up(knex) {
  await knex.raw(`
    DO $$
    DECLARE
      rec record;
    BEGIN
      FOR rec IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'erp'
          AND t.relname = 'stock_balance_rm'
          AND c.contype = 'c'
          AND (
            pg_get_constraintdef(c.oid) ILIKE '%qty%>=%'
            OR pg_get_constraintdef(c.oid) ILIKE '%value%>=%'
          )
      LOOP
        EXECUTE format(
          'ALTER TABLE erp.stock_balance_rm DROP CONSTRAINT IF EXISTS %I',
          rec.conname
        );
      END LOOP;
    END
    $$;
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_balance_rm
      DROP CONSTRAINT IF EXISTS stock_balance_rm_wac_check
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_balance_rm
      ADD CONSTRAINT stock_balance_rm_wac_check
      CHECK (wac >= 0)
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.stock_balance_rm
      DROP CONSTRAINT IF EXISTS stock_balance_rm_wac_check
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_balance_rm
      ADD CONSTRAINT stock_balance_rm_qty_check
      CHECK (qty >= 0)
  `);

  await knex.raw(`
    ALTER TABLE erp.stock_balance_rm
      ADD CONSTRAINT stock_balance_rm_value_check
      CHECK (value >= 0)
  `);
};

