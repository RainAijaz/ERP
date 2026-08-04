// Production commission: employees can now earn on manufactured output, not just
// on sales and transfers. FG and SFG are separate types on purpose — one shared
// "PRODUCTION" type would pay twice on the same shoe (once when the SFG is
// created, again when the FG is assembled from it), and keeping them apart lets
// either side be configured, reported, or switched off on its own.
//
// Both are earned at the point where WIP becomes stock (the final required stage
// in the BOM routing), which is where production-voucher-service posts stock in.

const COMMISSION_TYPES = [
  "SALESMAN_SALE",
  "BRANCH_SALE",
  "TRANSFER",
  "PARTY",
  "PRODUCTION_FG",
  "PRODUCTION_SFG",
];

const LEGACY_COMMISSION_TYPES = [
  "SALESMAN_SALE",
  "BRANCH_SALE",
  "TRANSFER",
  "PARTY",
];

const toSqlList = (values) => values.map((value) => `'${value}'`).join(", ");

const setCheck = async (knex, table, constraint, values) => {
  await knex.raw(`
    ALTER TABLE erp.${table}
    DROP CONSTRAINT IF EXISTS ${constraint}
  `);
  await knex.raw(`
    ALTER TABLE erp.${table}
    ADD CONSTRAINT ${constraint}
    CHECK (commission_type IN (${toSqlList(values)}))
  `);
};

exports.up = async function up(knex) {
  await setCheck(
    knex,
    "employee_commission_rules",
    "employee_commission_rules_commission_type_check",
    COMMISSION_TYPES,
  );
  await setCheck(
    knex,
    "commission_ledger",
    "commission_ledger_commission_type_check",
    COMMISSION_TYPES,
  );
};

exports.down = async function down(knex) {
  // Refuse to narrow the constraint back while rows would violate it — dropping
  // production commission rows silently would lose real money owed to someone.
  const { rows } = await knex.raw(`
    SELECT 'employee_commission_rules' AS src FROM erp.employee_commission_rules
    WHERE commission_type IN ('PRODUCTION_FG', 'PRODUCTION_SFG')
    UNION ALL
    SELECT 'commission_ledger' AS src FROM erp.commission_ledger
    WHERE commission_type IN ('PRODUCTION_FG', 'PRODUCTION_SFG')
    LIMIT 1
  `);
  if (rows.length) {
    throw new Error(
      "Cannot roll back: PRODUCTION_FG/PRODUCTION_SFG rows exist in employee_commission_rules or commission_ledger. Remove or reclassify them first.",
    );
  }

  await setCheck(
    knex,
    "employee_commission_rules",
    "employee_commission_rules_commission_type_check",
    LEGACY_COMMISSION_TYPES,
  );
  await setCheck(
    knex,
    "commission_ledger",
    "commission_ledger_commission_type_check",
    LEGACY_COMMISSION_TYPES,
  );
};
