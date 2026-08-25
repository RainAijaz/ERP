// Adding a batch of SKUs used to queue one approval request per variant, so a
// 40-variant article buried the approvals page. The create path now queues the
// whole submission as a single SKU_BULK_CREATE request, and approval_request
// .entity_type is a FK to entity_type_registry -- without this row every batched
// create would fail to insert.
exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO erp.entity_type_registry (code, name, description)
    VALUES ('SKU_BULK_CREATE', 'SKU Bulk Create', 'All SKU variants of one Add-SKUs submission queued for approval as one request')
    ON CONFLICT (code) DO NOTHING
  `);
};

exports.down = async function down(knex) {
  // Leaves any request rows referencing the code untouched: the FK is ON DELETE
  // RESTRICT, so the delete fails loudly rather than orphaning approvals.
  await knex.raw(`
    DELETE FROM erp.entity_type_registry
    WHERE code = 'SKU_BULK_CREATE'
  `);
};
