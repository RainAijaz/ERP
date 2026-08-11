"use strict";

// erp.uom_conversions.factor is numeric(18,6), so a factor that is really the
// reciprocal of a whole number cannot be stored exactly: 1 PAIR = 1/12 DZN gets
// truncated to 0.083333. Multiplying by that drifts ~4e-6 per unit — invisible
// on small quantities, but visible at the 3rd decimal once the quantity passes
// ~1200 base units (1536 pairs rendered as 127.999 DZN instead of 128).
//
// Both directions of a pair are often stored (prod has DZN->PAIR = 12.000000
// AND PAIR->DZN = 0.083333), so which value a lookup picked up was also
// dependent on row order. Snapping every factor to the clean value it is
// plainly meant to be makes the graph exact and direction-independent.
//
// The +/-0.001 tolerance mirrors normalizeFactorToBase in the voucher services.
// Genuinely fractional factors (0.4, 2.5, 39.37) are left untouched.
const FACTOR_SNAP_TOLERANCE = 0.001;

const normalizeConversionFactor = (value) => {
  const factor = Number(value);
  if (!Number.isFinite(factor) || factor <= 0) return factor;

  const nearestInteger = Math.round(factor);
  if (
    nearestInteger > 0 &&
    Math.abs(factor - nearestInteger) <= FACTOR_SNAP_TOLERANCE
  ) {
    return nearestInteger;
  }

  const inverse = 1 / factor;
  const nearestInverse = Math.round(inverse);
  if (
    nearestInverse > 0 &&
    Math.abs(inverse - nearestInverse) <= FACTOR_SNAP_TOLERANCE
  ) {
    return 1 / nearestInverse;
  }

  return factor;
};

module.exports = {
  FACTOR_SNAP_TOLERANCE,
  normalizeConversionFactor,
};
