exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO erp.account_posting_classes (code, name, is_system, is_active)
    VALUES ('cash', 'Cash', true, true)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      is_system = EXCLUDED.is_system,
      is_active = EXCLUDED.is_active
  `);
};

exports.down = async function down(knex) {
  await knex("erp.account_posting_classes")
    .whereRaw("lower(code) = 'cash'")
    .whereNotExists(function whereAccountUsesClass() {
      this.select(1).from("erp.accounts as a").whereRaw("a.posting_class_id = erp.account_posting_classes.id");
    })
    .del();
};

