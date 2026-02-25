const CONTROL_ACCOUNT_DEFS = [
  {
    groupCode: "accounts_receivable_control",
    accountCode: "gl_ar_control",
    accountName: "GL AR Control",
  },
  {
    groupCode: "accounts_payable_control",
    accountCode: "gl_ap_control",
    accountName: "GL AP Control",
  },
  {
    groupCode: "wages_payable",
    accountCode: "gl_wages_payable_control",
    accountName: "GL Wages Payable Control",
  },
  {
    groupCode: "salaries_payable",
    accountCode: "gl_salaries_payable_control",
    accountName: "GL Salaries Payable Control",
  },
];

exports.up = async function up(knex) {
  const groups = await knex("erp.account_groups")
    .select("id", "code")
    .whereIn(
      "code",
      CONTROL_ACCOUNT_DEFS.map((row) => row.groupCode),
    );
  const groupIdByCode = new Map(groups.map((row) => [String(row.code || "").trim(), Number(row.id)]));

  for (const def of CONTROL_ACCOUNT_DEFS) {
    const subgroupId = Number(groupIdByCode.get(def.groupCode) || 0);
    if (!Number.isInteger(subgroupId) || subgroupId <= 0) {
      // Skip if target group does not exist in this database yet.
      // GL posting will continue to raise explicit setup errors in that case.
      // eslint-disable-next-line no-continue
      continue;
    }

    await knex.raw(
      `
      INSERT INTO erp.accounts (code, name, subgroup_id, is_active, lock_posting)
      VALUES (?, ?, ?, true, false)
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        subgroup_id = EXCLUDED.subgroup_id,
        is_active = true
      `,
      [def.accountCode, def.accountName, subgroupId],
    );
  }

  await knex.raw(`
    INSERT INTO erp.account_branch (account_id, branch_id)
    SELECT a.id, b.id
    FROM erp.accounts a
    CROSS JOIN erp.branches b
    WHERE a.code IN ('gl_ar_control', 'gl_ap_control', 'gl_wages_payable_control', 'gl_salaries_payable_control')
    ON CONFLICT (account_id, branch_id) DO NOTHING
  `);
};

exports.down = async function down() {
  // Data seed migration; intentionally no-op to avoid removing live control accounts.
};

