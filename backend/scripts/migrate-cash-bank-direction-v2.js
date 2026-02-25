const knex = require("../src/db/knex");
const { syncVoucherGlPosting } = require("../src/services/financial/gl-posting-service");

const TARGET_VOUCHER_TYPES = ["CASH_VOUCHER", "BANK_VOUCHER"];

const toInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) ? n : 0;
};

const getImpactedVoucherIdsTx = async (trx) => {
  const rows = await trx("erp.voucher_line as vl")
    .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
    .distinct("vl.voucher_header_id as id")
    .whereIn("vh.voucher_type_code", TARGET_VOUCHER_TYPES)
    .whereRaw("COALESCE(NULLIF(vl.meta->>'direction_version', '')::int, 1) < 2");
  return rows.map((row) => toInt(row.id)).filter((id) => id > 0);
};

const tryResolveLegacyBankHeaderAccountTx = async (trx, voucherId) => {
  const candidates = await trx("erp.voucher_line as vl")
    .join("erp.accounts as a", "a.id", "vl.account_id")
    .join("erp.account_posting_classes as apc", "apc.id", "a.posting_class_id")
    .distinct("a.id")
    .where("vl.voucher_header_id", voucherId)
    .andWhere("vl.line_kind", "ACCOUNT")
    .andWhere("a.is_active", true)
    .andWhere("apc.is_active", true)
    .andWhereRaw("upper(apc.code) = 'BANK'");

  const ids = candidates.map((row) => toInt(row.id)).filter((id) => id > 0);
  if (ids.length !== 1) return null;
  const headerAccountId = ids[0];
  await trx("erp.voucher_header").where({ id: voucherId }).update({ header_account_id: headerAccountId });
  return headerAccountId;
};

const migrateVoucherLinesTx = async (trx, voucherId) => {
  await trx("erp.voucher_line as vl")
    .where("vl.voucher_header_id", voucherId)
    .andWhereRaw("COALESCE(NULLIF(vl.meta->>'direction_version', '')::int, 1) < 2")
    .update({
      meta: trx.raw(
        `
          jsonb_set(
            jsonb_set(
              jsonb_set(
                COALESCE(vl.meta, '{}'::jsonb),
                '{debit}',
                to_jsonb(COALESCE(NULLIF(vl.meta->>'credit', '')::numeric, 0)),
                true
              ),
              '{credit}',
              to_jsonb(COALESCE(NULLIF(vl.meta->>'debit', '')::numeric, 0)),
              true
            ),
            '{direction_version}',
            to_jsonb(2),
            true
          )
        `,
      ),
    });
};

const run = async () => {
  const dryRun = String(process.env.DRY_RUN || "").trim() === "1";
  const resyncAll = String(process.env.RESYNC_GL_ALL || "").trim() === "1";
  const impactedVoucherIds = await knex.transaction(async (trx) => {
    const ids = await getImpactedVoucherIdsTx(trx);
    if (dryRun || !ids.length) return ids;

    for (const voucherId of ids) {
      await migrateVoucherLinesTx(trx, voucherId);
    }
    return ids;
  });

  if (!impactedVoucherIds.length && !resyncAll) {
    console.log("No vouchers require migration.");
    return;
  }

  if (dryRun) {
    console.log(`Dry run: ${impactedVoucherIds.length} voucher(s) need migration.`);
    console.log(`Sample ids: ${impactedVoucherIds.slice(0, 15).join(", ")}`);
    return;
  }

  let approvedQuery = knex("erp.voucher_header as vh")
    .select("vh.id", "vh.voucher_type_code", "vh.header_account_id")
    .whereIn("vh.voucher_type_code", TARGET_VOUCHER_TYPES)
    .andWhere("vh.status", "APPROVED");
  if (!resyncAll) {
    approvedQuery = approvedQuery.whereIn("vh.id", impactedVoucherIds);
  }
  const approvedRows = await approvedQuery.orderBy("vh.id", "asc");

  let reposted = 0;
  const failures = [];
  for (const row of approvedRows) {
    const voucherId = toInt(row.id);
    if (voucherId <= 0) continue;
    let headerAccountId = toInt(row.header_account_id);
    const voucherTypeCode = String(row.voucher_type_code || "").toUpperCase();

    if (headerAccountId <= 0 && voucherTypeCode === "BANK_VOUCHER") {
      const resolvedId = await knex.transaction((trx) => tryResolveLegacyBankHeaderAccountTx(trx, voucherId));
      headerAccountId = toInt(resolvedId);
    }
    if (headerAccountId <= 0) {
      failures.push(`voucher ${voucherId}: missing header account`);
      continue;
    }
    try {
      await syncVoucherGlPosting({ voucherId });
      reposted += 1;
    } catch (err) {
      failures.push(`voucher ${voucherId}: ${err.message}`);
    }
  }

  console.log(`Migration complete. Updated ${impactedVoucherIds.length} voucher(s); re-posted GL for ${reposted} approved voucher(s).`);
  if (failures.length) {
    console.log(`GL re-post skipped/failed for ${failures.length} voucher(s):`);
    failures.forEach((line) => console.log(`- ${line}`));
  }
};

run()
  .catch((err) => {
    console.error("Error in migrate-cash-bank-direction-v2:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await knex.destroy();
  });
