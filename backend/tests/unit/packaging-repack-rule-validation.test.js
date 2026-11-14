"use strict";

// Run from backend: node tests/unit/packaging-repack-rule-validation.test.js
const assert = require("node:assert/strict");
const { __test } = require("../../src/services/sales/packaging-repack-service");

const sku = (packing_type_id, size_id = 1, grade_id = 2, color_id = 3) =>
  ({ packing_type_id, size_id, grade_id, color_id });
const match = __test.hasExactlyMatchingSourceForEachTargetSku;
assert.equal(match([sku(1), sku(2)], 1, 2), true, "one matching source and target");
assert.equal(match([sku(2)], 1, 2), false, "missing source");
assert.equal(match([sku(1)], 1, 2), false, "missing target");
assert.equal(match([sku(1), sku(1), sku(2)], 1, 2), false, "ambiguous source");
assert.equal(match([sku(1), sku(2), sku(2, 4)], 1, 2), false,
  "a target without a matching source is not eligible");
assert.equal(match([sku(1), sku(1, 4), sku(2), sku(2, 4)], 1, 2), true,
  "multiple corresponding variants");
assert.equal(match([sku(1, null, null, null), sku(2, null, null, null)], 1, 2),
  true, "null dimensions match");
assert.deepEqual(__test.normalizeRuleItemIds({ item_ids: ["4", "5", "4"] }), [4, 5]);
assert.deepEqual(__test.normalizeRuleItemIds({ item_id: "4" }), [4]);
assert.throws(() => __test.normalizeRuleItemIds({ item_ids: ["4", ""] }));
console.log("Packaging repack rule validation: 10 checks passed");
