// Returnable dispatch lends material to whoever physically takes it — a repair
// vendor, a sister concern, a neighbouring factory, an employee. Only SUPPLIER
// parties could be picked, so non-suppliers had to be filed as fake suppliers,
// which then polluted every purchase dropdown and supplier report.
//
// 'OTHER' is a party that is neither bought from nor sold to. Purchase and sales
// code already filters on IN ('SUPPLIER','BOTH') / IN ('CUSTOMER','BOTH'), so the
// new value is invisible to them without any further change.
//
// ALTER TYPE ... ADD VALUE is run with the migration transaction disabled: on some
// PostgreSQL versions a value added inside a transaction cannot be used until commit.
exports.config = { transaction: false };

exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TYPE erp.party_type ADD VALUE IF NOT EXISTS 'OTHER'
  `);
};

exports.down = async function down() {
  // Intentionally a no-op: PostgreSQL cannot drop an enum value, and rolling it
  // back would require rewriting every column that depends on erp.party_type.
};
