const PAIR_CODE = "PAIR";

const isPairUomRow = (row) => {
  const code = String(row?.code || "").trim().toUpperCase();
  const name = String(row?.name || "").trim().toUpperCase();
  return code === PAIR_CODE || name === "PAIR";
};

const fetchPairUomOption = async (db) => {
  const rows = await db("erp.uom")
    .select("id", "code", "name")
    .where({ is_active: true })
    .orderBy("id", "asc");
  return rows.find((row) => isPairUomRow(row)) || null;
};

const fetchProductionBaseUomOptions = async (db) => {
  const pair = await fetchPairUomOption(db);
  return pair ? [pair] : [];
};

const isPairUomId = async (db, uomId) => {
  const normalizedId = Number(uomId || 0);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) return false;
  const row = await db("erp.uom")
    .select("id", "code", "name")
    .where({ id: normalizedId })
    .first();
  return isPairUomRow(row);
};

module.exports = {
  PAIR_CODE,
  fetchPairUomOption,
  fetchProductionBaseUomOptions,
  isPairUomId,
};
