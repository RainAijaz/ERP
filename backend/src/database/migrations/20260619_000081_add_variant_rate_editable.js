exports.up = async (knex) => {
  await knex.raw(`
    ALTER TABLE erp.variants
    ADD COLUMN IF NOT EXISTS rate_editable boolean NOT NULL DEFAULT false
  `);
};

exports.down = async (knex) => {
  await knex.raw(`
    ALTER TABLE erp.variants
    DROP COLUMN IF EXISTS rate_editable
  `);
};
