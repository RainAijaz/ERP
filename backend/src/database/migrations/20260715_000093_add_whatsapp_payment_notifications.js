exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.whatsapp_notification_log (
      id                 bigserial PRIMARY KEY,
      voucher_header_id  bigint,
      voucher_type_code  text,
      voucher_no         integer,
      branch_id          bigint,
      recipient_kind     text NOT NULL,
      recipient_id       bigint,
      recipient_name     text,
      phone_raw          text,
      phone_normalized   text,
      amount             numeric(18, 2),
      status             text NOT NULL,
      failure_reason     text,
      resolved_at        timestamptz,
      created_at         timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT whatsapp_notification_log_status_chk
        CHECK (status IN ('SENT', 'FAILED')),
      CONSTRAINT whatsapp_notification_log_kind_chk
        CHECK (recipient_kind IN ('SUPPLIER', 'LABOUR', 'EMPLOYEE'))
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS whatsapp_notification_log_status_created_idx
      ON erp.whatsapp_notification_log (status, created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS whatsapp_notification_log_branch_idx
      ON erp.whatsapp_notification_log (branch_id)
  `);

  await knex.raw(`
    INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
    VALUES ('SCREEN', 'administration.whatsapp_notifications', 'WhatsApp Notification Failures', 'Administration')
    ON CONFLICT (scope_type, scope_key) DO NOTHING
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS erp.whatsapp_notification_log`);
  await knex.raw(`
    DELETE FROM erp.permission_scope_registry
    WHERE scope_type = 'SCREEN' AND scope_key = 'administration.whatsapp_notifications'
  `);
};
