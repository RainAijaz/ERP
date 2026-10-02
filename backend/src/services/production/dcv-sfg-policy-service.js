const { HttpError } = require("../../middleware/errors/http-error");
const { insertActivityLog } = require("../../utils/audit-log");

const updateDcvSfgAvailabilityPolicyTx = async ({
  trx,
  req,
  enabled,
  t,
}) => {
  try {
    const existing = await trx("erp.voucher_type")
      .select("enforce_sfg_availability")
      .where({ code: "DCV" })
      .forUpdate()
      .first();
    if (!existing) {
      throw new HttpError(400, t("error_invalid_id"));
    }
    if (existing.enforce_sfg_availability === enabled) return;

    await trx("erp.voucher_type")
      .where({ code: "DCV" })
      .update({ enforce_sfg_availability: enabled });
    await insertActivityLog(trx, {
      branch_id: req.branchId || null,
      user_id: req.user?.id || null,
      entity_type: "VOUCHER",
      entity_id: "DCV",
      voucher_type_code: "DCV",
      action: "UPDATE",
      ip_address: req.ip,
      context: {
        field: "enforce_sfg_availability",
        old_value: existing.enforce_sfg_availability,
        new_value: enabled,
      },
    });
  } catch (err) {
    console.error("Error in DcvSfgPolicyService:", err);
    throw err;
  }
};

module.exports = { updateDcvSfgAvailabilityPolicyTx };
