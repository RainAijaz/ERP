/**
 * Rename the "Product Types" screen to "Product Categories" (display only).
 *
 * The route (/master-data/basic-info/product-types), the permission scope key
 * and the erp.product_types table are deliberately left alone — only the
 * human-readable labels change. Both registries below are read straight from
 * the database (the permissions matrix prefers permission_scope_registry
 * .description over the locale key, and the Activity Log entity filter lists
 * entity_type_registry.name), so the locale change alone is not enough.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    UPDATE erp.permission_scope_registry
       SET description = 'Product Categories',
           description_ur = 'مصنوعات کے زمرے'
     WHERE scope_type = 'SCREEN'
       AND scope_key = 'master_data.basic_info.product_types'
  `);

  await knex.raw(`
    UPDATE erp.entity_type_registry
       SET name = 'Product Category',
           name_ur = 'پروڈکٹ کا زمرہ',
           description = 'Basic info: product categories'
     WHERE code = 'PRODUCT_TYPE'
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    UPDATE erp.permission_scope_registry
       SET description = 'Product Types',
           description_ur = 'مصنوعات کی اقسام'
     WHERE scope_type = 'SCREEN'
       AND scope_key = 'master_data.basic_info.product_types'
  `);

  await knex.raw(`
    UPDATE erp.entity_type_registry
       SET name = 'Product Type',
           name_ur = 'پروڈکٹ کی قسم',
           description = 'Basic info: product types'
     WHERE code = 'PRODUCT_TYPE'
  `);
};
