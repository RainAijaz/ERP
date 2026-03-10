const toPositiveId = (value) => {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
};

const toAmount = (value, decimals = 2) => {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(decimals));
};

const toQty = (value, decimals = 3) => {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(decimals));
};

const loadActiveSalesDiscountPolicyMapTx = async ({ trx, productGroupIds = [] }) => {
  const normalizedIds = [
    ...new Set((productGroupIds || []).map((id) => toPositiveId(id)).filter(Boolean)),
  ];

  if (!normalizedIds.length) return new Map();

  const rows = await trx("erp.sales_discount_policy as sdp")
    .leftJoin("erp.product_groups as pg", "pg.id", "sdp.product_group_id")
    .select(
      "sdp.id",
      "sdp.product_group_id",
      "sdp.max_pair_discount",
      "pg.name as product_group_name",
    )
    .whereIn("sdp.product_group_id", normalizedIds)
    .where({ "sdp.is_active": true });

  return new Map(
    rows.map((row) => [
      Number(row.product_group_id || 0),
      {
        id: Number(row.id || 0) || null,
        productGroupId: Number(row.product_group_id || 0) || null,
        productGroupName: String(row.product_group_name || "").trim(),
        maxPairDiscount: toAmount(row.max_pair_discount, 2),
      },
    ]),
  );
};

const evaluateSalesDiscountPolicy = ({
  saleLines = [],
  extraDiscount = 0,
  policyByGroupId = new Map(),
}) => {
  const eligibleLines = (Array.isArray(saleLines) ? saleLines : [])
    .map((line, index) => {
      const qtyPairs = toQty(line?.qtyPairs, 3);
      const grossAmount = toAmount(line?.grossAmount, 2);
      return {
        lineNo: Number(line?.lineNo || index + 1),
        productGroupId: toPositiveId(line?.productGroupId),
        productGroupName: String(line?.productGroupName || "").trim(),
        qtyPairs,
        grossAmount,
        pairDiscount: toAmount(line?.pairDiscount, 2),
      };
    })
    .filter((line) => line.qtyPairs > 0 && line.grossAmount >= 0);

  const totalEligibleGross = toAmount(
    eligibleLines.reduce((sum, line) => sum + Number(line.grossAmount || 0), 0),
    2,
  );
  const totalExtraDiscount = toAmount(extraDiscount, 2);

  let allocatedRunning = 0;
  const evaluatedLines = eligibleLines.map((line, index) => {
    let allocatedExtraDiscount = 0;
    if (totalExtraDiscount > 0 && totalEligibleGross > 0) {
      if (index === eligibleLines.length - 1) {
        allocatedExtraDiscount = toAmount(totalExtraDiscount - allocatedRunning, 2);
      } else {
        allocatedExtraDiscount = toAmount(
          (Number(totalExtraDiscount || 0) * Number(line.grossAmount || 0)) /
            Number(totalEligibleGross || 1),
          2,
        );
        allocatedRunning = toAmount(allocatedRunning + allocatedExtraDiscount, 2);
      }
    }

    const extraDiscountPerPair =
      line.qtyPairs > 0
        ? Number((Number(allocatedExtraDiscount || 0) / Number(line.qtyPairs || 1)).toFixed(4))
        : 0;
    const effectivePairDiscount = Number(
      (Number(line.pairDiscount || 0) + Number(extraDiscountPerPair || 0)).toFixed(4),
    );

    const policy = line.productGroupId ? policyByGroupId.get(line.productGroupId) : null;
    const allowedPairDiscount = policy ? toAmount(policy.maxPairDiscount, 2) : null;
    const exceedsPolicy =
      allowedPairDiscount !== null &&
      Number(effectivePairDiscount || 0) > Number(allowedPairDiscount || 0) + 0.0001;
    const excessPairDiscount =
      allowedPairDiscount !== null
        ? Number(
            Math.max(
              0,
              Number(effectivePairDiscount || 0) - Number(allowedPairDiscount || 0),
            ).toFixed(4),
          )
        : 0;
    const excessDiscountAmount = toAmount(
      Number(excessPairDiscount || 0) * Number(line.qtyPairs || 0),
      2,
    );

    return {
      ...line,
      allocatedExtraDiscount,
      extraDiscountPerPair,
      effectivePairDiscount,
      allowedPairDiscount,
      exceedsPolicy,
      excessPairDiscount,
      excessDiscountAmount,
    };
  });

  const violatedLines = evaluatedLines.filter((line) => line.exceedsPolicy);
  const totalExcessDiscount = toAmount(
    violatedLines.reduce(
      (sum, line) => sum + Number(line.excessDiscountAmount || 0),
      0,
    ),
    2,
  );

  return {
    lines: evaluatedLines,
    hasViolation: violatedLines.length > 0,
    violationCount: violatedLines.length,
    totalExtraDiscount,
    totalEligibleGross,
    totalExcessDiscount,
    maxEffectivePairDiscount: violatedLines.length
      ? Number(
          Math.max(
            ...violatedLines.map((line) => Number(line.effectivePairDiscount || 0)),
          ).toFixed(4),
        )
      : 0,
    maxAllowedPairDiscount: violatedLines.length
      ? toAmount(
          Math.max(
            ...violatedLines.map((line) => Number(line.allowedPairDiscount || 0)),
          ),
          2,
        )
      : 0,
    violatedGroups: [
      ...new Set(
        violatedLines
          .map((line) => line.productGroupName || "")
          .filter(Boolean),
      ),
    ],
  };
};

module.exports = {
  evaluateSalesDiscountPolicy,
  loadActiveSalesDiscountPolicyMapTx,
};
