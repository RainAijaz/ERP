/**
 * Rename the WhatsApp notifications SCREEN scope label.
 *
 * The permissions matrix prefers permission_scope_registry.description over the
 * locale key for leaf rows, so the screen kept reading "WhatsApp Notification
 * Failures" there even after the UI label was renamed.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    UPDATE erp.permission_scope_registry
       SET description = 'WhatsApp Notification'
     WHERE scope_type = 'SCREEN'
       AND scope_key = 'administration.whatsapp_notifications'
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    UPDATE erp.permission_scope_registry
       SET description = 'WhatsApp Notification Failures'
     WHERE scope_type = 'SCREEN'
       AND scope_key = 'administration.whatsapp_notifications'
  `);
};
