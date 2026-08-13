// Per-voucher negative-stock approval control.
//
// The "Neg. Stock" column on Approval Settings already existed but only three voucher
// services read it. Now that every stock voucher honours it, seed a default so the
// control is on out of the box, and correct the returnables flags that went stale when
// RDV/RRV started moving raw material.

const RETURNABLE_CODES = ["RDV", "RRV"];

exports.up = async function up(knex) {
  // RDV/RRV were seeded before returnable raw-material lending shipped. They move stock
  // between ON_HAND and WITH_THIRD_PARTY, so affects_stock has been wrong ever since,
  // and the settings page uses that flag to decide whether to offer the checkbox.
  await knex.raw(
    `
    UPDATE erp.voucher_type
    SET affects_stock = true
    WHERE code = ANY(?)
  `,
    [RETURNABLE_CODES],
  );

  // Default the control ON for every stock voucher that does not already carry a row.
  // ON CONFLICT DO NOTHING so an explicit choice already made on the settings page wins.
  //
  // Restricted to voucher types that have a VOUCHER permission scope, i.e. the ones the
  // settings page actually renders. Saving that page deletes and reinserts every
  // VOUCHER_TYPE policy row, so seeding a type it cannot draw (the DCV-generated
  // PROD_SFG) would plant a row that silently disappears on the first save.
  await knex.raw(`
    INSERT INTO erp.approval_policy (entity_type, entity_key, action, requires_approval)
    SELECT 'VOUCHER_TYPE', vt.code, 'negative_stock', true
    FROM erp.voucher_type vt
    WHERE vt.affects_stock = true
      AND EXISTS (
        SELECT 1
        FROM erp.permission_scope_registry psr
        WHERE psr.scope_type = 'VOUCHER'
          AND psr.scope_key = vt.code
      )
    ON CONFLICT (entity_type, entity_key, action) DO NOTHING
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM erp.approval_policy
    WHERE entity_type = 'VOUCHER_TYPE'
      AND action = 'negative_stock'
  `);

  await knex.raw(
    `
    UPDATE erp.voucher_type
    SET affects_stock = false
    WHERE code = ANY(?)
  `,
    [RETURNABLE_CODES],
  );
};
