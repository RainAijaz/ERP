exports.up = async function up(knex) {
  await knex.raw(`
    ALTER TABLE erp.grades
    ADD COLUMN IF NOT EXISTS grade_rank integer NOT NULL DEFAULT 1
  `);

  await knex.raw(`
    ALTER TABLE erp.grades
    DROP CONSTRAINT IF EXISTS grades_grade_rank_positive_chk
  `);

  await knex.raw(`
    ALTER TABLE erp.grades
    ADD CONSTRAINT grades_grade_rank_positive_chk CHECK (grade_rank >= 1)
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    ALTER TABLE erp.grades
    DROP CONSTRAINT IF EXISTS grades_grade_rank_positive_chk
  `);

  await knex.raw(`
    ALTER TABLE erp.grades
    DROP COLUMN IF EXISTS grade_rank
  `);
};

