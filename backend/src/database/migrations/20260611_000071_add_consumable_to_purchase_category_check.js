const TABLES = [
  { table: "purchase_grn_header_ext",     constraint: "purchase_grn_hdr_purchase_category_chk" },
  { table: "purchase_invoice_header_ext", constraint: "purchase_invoice_hdr_purchase_category_chk" },
  { table: "purchase_return_header_ext",  constraint: "purchase_return_hdr_purchase_category_chk" },
];

const NEW_CHECK = "('RAW_MATERIAL','ASSET','CONSUMABLE')";

exports.up = async function up(knex) {
  for (const { table, constraint } of TABLES) {
    const hasTable = await knex.schema.withSchema("erp").hasTable(table);
    if (!hasTable) continue;

    await knex.raw(`
      ALTER TABLE erp.${table}
        DROP CONSTRAINT IF EXISTS ${constraint}
    `);

    await knex.raw(`
      ALTER TABLE erp.${table}
        ADD CONSTRAINT ${constraint}
        CHECK (purchase_category IN ${NEW_CHECK})
    `);
  }
};

exports.down = async function down(knex) {
  const OLD_CHECK = "('RAW_MATERIAL','ASSET')";
  for (const { table, constraint } of TABLES) {
    const hasTable = await knex.schema.withSchema("erp").hasTable(table);
    if (!hasTable) continue;

    await knex.raw(`
      ALTER TABLE erp.${table}
        DROP CONSTRAINT IF EXISTS ${constraint}
    `);

    await knex.raw(`
      ALTER TABLE erp.${table}
        ADD CONSTRAINT ${constraint}
        CHECK (purchase_category IN ${OLD_CHECK})
    `);
  }
};
