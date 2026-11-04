-- Additive commission batch receipts. Product scope columns are in 020_master_data.sql.
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
