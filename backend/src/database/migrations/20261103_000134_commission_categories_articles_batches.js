'use strict';

exports.up = async knex => {
  await knex.raw(`
    ALTER TABLE erp.employee_commission_rules
      ADD COLUMN IF NOT EXISTS article_id bigint REFERENCES erp.items(id) ON DELETE RESTRICT,
      ADD COLUMN IF NOT EXISTS category_id bigint REFERENCES erp.product_types(id) ON DELETE RESTRICT;
    ALTER TABLE erp.employee_commission_rules DROP CONSTRAINT IF EXISTS employee_commission_rules_apply_on_check;
    ALTER TABLE erp.employee_commission_rules ADD CONSTRAINT employee_commission_rules_apply_on_check
      CHECK (apply_on IN ('SKU','ARTICLE','SUBGROUP','GROUP','CATEGORY','ALL'));
    ALTER TABLE erp.employee_commission_rules DROP CONSTRAINT IF EXISTS commission_new_scope_target;
    ALTER TABLE erp.employee_commission_rules ADD CONSTRAINT commission_new_scope_target CHECK (
      (apply_on='ARTICLE' AND article_id IS NOT NULL AND num_nonnulls(sku_id,subgroup_id,group_id,category_id)=0) OR
      (apply_on='CATEGORY' AND category_id IS NOT NULL AND num_nonnulls(sku_id,subgroup_id,group_id,article_id)=0) OR
      (apply_on NOT IN ('ARTICLE','CATEGORY') AND article_id IS NULL AND category_id IS NULL));
    CREATE INDEX IF NOT EXISTS idx_commission_article_scope ON erp.employee_commission_rules(employee_id,commission_type,article_id) WHERE article_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_commission_category_scope ON erp.employee_commission_rules(employee_id,commission_type,category_id) WHERE category_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_items_commission_category ON erp.items(product_type_id,item_type,id);
    CREATE TABLE IF NOT EXISTS erp.commission_batches (
      id bigserial PRIMARY KEY, requested_by bigint NOT NULL REFERENCES erp.users(id),
      employee_id bigint NOT NULL REFERENCES erp.employees(id), idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 100),
      payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
      preview_hash text NOT NULL CHECK(preview_hash ~ '^[a-f0-9]{64}$'),
      payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
      status text NOT NULL CHECK(status IN ('PENDING','APPLIED')),
      approval_request_id bigint REFERENCES erp.approval_request(id), result jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz,
      UNIQUE(requested_by,idempotency_key)
    );
  `);
};

exports.down = async knex => {
  if (await knex('erp.commission_batches').first('id') || await knex('erp.employee_commission_rules').where(q=>q.whereIn('apply_on',['CATEGORY','ARTICLE']).orWhereRaw("jsonb_exists(eligibility,'excluded_article_ids') OR jsonb_exists(eligibility,'excluded_category_ids')")).first('id')) {
    throw new Error('Cannot remove commission expansion while batch or category/article history exists.');
  }
  await knex.raw(`DROP TABLE erp.commission_batches;
    DROP INDEX erp.idx_commission_article_scope; DROP INDEX erp.idx_commission_category_scope;
    DROP INDEX IF EXISTS erp.idx_items_commission_category;
    ALTER TABLE erp.employee_commission_rules DROP CONSTRAINT commission_new_scope_target;
    ALTER TABLE erp.employee_commission_rules DROP CONSTRAINT employee_commission_rules_apply_on_check;
    ALTER TABLE erp.employee_commission_rules ADD CONSTRAINT employee_commission_rules_apply_on_check CHECK(apply_on IN ('SKU','SUBGROUP','GROUP','ALL'));
    ALTER TABLE erp.employee_commission_rules DROP COLUMN article_id, DROP COLUMN category_id;`);
};
