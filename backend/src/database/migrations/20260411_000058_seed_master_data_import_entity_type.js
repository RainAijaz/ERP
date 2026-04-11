exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO erp.entity_type_registry (code, name, description)
    VALUES ('MASTER_DATA_IMPORT', 'Master Data Import', 'Master data import audit activity')
    ON CONFLICT (code) DO NOTHING
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM erp.entity_type_registry
    WHERE code = 'MASTER_DATA_IMPORT'
  `);
};
