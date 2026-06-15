const {
  syncVoucherGlPostingTx,
} = require("../../services/financial/gl-posting-service");

// Finds all approved SALES_VOUCHER lines that were linked to a SALES_ORDER line
// with a negative pair_discount, but were saved with pair_discount = 0 due to a bug
// in loadOpenSalesOrderLinesTx (toNonNegativeNumber zeroed out negative discounts).
const AFFECTED_SV_LINES_SQL = `
  SELECT
    svl.id        AS sv_line_id,
    svl.voucher_header_id,
    svl.qty       AS pairs,
    (svl.meta->>'pair_rate')::numeric    AS pair_rate,
    (sol.meta->>'pair_discount')::numeric AS correct_pair_discount
  FROM erp.voucher_line svl
  JOIN erp.voucher_header svh ON svh.id = svl.voucher_header_id
  JOIN erp.voucher_line sol
    ON sol.id = (
      CASE
        WHEN coalesce(svl.meta->>'sales_order_line_id', '') ~ '^[0-9]+$'
        THEN (svl.meta->>'sales_order_line_id')::bigint
        ELSE NULL
      END
    )
  JOIN erp.voucher_header soh ON soh.id = sol.voucher_header_id
  WHERE svh.voucher_type_code = 'SALES_VOUCHER'
    AND svh.status            = 'APPROVED'
    AND svl.line_kind         = 'SKU'
    AND coalesce(svl.meta->>'movement_kind', '') = 'SALE'
    AND soh.voucher_type_code = 'SALES_ORDER'
    AND (sol.meta->>'pair_discount')::numeric < 0
    AND coalesce((svl.meta->>'pair_discount')::numeric, 0) = 0
`;

exports.up = async function up(knex) {
  const { rows: affectedRows } = await knex.raw(AFFECTED_SV_LINES_SQL);
  if (!affectedRows.length) return;

  // 1. Fix voucher_line.amount and the discount fields in meta
  await knex.raw(`
    UPDATE erp.voucher_line svl
    SET
      amount = ROUND(bad.pairs * (bad.pair_rate - bad.correct_pair_discount), 2),
      meta   = svl.meta || jsonb_build_object(
                 'pair_discount', bad.correct_pair_discount,
                 'total_discount', ROUND(bad.pairs * bad.correct_pair_discount, 2),
                 'total_amount',   ROUND(bad.pairs * (bad.pair_rate - bad.correct_pair_discount), 2)
               )
    FROM (${AFFECTED_SV_LINES_SQL}) bad
    WHERE svl.id = bad.sv_line_id
  `);

  // 2. Fix sales_line extension table (mirrors the meta fields in a typed column)
  await knex.raw(`
    UPDATE erp.sales_line sl
    SET
      pair_discount  = bad.correct_pair_discount,
      total_discount = ROUND(bad.pairs * bad.correct_pair_discount, 2),
      total_amount   = ROUND(bad.pairs * (bad.pair_rate - bad.correct_pair_discount), 2)
    FROM (${AFFECTED_SV_LINES_SQL}) bad
    WHERE sl.voucher_line_id = bad.sv_line_id
  `);

  // 3. Re-run GL posting for every affected voucher so ledger amounts match
  const voucherIds = [
    ...new Set(affectedRows.map((r) => Number(r.voucher_header_id))),
  ];
  for (const voucherId of voucherIds) {
    await knex.transaction(async (trx) => {
      await syncVoucherGlPostingTx({ trx, voucherId });
    });
  }
};

exports.down = async function down(_knex) {
  // Data corrections cannot be safely reversed
};
