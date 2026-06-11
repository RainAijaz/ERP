exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE erp.commission_ledger (
      id             bigserial    PRIMARY KEY,
      voucher_id     bigint       NOT NULL REFERENCES erp.voucher_header(id) ON DELETE CASCADE,
      employee_id    bigint       NOT NULL REFERENCES erp.employees(id)      ON DELETE RESTRICT,
      commission_type text        NOT NULL
        CHECK (commission_type IN ('SALESMAN_SALE', 'BRANCH_SALE', 'TRANSFER', 'PARTY')),
      total_amount   numeric(18,2) NOT NULL DEFAULT 0,
      lines_detail   jsonb         NOT NULL DEFAULT '[]',
      created_at     timestamptz   NOT NULL DEFAULT now(),
      UNIQUE (voucher_id, employee_id, commission_type)
    );
    CREATE INDEX idx_commission_ledger_employee ON erp.commission_ledger (employee_id);
    CREATE INDEX idx_commission_ledger_voucher  ON erp.commission_ledger (voucher_id);
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS erp.commission_ledger`);
};
