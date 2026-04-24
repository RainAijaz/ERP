const DEFAULT_ACTION = "create";

const ACTION_ALIASES = {
  create: ["create"],
  edit: ["edit", "update"],
  delete: ["delete", "deactivate"],
  hard_delete: ["hard_delete"],
};

const normalizeVoucherTypeCode = (value) =>
  String(value || "")
    .trim()
    .toUpperCase();

const normalizeAction = (value) => {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  if (!key) return DEFAULT_ACTION;
  if (key === "update") return "edit";
  if (key === "deactivate") return "delete";
  return key;
};

const resolveVoucherApprovalRequiredTx = async ({
  trx,
  voucherTypeCode,
  action = DEFAULT_ACTION,
}) => {
  const code = normalizeVoucherTypeCode(voucherTypeCode);
  if (!code) return false;

  const normalizedAction = normalizeAction(action);
  const aliases = ACTION_ALIASES[normalizedAction] || [normalizedAction];

  const policy = await trx("erp.approval_policy")
    .select("requires_approval")
    .where({
      entity_type: "VOUCHER_TYPE",
      entity_key: code,
    })
    .whereIn(
      trx.raw("lower(coalesce(action, ''))"),
      aliases.map((entry) => String(entry).toLowerCase()),
    )
    .orderByRaw(
      "case when lower(coalesce(action, '')) = ? then 0 else 1 end",
      [normalizedAction],
    )
    .first();

  return policy?.requires_approval === true;
};

module.exports = {
  resolveVoucherApprovalRequiredTx,
  normalizeVoucherTypeCode,
  normalizeAction,
};
