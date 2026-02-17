const knex = require("../db/knex");

const run = async () => {
  const dryRun = process.env.DRY_RUN === "1";

  await knex.transaction(async (trx) => {
    const countRow = await trx("erp.labour_rate_rules")
      .count("* as count")
      .first();
    const total = Number(countRow?.count || 0);

    if (dryRun) {
      console.log(`[clear-labour-rates] DRY_RUN=1, rows that would be deleted: ${total}`);
      return;
    }

    await trx("erp.labour_rate_rules").del();
    console.log(`[clear-labour-rates] deleted rows: ${total}`);
  });
};

run()
  .then(async () => {
    await knex.destroy();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[clear-labour-rates] failed:", err);
    await knex.destroy();
    process.exit(1);
  });
