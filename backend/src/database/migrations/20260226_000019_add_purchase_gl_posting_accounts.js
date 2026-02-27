const SYSTEM_PURCHASE_ACCOUNTS = [
  {
    groupCode: "accounts_payable_control",
    accountCode: "gl_ap_control",
    accountName: "GL AP Control",
  },
  {
    groupCode: "inventory_rm",
    accountCode: "gl_inventory_rm_control",
    accountName: "GL Inventory RM Control",
  },
];

exports.up = async function up(knex) {
  await knex("erp.voucher_type")
    .where({ code: "PI" })
    .update({ affects_gl: true });
  await knex("erp.voucher_type")
    .where({ code: "PR" })
    .update({ affects_gl: true });
  await knex("erp.voucher_type")
    .where({ code: "GRN" })
    .update({ affects_gl: false });

  const groupRows = await knex("erp.account_groups")
    .select("id", "code")
    .whereIn(
      "code",
      SYSTEM_PURCHASE_ACCOUNTS.map((row) => row.groupCode),
    );
  const groupIdByCode = new Map(groupRows.map((row) => [String(row.code || "").trim(), Number(row.id)]));

  for (const row of SYSTEM_PURCHASE_ACCOUNTS) {
    const subgroupId = Number(groupIdByCode.get(row.groupCode) || 0);
    if (!Number.isInteger(subgroupId) || subgroupId <= 0) {
      // eslint-disable-next-line no-continue
      continue;
    }

    await knex.raw(
      `
      INSERT INTO erp.accounts (code, name, subgroup_id, is_active, lock_posting)
      VALUES (?, ?, ?, true, true)
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        subgroup_id = EXCLUDED.subgroup_id,
        is_active = true,
        lock_posting = true
      `,
      [row.accountCode, row.accountName, subgroupId],
    );
  }

  await knex.raw(`
    INSERT INTO erp.account_branch (account_id, branch_id)
    SELECT a.id, b.id
    FROM erp.accounts a
    CROSS JOIN erp.branches b
    WHERE a.code IN ('gl_ap_control', 'gl_inventory_rm_control')
    ON CONFLICT (account_id, branch_id) DO NOTHING
  `);
};

exports.down = async function down() {
  // Seed-style migration: keep accounts in place to avoid breaking posted vouchers.
};

