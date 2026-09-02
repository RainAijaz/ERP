// Multi-department DCV: let one Department Completion Voucher record several
// consecutive departments completed on the same day, each worked by a different labour.
//
// Until now a DCV was one department + one labour (erp.dcv_header), so three stages
// finishing the same articles on the same day meant three vouchers with identical
// article rows -- three voucher numbers, three approvals and three report rows for one
// physical event, and a quantity correction meant editing all three.
//
// Treatment: the voucher keeps ONE set of article rows in the UI, and the server writes
// one voucher_line per (article x department), each carrying its own labour rate. The
// per-line department/labour lives here, in erp.dcv_line.
//
// Why a side table rather than voucher_line.labour_id: voucher_line enforces
//   CHECK (num_nonnulls(item_id, sku_id, account_id, party_id, labour_id, employee_id) = 1)
// and a DCV line already fills sku_id, so it may not also fill labour_id. dept_id has no
// home on voucher_line at all. This is exactly why labour_voucher_line and
// abnormal_loss_line exist, and why the labour ledger reaches into dcv_header today.
//
// erp.dcv_header is deliberately left alone and keeps the FIRST department/labour in BOM
// stage order, so every existing single-department query and report stays correct.

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS erp.dcv_line (
      voucher_line_id bigint PRIMARY KEY REFERENCES erp.voucher_line(id) ON DELETE CASCADE,
      dept_id         bigint NOT NULL REFERENCES erp.departments(id) ON DELETE RESTRICT,
      labour_id       bigint NOT NULL REFERENCES erp.labours(id) ON DELETE RESTRICT,
      stage_id        bigint REFERENCES erp.production_stages(id) ON DELETE RESTRICT
    )
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_dcv_line_labour ON erp.dcv_line(labour_id)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_dcv_line_dept ON erp.dcv_line(dept_id)
  `);

  // Backfill one dcv_line row per existing DCV article line, copied from its header.
  //
  // Reporting keeps a COALESCE(dcv_line, dcv_header) fallback regardless, but backfilling
  // means historical vouchers resolve through the same join as new ones instead of relying
  // on that fallback -- one code path to reason about when a labour disputes a payment.
  //
  // labour_id is nullable on dcv_header but NOT NULL here: a DCV line with no labour has
  // no one to pay, so those rows are skipped rather than invented.
  await knex.raw(`
    INSERT INTO erp.dcv_line (voucher_line_id, dept_id, labour_id, stage_id)
    SELECT vl.id, dh.dept_id, dh.labour_id, dh.stage_id
    FROM erp.voucher_line vl
    JOIN erp.voucher_header vh ON vh.id = vl.voucher_header_id
    JOIN erp.dcv_header dh ON dh.voucher_id = vh.id
    WHERE vh.voucher_type_code = 'DCV'
      AND vl.line_kind = 'SKU'
      AND dh.labour_id IS NOT NULL
    ON CONFLICT (voucher_line_id) DO NOTHING
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS erp.dcv_line`);
};
