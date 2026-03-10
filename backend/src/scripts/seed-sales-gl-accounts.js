const knex = require("../db/knex");

const SALES_REVENUE_GROUP_CODE = "sales_revenue";
const ADVANCES_GROUP_CODE = "advances_from_customers";

const SALES_REVENUE_ACCOUNT = {
  code: "gl_sales_revenue",
  name: "GL Sales Revenue",
};

const ADVANCES_ACCOUNT = {
  code: "gl_advances_from_customers",
  name: "GL Advances from Customers",
};

const ensureGroup = async (trx, groupCode) => {
  const row = await trx("erp.account_groups")
    .select("id", "code")
    .whereRaw("lower(code) = lower(?)", [groupCode])
    .first();
  if (!row) throw new Error(`Missing account group '${groupCode}'`);
  return Number(row.id);
};

const ensureAccount = async ({ trx, account, subgroupId }) => {
  const existing = await trx("erp.accounts")
    .select("id", "subgroup_id")
    .whereRaw("lower(code) = lower(?)", [account.code])
    .first();

  if (!existing) {
    const [created] = await trx("erp.accounts")
      .insert({
        code: account.code,
        name: account.name,
        subgroup_id: subgroupId,
        is_active: true,
        lock_posting: false,
      })
      .returning(["id"]);
    return Number(created.id);
  }

  if (Number(existing.subgroup_id) !== Number(subgroupId)) {
    throw new Error(
      `Account '${account.code}' exists in different subgroup (id=${existing.subgroup_id})`,
    );
  }

  await trx("erp.accounts")
    .where({ id: Number(existing.id) })
    .update({
      is_active: true,
      lock_posting: false,
      updated_at: trx.fn.now(),
    });

  return Number(existing.id);
};

const mapAccountToActiveBranches = async ({ trx, accountId }) => {
  const branches = await trx("erp.branches")
    .select("id")
    .where({ is_active: true });
  if (!branches.length) return 0;

  const rows = branches.map((branch) => ({
    account_id: Number(accountId),
    branch_id: Number(branch.id),
  }));

  await trx("erp.account_branch")
    .insert(rows)
    .onConflict(["account_id", "branch_id"])
    .ignore();

  return rows.length;
};

const run = async () => {
  const trx = await knex.transaction();
  try {
    const salesRevenueGroupId = await ensureGroup(
      trx,
      SALES_REVENUE_GROUP_CODE,
    );
    const advancesGroupId = await ensureGroup(trx, ADVANCES_GROUP_CODE);

    const salesRevenueAccountId = await ensureAccount({
      trx,
      account: SALES_REVENUE_ACCOUNT,
      subgroupId: salesRevenueGroupId,
    });

    const advancesAccountId = await ensureAccount({
      trx,
      account: ADVANCES_ACCOUNT,
      subgroupId: advancesGroupId,
    });

    const salesRevenueMapped = await mapAccountToActiveBranches({
      trx,
      accountId: salesRevenueAccountId,
    });

    const advancesMapped = await mapAccountToActiveBranches({
      trx,
      accountId: advancesAccountId,
    });

    await trx.commit();

    console.log(
      JSON.stringify(
        {
          ok: true,
          salesRevenueAccountId,
          advancesAccountId,
          salesRevenueMapped,
          advancesMapped,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    await trx.rollback();
    console.error("seed-sales-gl-accounts failed:", err.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
};

run();
