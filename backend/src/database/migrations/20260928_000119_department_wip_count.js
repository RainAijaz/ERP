exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema("erp").hasTable("wip_count_header"))) {
    await knex.schema.withSchema("erp").createTable("wip_count_header", (table) => {
      table.bigInteger("voucher_id").primary().references("id").inTable("erp.voucher_header").onDelete("CASCADE");
      table.bigInteger("dept_id").notNullable().references("id").inTable("erp.departments");
      table.bigInteger("reason_code_id").notNullable().references("id").inTable("erp.reason_codes");
      table.text("reason_notes").notNullable();
    });
    await knex.raw(`
      ALTER TABLE erp.wip_count_header
      ADD CONSTRAINT wip_count_reason_notes_nonblank
      CHECK (length(btrim(reason_notes)) > 0)
    `);
  }

  await knex.raw(`
    INSERT INTO erp.reason_codes (code, name, description, requires_notes, is_active)
    VALUES (
      'DEPT_WIP_COUNT',
      'Department WIP Physical Count',
      'Counts unfinished articles in a production department and adjusts department WIP balances, not warehouse inventory.',
      true,
      true
    )
    ON CONFLICT (code) DO NOTHING
  `);
  await knex.raw(`
    INSERT INTO erp.reason_code_voucher_type_map (reason_code_id, voucher_type_code)
    SELECT id, 'STOCK_COUNT_ADJ'
    FROM erp.reason_codes
    WHERE code = 'DEPT_WIP_COUNT'
    ON CONFLICT (reason_code_id, voucher_type_code) DO NOTHING
  `);
};

exports.down = async function down(knex) {
  await knex.schema.withSchema("erp").dropTableIfExists("wip_count_header");
  await knex.raw(`
    DELETE FROM erp.reason_code_voucher_type_map
    WHERE voucher_type_code = 'STOCK_COUNT_ADJ'
      AND reason_code_id IN (SELECT id FROM erp.reason_codes WHERE code = 'DEPT_WIP_COUNT')
  `);
  await knex.raw(`
    DELETE FROM erp.reason_codes rc
    WHERE rc.code = 'DEPT_WIP_COUNT'
      AND NOT EXISTS (SELECT 1 FROM erp.stock_count_header sch WHERE sch.reason_code_id = rc.id)
      AND NOT EXISTS (SELECT 1 FROM erp.reason_code_voucher_type_map m WHERE m.reason_code_id = rc.id)
  `);
};
