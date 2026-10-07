// Classify legacy SKU rows created by a group/subgroup bulk save without
// changing their amount, dates, status, or approval history. The marker keeps
// inheritance stable even if the source rule is edited later.
exports.up = async (knex) => {
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      ADD COLUMN IF NOT EXISTS inherited_sku_copy boolean;

    UPDATE erp.employee_commission_rules AS child
    SET inherited_sku_copy = (
      child.apply_on = 'SKU'
      AND source.apply_on IN ('GROUP', 'SUBGROUP')
      AND child.value = source.value
      AND COALESCE(child.rate_type, 'PER_PAIR') = COALESCE(source.rate_type, 'PER_PAIR')
      AND child.commission_basis = source.commission_basis
      AND child.reverse_on_returns = source.reverse_on_returns
    )
    FROM erp.employee_commission_rules AS source
    WHERE child.source_rule_id = source.id
      AND child.inherited_sku_copy IS NULL;
  `);
};

exports.down = async (knex) => {
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      DROP COLUMN IF EXISTS inherited_sku_copy;
  `);
};
