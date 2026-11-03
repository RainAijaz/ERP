exports.up = async (knex) => {
  await knex('erp.permission_scope_registry').insert({ scope_type: 'REPORT', scope_key: 'stock_count_details',
    description: 'Stock Count / Adjustment Details Report', module_group: 'Inventory' })
    .onConflict(['scope_type', 'scope_key']).ignore();
};

exports.down = async (knex) => {
  await knex('erp.permission_scope_registry').where({ scope_type: 'REPORT', scope_key: 'stock_count_details' }).del();
};
