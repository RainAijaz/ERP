"use strict";

// Regression test for Stock Transfer report branch scoping.
//
// Run: node backend/tests/unit/stock-transfer-report-branch-permission.test.js

const assert = require("assert");

const {
  ALL_MULTI_FILTER_VALUE,
  __test,
} = require("../../src/services/inventory/inventory-report-service");

const buildReq = ({ canFilterAllBranches }) => ({
  locale: "en",
  branchId: 1,
  branchScope: [1],
  user: {
    isAdmin: false,
    permissions: {
      "REPORT:stock_transfer_report": {
        can_view: true,
        can_load: true,
        can_filter_all_branches: Boolean(canFilterAllBranches),
      },
    },
  },
});

let failures = 0;
let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
};

console.log("\nStock Transfer report branch permissions");

check("granted filter_all_branches keeps source and destination selections", () => {
  const filters = __test.parseStockTransferReportFilters({
    req: buildReq({ canFilterAllBranches: true }),
    input: {
      load_report: "1",
      source_branch_ids: ["2", "3"],
      destination_branch_ids: "4,5",
    },
  });

  assert.deepStrictEqual(filters.sourceBranchIds, [2, 3]);
  assert.deepStrictEqual(filters.destinationBranchIds, [4, 5]);
});

check("granted filter_all_branches treats ALL as consolidated all branches", () => {
  const filters = __test.parseStockTransferReportFilters({
    req: buildReq({ canFilterAllBranches: true }),
    input: {
      load_report: "1",
      source_branch_ids: ALL_MULTI_FILTER_VALUE,
      destination_branch_ids: "ALL",
    },
  });

  assert.deepStrictEqual(filters.sourceBranchIds, []);
  assert.deepStrictEqual(filters.destinationBranchIds, []);
});

check("without filter_all_branches, ALL falls back to the user's branch scope", () => {
  const filters = __test.parseStockTransferReportFilters({
    req: buildReq({ canFilterAllBranches: false }),
    input: {
      load_report: "1",
      source_branch_ids: ALL_MULTI_FILTER_VALUE,
      destination_branch_ids: "ALL",
    },
  });

  assert.deepStrictEqual(filters.sourceBranchIds, [1]);
  assert.deepStrictEqual(filters.destinationBranchIds, [1]);
});

check("without filter_all_branches, out-of-scope ids fall back safely", () => {
  const filters = __test.parseStockTransferReportFilters({
    req: buildReq({ canFilterAllBranches: false }),
    input: {
      load_report: "1",
      source_branch_ids: "999999",
      destination_branch_ids: ["888888"],
    },
  });

  assert.deepStrictEqual(filters.sourceBranchIds, [1]);
  assert.deepStrictEqual(filters.destinationBranchIds, [1]);
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
