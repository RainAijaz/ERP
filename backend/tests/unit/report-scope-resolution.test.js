"use strict";

// Unit test for resolveReportScopeKey in views/base/partials/report-utils.ejs.
//
// That function maps window.location.pathname -> a REPORT permission scope key.
// When it returns null, EVERY report permission silently becomes false, which
// disables the branch filter, print, export and drill-down links. It used to
// return null for "/reports/purchases" (the purchase report posts back to its
// bare mount point, so the loaded page has no trailing slash) while the
// registered prefix is "/reports/purchases/".
//
// Run: node backend/tests/unit/report-scope-resolution.test.js

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const EJS = path.join(
  __dirname,
  "..",
  "..",
  "src",
  "views",
  "base",
  "partials",
  "report-utils.ejs",
);

const src = fs.readFileSync(EJS, "utf8");

// Pull the real prefix table out of the shipped partial so this test tracks the
// source of truth instead of a copy that can drift.
const tableStart = src.indexOf("const REPORT_SCOPE_BY_PATH");
const tableEnd = src.indexOf("const reportPermissionByScope");
assert.ok(tableStart > -1 && tableEnd > tableStart, "REPORT_SCOPE_BY_PATH not found");
const MAP = [...src.slice(tableStart, tableEnd).matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)]
  .map((m) => [m[1], m[2]]);
assert.ok(MAP.length >= 30, `expected the full prefix table, got ${MAP.length}`);

const ROOTS = ["/reports/", "/master-data/bom/reports/"];
const inScope = (p) => ROOTS.some((r) => p.startsWith(r));

// The shipped (fixed) implementation, mirrored.
const resolveNew = (p) => {
  if (!inScope(p)) return null;
  const candidate = p.endsWith("/") ? p : `${p}/`;
  for (const [prefix, scopeKey] of MAP) if (candidate.startsWith(prefix)) return scopeKey;
  return null;
};
// The previous implementation, for the no-regression comparison.
const resolveOld = (p) => {
  if (!inScope(p)) return null;
  for (const [prefix, scopeKey] of MAP) if (p.startsWith(prefix)) return scopeKey;
  return null;
};

// Assert the fixed resolver still contains the literal shape we think it does,
// so this test fails loudly if someone reverts or rewrites it.
assert.ok(
  /const candidate = path\.endsWith\("\/"\) \? path : `\$\{path\}\/`;/.test(src),
  "report-utils.ejs no longer normalizes the trailing slash",
);

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

console.log("\n1. The reported bug");
check("/reports/purchases (no trailing slash) resolves to purchase_report", () => {
  assert.strictEqual(resolveOld("/reports/purchases"), null, "precondition: used to be null");
  assert.strictEqual(resolveNew("/reports/purchases"), "purchase_report");
});
check("/reports/purchases/ (with slash) still resolves to purchase_report", () => {
  assert.strictEqual(resolveNew("/reports/purchases/"), "purchase_report");
});

console.log("\n2. Sibling purchase reports keep their own, more specific scope");
[
  ["/reports/purchases/supplier-ledger", "supplier_ledger"],
  ["/reports/purchases/supplier-balances", "supplier_balances"],
  ["/reports/purchases/pending-grn", "pending_grn"],
  ["/reports/purchases/supplier-analysis", "supplier_analysis"],
].forEach(([p, expected]) => {
  check(`${p} -> ${expected}`, () => assert.strictEqual(resolveNew(p), expected));
});

console.log("\n3. Specific child report routes do not inherit broad module report scopes");
[
  ["/reports/sales/sales-discount-report", "sales_discount_report"],
  ["/reports/sales/customer-balances", "customer_balances_report"],
  ["/reports/sales/customer-ledger", "customer_ledger_report"],
  ["/reports/sales/sales-order-report", "sales_order_report"],
  ["/reports/production/planned-consumption", "planned_consumption_report"],
  ["/reports/production/department-wip", "department_wip_report"],
  ["/reports/production/department-wip-balances", "department_wip_balances_report"],
  ["/reports/production/department-wip-ledger", "department_wip_ledger_report"],
  ["/reports/inventory/stock-transfer", "stock_transfer_report"],
  ["/reports/hr-payroll/commission-ledger", "commission_ledger"],
].forEach(([p, expected]) => {
  check(`${p} -> ${expected}`, () => assert.strictEqual(resolveNew(p), expected));
});

console.log("\n4. Every registered prefix resolves identically with and without a trailing slash");
MAP.forEach(([prefix]) => {
  const withSlash = prefix.endsWith("/") ? prefix : `${prefix}/`;
  const without = prefix.replace(/\/$/, "");
  check(`${without} === ${withSlash}`, () =>
    assert.strictEqual(resolveNew(without), resolveNew(withSlash)));
});

console.log("\n5. No regression: nothing that already resolved now resolves differently");
const corpus = new Set();
MAP.forEach(([prefix]) => {
  corpus.add(prefix);
  corpus.add(prefix.replace(/\/$/, ""));
  corpus.add(`${prefix.replace(/\/$/, "")}/sub`);
  corpus.add(`${prefix.replace(/\/$/, "")}/sub/deeper`);
});
[
  "/reports/purchases", "/reports/sales", "/reports/production", "/reports/returnables",
  "/reports/inventory/stock-amount", "/reports/financial/profit_and_loss",
].forEach((p) => corpus.add(p));

check("no already-matching path changed scope", () => {
  const changed = [...corpus]
    .filter((p) => resolveOld(p) !== null && resolveOld(p) !== resolveNew(p))
    .map((p) => `${p}: ${resolveOld(p)} -> ${resolveNew(p)}`);
  assert.deepStrictEqual(changed, [], `regressions:\n${changed.join("\n")}`);
});
check("the only newly-matching paths are the 4 bare mount points", () => {
  const gained = [...corpus].filter((p) => resolveOld(p) === null && resolveNew(p) !== null).sort();
  assert.deepStrictEqual(gained, [
    "/reports/production", "/reports/purchases", "/reports/returnables", "/reports/sales",
  ]);
});

console.log("\n6. Non-report and near-miss paths still resolve to null");
[
  "/vouchers/purchase", "/dashboard", "/", "/reports/", "/reports",
  "/reports/unknown-report", "/master-data/bom/form",
  "/reports/purchasesX",            // must not be treated as /reports/purchases
  "/reports/purchases-archive",     // ditto
].forEach((p) => {
  check(`${p} -> null`, () => assert.strictEqual(resolveNew(p), null));
});

console.log("\n7. Scope keys the resolver returns all have permissions defined");
check("every scope key in the prefix table exists in reportPermissionByScope", () => {
  const permBlock = src.slice(tableEnd, src.indexOf("const resolveReportScopeKey"));
  const missing = [...new Set(MAP.map(([, k]) => k))].filter(
    (k) => !permBlock.includes(`${k}:`) && !permBlock.includes(`"${k}"`),
  );
  assert.deepStrictEqual(missing, [], `scope keys with no permission entry: ${missing.join(", ")}`);
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
