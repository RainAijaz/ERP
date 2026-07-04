// One-time cleanup: erp.grn_in_header rows whose voucher was REJECTED
// (deleted) never got their against_stn_out_id slot released before the
// fix in stock-transfer-voucher-service.js. Deletes those orphaned rows so
// new STI vouchers can be raised against the same STN_OUT again.
const knex = require("../db/knex");

const run = async () => {
  const dryRun = process.env.DRY_RUN === "1";

  await knex.transaction(async (trx) => {
    const stuck = await trx("erp.grn_in_header as gih")
      .join("erp.voucher_header as vh", "vh.id", "gih.voucher_id")
      .where("vh.status", "REJECTED")
      .select(
        "gih.voucher_id",
        "gih.against_stn_out_id",
        "vh.voucher_no",
        "vh.status",
      );

    if (!stuck.length) {
      console.log("[cleanup-stuck-grn-in-headers] no stuck rows found");
      return;
    }

    console.log(
      `[cleanup-stuck-grn-in-headers] found ${stuck.length} stuck row(s):`,
    );
    for (const row of stuck) {
      console.log(
        `  voucher_id=${row.voucher_id} voucher_no=${row.voucher_no} against_stn_out_id=${row.against_stn_out_id}`,
      );
    }

    if (dryRun) {
      console.log("[cleanup-stuck-grn-in-headers] DRY_RUN=1, not deleting");
      return;
    }

    const voucherIds = stuck.map((row) => row.voucher_id);
    const deleted = await trx("erp.grn_in_header")
      .whereIn("voucher_id", voucherIds)
      .del();
    console.log(`[cleanup-stuck-grn-in-headers] deleted ${deleted} row(s)`);
  });
};

run()
  .then(async () => {
    await knex.destroy();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[cleanup-stuck-grn-in-headers] failed:", err);
    await knex.destroy();
    process.exit(1);
  });
