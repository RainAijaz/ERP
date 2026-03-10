exports.up = async function up(knex) {
  await knex.raw(`
    INSERT INTO erp.rgp_reason_registry (code, name, description, is_active)
    VALUES
      ('REPAIR', 'Repair', 'Sent for repair', true),
      ('CALIBRATION', 'Calibration', 'Calibration', true),
      ('SHARPENING', 'Sharpening', 'Sharpening', true),
      ('REFURBISH', 'Refurbishment / Overhaul', 'Refurbishment / Overhaul', true),
      ('COATING_TREATMENT', 'Coating / Surface Treatment', 'Coating / Surface Treatment', true),
      ('MODIFICATION', 'Modification', 'Modification', true),
      ('OTHERS', 'Others', 'Others', true)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      is_active = EXCLUDED.is_active
  `);

  await knex.raw(`
    INSERT INTO erp.rgp_condition_registry (code, name, description, is_active)
    VALUES
      ('NEW', 'Unused', 'Unused', true),
      ('GOOD_WORKING', 'Fully Working', 'Fully Working', true),
      ('WORKING_MINOR_WEAR', 'Working, Minor Wear', 'Working, Minor Wear', true),
      ('DAMAGED', 'Damaged', 'Damaged condition', true),
      ('NON_FUNCTIONAL', 'Non-Functional', 'Non-Functional', true),
      ('INCOMPLETE', 'Missing Parts', 'Missing Parts', true),
      ('RUSTED_CORRODED', 'Rusted', 'Rusted', true)
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      is_active = EXCLUDED.is_active
  `);

  await knex("erp.rgp_reason_registry")
    .whereIn("code", ["SHARPEN", "CALIBRATE", "TRIAL"])
    .update({ is_active: false });

  await knex("erp.rgp_condition_registry")
    .whereIn("code", ["GOOD", "WORN", "OK", "REPAIRED", "SCRAP"])
    .update({ is_active: false });
};

exports.down = async function down(knex) {
  await knex("erp.rgp_reason_registry")
    .whereIn("code", ["SHARPEN", "CALIBRATE", "TRIAL"])
    .update({ is_active: true });

  await knex("erp.rgp_condition_registry")
    .whereIn("code", ["GOOD", "WORN", "OK", "REPAIRED", "SCRAP"])
    .update({ is_active: true });
};

