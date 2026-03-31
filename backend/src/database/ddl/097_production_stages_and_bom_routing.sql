SET search_path = erp;

-- ============================================================================
-- 097_production_stages_and_bom_routing.sql
-- ============================================================================
-- Purpose:
--   1) Introduce a Production Stage master mapped to production departments.
--   2) Add BOM routing rows (stage sequence per BOM).
--   3) Allow stage-level WIP wiring in production/DCV voucher extensions.
--
-- Notes:
--   - WIP pool remains keyed by dept_id for compatibility.
--   - stage_id acts as business identity; department is resolved from stage.
-- ============================================================================

CREATE TABLE IF NOT EXISTS erp.production_stages (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL UNIQUE,
  name_ur     text,
  dept_id     bigint NOT NULL REFERENCES erp.departments(id) ON DELETE RESTRICT,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  bigint REFERENCES erp.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  bigint REFERENCES erp.users(id),
  updated_at  timestamptz,
  CHECK (code = upper(trim(code)))
);

CREATE INDEX IF NOT EXISTS idx_production_stages_dept_id
  ON erp.production_stages(dept_id);

CREATE TABLE IF NOT EXISTS erp.bom_stage_routing (
  id           bigserial PRIMARY KEY,
  bom_id        bigint NOT NULL REFERENCES erp.bom_header(id) ON DELETE CASCADE,
  stage_id      bigint NOT NULL REFERENCES erp.production_stages(id) ON DELETE RESTRICT,
  sequence_no   int NOT NULL CHECK (sequence_no > 0),
  is_required   boolean NOT NULL DEFAULT true,
  enforce_sequence boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bom_id, stage_id),
  UNIQUE (bom_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS idx_bom_stage_routing_bom_seq
  ON erp.bom_stage_routing(bom_id, sequence_no);

ALTER TABLE IF EXISTS erp.dcv_header
  ADD COLUMN IF NOT EXISTS stage_id bigint REFERENCES erp.production_stages(id) ON DELETE RESTRICT;

ALTER TABLE IF EXISTS erp.production_line
  ADD COLUMN IF NOT EXISTS stage_id bigint REFERENCES erp.production_stages(id) ON DELETE RESTRICT;

ALTER TABLE IF EXISTS erp.abnormal_loss_line
  ADD COLUMN IF NOT EXISTS stage_id bigint REFERENCES erp.production_stages(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_production_line_stage_id
  ON erp.production_line(stage_id);

CREATE INDEX IF NOT EXISTS idx_dcv_header_stage_id
  ON erp.dcv_header(stage_id);

CREATE INDEX IF NOT EXISTS idx_abnormal_loss_line_stage_id
  ON erp.abnormal_loss_line(stage_id);
