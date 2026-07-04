exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO erp.entity_type_registry (code, name, description)
    VALUES ('SKU_BULK_RATE_UPDATE', 'SKU Bulk Rate Update', 'Bulk sale-rate change for SKU variants queued for approval')
    ON CONFLICT (code) DO NOTHING
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM erp.entity_type_registry
    WHERE code = 'SKU_BULK_RATE_UPDATE'
  `);
};
