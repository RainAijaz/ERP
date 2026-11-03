exports.up = async (knex) => {
  await knex.raw(`
    CREATE TABLE erp.worker_salary_reviews (
      id bigserial PRIMARY KEY,
      employee_id bigint REFERENCES erp.employees(id),
      labour_id bigint REFERENCES erp.labours(id),
      branch_scope text NOT NULL,
      branch_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      checked_through date NOT NULL,
      report_end date NOT NULL,
      source_fingerprint text NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
      checked_by bigint NOT NULL REFERENCES erp.users(id),
      requested_by bigint NOT NULL REFERENCES erp.users(id),
      checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      approval_request_id bigint REFERENCES erp.approval_request(id),
      CONSTRAINT worker_salary_review_entity CHECK (num_nonnulls(employee_id, labour_id) = 1),
      CONSTRAINT worker_salary_review_dates CHECK (checked_through >= DATE '1900-01-01' AND checked_through <= report_end),
      CONSTRAINT worker_salary_review_branches CHECK (jsonb_typeof(branch_ids) = 'array')
    );
    CREATE INDEX worker_salary_reviews_employee_latest ON erp.worker_salary_reviews(employee_id, branch_scope, id DESC) WHERE employee_id IS NOT NULL;
    CREATE INDEX worker_salary_reviews_labour_latest ON erp.worker_salary_reviews(labour_id, branch_scope, id DESC) WHERE labour_id IS NOT NULL;
  `);
};

exports.down = async (knex) => {
  if (await knex('erp.worker_salary_reviews').first('id')) throw new Error('Cannot remove salary reviews while review history exists.');
  await knex.schema.withSchema('erp').dropTable('worker_salary_reviews');
};
