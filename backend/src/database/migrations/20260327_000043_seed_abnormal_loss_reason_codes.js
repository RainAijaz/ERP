exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO erp.reason_codes (code, name, description, requires_notes, is_active)
    VALUES
      ('RM_DAMAGE', 'RM Damage', 'Raw material damaged before or during processing.', false, true),
      ('RM_CONTAMINATION', 'RM Contamination', 'Raw material rejected due to contamination or spoilage.', true, true),
      ('SFG_QUALITY_REJECT', 'SFG Quality Reject', 'Semi-finished goods rejected by quality checks.', true, true),
      ('FG_QUALITY_REJECT', 'FG Quality Reject', 'Finished goods rejected by quality checks.', true, true),
      ('PROCESS_WASTAGE', 'Process Wastage', 'Normal or abnormal material/process wastage during production.', false, true),
      ('DVC_ABANDONMENT', 'DVC Abandonment', 'Department-completion work-in-progress abandoned.', true, true),
      ('PILFERAGE', 'Pilferage', 'Inventory loss due to theft or pilferage.', true, true),
      ('OTHER_LOSS', 'Other Loss', 'Loss recorded for reasons outside standard categories.', true, true)
    ON CONFLICT (code) DO UPDATE
    SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      requires_notes = EXCLUDED.requires_notes,
      is_active = true;
  `);

  await knex.raw(`
    INSERT INTO erp.reason_code_voucher_type_map (reason_code_id, voucher_type_code)
    SELECT rc.id, 'LOSS'
    FROM erp.reason_codes rc
    WHERE rc.code IN (
      'RM_DAMAGE',
      'RM_CONTAMINATION',
      'SFG_QUALITY_REJECT',
      'FG_QUALITY_REJECT',
      'PROCESS_WASTAGE',
      'DVC_ABANDONMENT',
      'PILFERAGE',
      'OTHER_LOSS'
    )
    ON CONFLICT (reason_code_id, voucher_type_code) DO NOTHING;
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`
    DELETE FROM erp.reason_code_voucher_type_map m
    USING erp.reason_codes rc
    WHERE m.reason_code_id = rc.id
      AND m.voucher_type_code = 'LOSS'
      AND rc.code IN (
        'RM_DAMAGE',
        'RM_CONTAMINATION',
        'SFG_QUALITY_REJECT',
        'FG_QUALITY_REJECT',
        'PROCESS_WASTAGE',
        'DVC_ABANDONMENT',
        'PILFERAGE',
        'OTHER_LOSS'
      );
  `);

  await knex.raw(`
    DELETE FROM erp.reason_codes rc
    WHERE rc.code IN (
      'RM_DAMAGE',
      'RM_CONTAMINATION',
      'SFG_QUALITY_REJECT',
      'FG_QUALITY_REJECT',
      'PROCESS_WASTAGE',
      'DVC_ABANDONMENT',
      'PILFERAGE',
      'OTHER_LOSS'
    )
      AND NOT EXISTS (
        SELECT 1
        FROM erp.reason_code_voucher_type_map m
        WHERE m.reason_code_id = rc.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM erp.abnormal_loss_header alh
        WHERE alh.reason_code_id = rc.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM erp.stock_count_header sch
        WHERE sch.reason_code_id = rc.id
      );
  `);
};
