// A negative value is not a positive acquisition cost. Approved shortages use
// the last documented receipt cost until their stock is received/reconciled.
const resolveStockUnitCost = ({ qty = 0, value = 0, lastUnitCost = 0 } = {}) => {
  const q = Number(qty), v = Number(value), fallback = Number(lastUnitCost);
  const result = q > 0 && v > 0 ? v / q : fallback > 0 ? fallback : 0;
  return Number.isFinite(result) ? Number(result.toFixed(6)) : 0;
};
module.exports = { resolveStockUnitCost };
