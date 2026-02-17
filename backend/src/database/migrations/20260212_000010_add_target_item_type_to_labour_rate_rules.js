exports.up = async function up(knex) {
  await knex.schema.withSchema("erp").alterTable("labour_rate_rules", (table) => {
    table.text("article_type").nullable();
  });

  await knex.raw(`
    ALTER TABLE erp.labour_rate_rules
    DROP CONSTRAINT IF EXISTS labour_rate_rules_article_type_chk
  `);

  await knex.raw(`
    ALTER TABLE erp.labour_rate_rules
    ADD CONSTRAINT labour_rate_rules_article_type_chk
    CHECK (article_type IS NULL OR article_type IN ('FG','SFG','BOTH'))
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.labour_rate_rules
    DROP CONSTRAINT IF EXISTS labour_rate_rules_article_type_chk
  `);

  await knex.schema.withSchema("erp").alterTable("labour_rate_rules", (table) => {
    table.dropColumn("article_type");
  });
};

