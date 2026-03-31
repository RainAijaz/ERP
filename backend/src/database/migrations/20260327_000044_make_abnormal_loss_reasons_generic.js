exports.up = async function up(knex) {
  await knex.raw(`
    UPDATE erp.reason_codes
    SET
      name = CASE code
        WHEN 'RM_DAMAGE' THEN 'Damage'
        WHEN 'RM_CONTAMINATION' THEN 'Contamination'
        WHEN 'SFG_QUALITY_REJECT' THEN 'Quality Reject'
        WHEN 'FG_QUALITY_REJECT' THEN 'Inspection Reject'
        WHEN 'PROCESS_WASTAGE' THEN 'Process Wastage'
        WHEN 'DVC_ABANDONMENT' THEN 'Abandonment'
        WHEN 'PILFERAGE' THEN 'Pilferage'
        WHEN 'OTHER_LOSS' THEN 'Other'
        ELSE name
      END,
      description = CASE code
        WHEN 'RM_DAMAGE' THEN 'Stock damaged during handling, storage, or process.'
        WHEN 'RM_CONTAMINATION' THEN 'Stock rejected due to contamination or deterioration.'
        WHEN 'SFG_QUALITY_REJECT' THEN 'Rejected due to quality non-conformance.'
        WHEN 'FG_QUALITY_REJECT' THEN 'Rejected during inspection or final checks.'
        WHEN 'PROCESS_WASTAGE' THEN 'Loss due to process wastage.'
        WHEN 'DVC_ABANDONMENT' THEN 'Work or stock abandoned before completion.'
        WHEN 'PILFERAGE' THEN 'Loss due to pilferage or theft.'
        WHEN 'OTHER_LOSS' THEN 'Any other approved abnormal loss reason.'
        ELSE description
      END
    WHERE code IN (
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
};

exports.down = async function down(knex) {
  await knex.raw(`
    UPDATE erp.reason_codes
    SET
      name = CASE code
        WHEN 'RM_DAMAGE' THEN 'RM Damage'
        WHEN 'RM_CONTAMINATION' THEN 'RM Contamination'
        WHEN 'SFG_QUALITY_REJECT' THEN 'SFG Quality Reject'
        WHEN 'FG_QUALITY_REJECT' THEN 'FG Quality Reject'
        WHEN 'PROCESS_WASTAGE' THEN 'Process Wastage'
        WHEN 'DVC_ABANDONMENT' THEN 'DVC Abandonment'
        WHEN 'PILFERAGE' THEN 'Pilferage'
        WHEN 'OTHER_LOSS' THEN 'Other Loss'
        ELSE name
      END,
      description = CASE code
        WHEN 'RM_DAMAGE' THEN 'Raw material damaged before or during processing.'
        WHEN 'RM_CONTAMINATION' THEN 'Raw material rejected due to contamination or spoilage.'
        WHEN 'SFG_QUALITY_REJECT' THEN 'Semi-finished goods rejected by quality checks.'
        WHEN 'FG_QUALITY_REJECT' THEN 'Finished goods rejected by quality checks.'
        WHEN 'PROCESS_WASTAGE' THEN 'Normal or abnormal material/process wastage during production.'
        WHEN 'DVC_ABANDONMENT' THEN 'Department-completion work-in-progress abandoned.'
        WHEN 'PILFERAGE' THEN 'Inventory loss due to theft or pilferage.'
        WHEN 'OTHER_LOSS' THEN 'Loss recorded for reasons outside standard categories.'
        ELSE description
      END
    WHERE code IN (
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
};
