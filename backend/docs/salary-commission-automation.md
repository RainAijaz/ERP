# Salary and commission automation — 29 October 2026

## Implemented screens

- **Employee Commission Rules**: `/hr-payroll/employees/commissions`.
- **Payroll periods**: `/hr-payroll/payroll`.
- **Employees**: existing employee setup now includes weekly salary, an explicit week-ending day, salary effective date, partial-period treatment, and a separate unpaid-day deduction policy.

Commission is independent of the fixed salary frequency. Monthly, weekly, and daily salaries can coexist with active commission rules. Legacy Piece Rate/Multiple classifications remain supported; they do not invent a fixed salary frequency.

## Commission configuration

Choose the employee, then Sale or Production. Existing Transfer and Party selections remain available under Other existing commission types.

Sale offers own-sales/branch-sales scope, packed-only versus packed-and-loose quantities, and reversal on returns. Existing rules retain packed-only behavior unless explicitly changed. A legacy article rate can inherit its group's quantity policy; an explicitly configured article policy takes precedence.

Production offers finished-stock completion, semi-finished-stock completion, or department/stage completion. Worker, department and stage restrictions are available only for department/stage completion: final stock alone cannot identify who performed an earlier stage. Legacy single-department DCVs can use their header attribution; newer DCVs use line attribution.

Both sources support product groups, subgroups, articles, eligible branches, excluded quality grades, effective dates, and additional product exclusions. Exclusions override article rates. Rules use IDs rather than employee/product names.

The existing Replace existing article rates option remains unchecked by default. Scope rates and explicit article exceptions are stored separately. Saving a preview page applies the complete selected product scope, including deliberate edits made on other pages. Group/subgroup saves require one employee; existing multi-employee SKU operations remain available.

Worker/stage/branch conditions identify independent earning scopes. Exclusions and quantity policy are settings of a version, so removing an exclusion does not leave its old version active. Future-dated edits close the original version; same-start-date corrections remain explicit corrections. Closed payroll prevents changes to posted earnings.

New production postings capture product quality/group context. Recalculation uses that captured context and actual stock-in pairs. Historical vouchers without a captured classification cannot reconstruct a product's former grade automatically.

## Salary and payroll behavior

Salary history is captured transactionally for both immediate employee changes and approved changes. Salary changes within a period are weighted by covered days. Daily salaries retain the existing Sunday exclusion.

Choose the week-ending day explicitly. No day has been assigned to real employees automatically. Calendar-day proration supports partial employment periods and transitions between salary schedules; a schedule change without proration requires a shared period boundary. The existing full-period behavior accrues at the scheduled end; choose calendar proration when a partial final employment period must accrue.

Absence deductions are disabled until configured. Enter reviewed unpaid days manually when previewing payroll. The deduction uses the period-end salary divided by the configured working-day divisor; reviewed days cannot exceed the period or divisor. Missing machine punches do not create deductions. Hour-based absence calculation is not part of this implementation.

Payroll previews reuse the employee ledger, including salary, allowances, commission, staff purchases, advances and payments. Allowance effective dates are honored, and percentage allowances use salary history. The result carries an opening unpaid balance forward.

Finalization requires an ended period, a matching fresh preview, and no overlapping finalized period. Restricted users submit through existing Employee edit approvals. Approval recomputes the preview and rejects a changed calculation. Stored snapshots remain readable independently of a fresh preview.

Payroll lists and saved snapshots require access to every branch mapped to that employee, and honor existing blocked-employee settings. Commission approval previews identify employees, selected products, eligibility conditions, article exceptions, rate units and override behavior.

Finalization stores the calculation and its approved absence deduction. It does **not** send money or generate salary/payment/GL vouchers. Payments continue through existing financial vouchers and employee-ledger reconciliation. Historical totals mean payable **at period close**, not today's remaining unpaid amount.

Finalized snapshots cannot be edited/deleted. Changes affecting closed employee earnings, employment dates or allowances are rejected; record corrections as dated entries in an open period. A preview of an already closed period directs the user to its saved calculation instead of applying an absence deduction again.

## Performance controls

- No complete SKU catalogue or worker list in initial modal HTML.
- Shared searchable dropdowns fetch 50 matches per request and retain selected values.
- Per-control search caching: 30 seconds, at most 16 entries; context changes invalidate it.
- Article previews fetch 100 rows per page and render only the visible rows plus a small buffer.
- Existing 400 ms preview debounce and indexed previous-rate lookup are retained.
- Outdated searches/previews are aborted and guarded against late responses or errors.
- Rate entry updates the current page locally; saves submit the scope and explicit exceptions.
- Shared dropdown refresh also synchronizes disabled/editable state when switching source.
- Existing report structures are extended with source workers, stages, captured quality, quantities and rate units. Commission-report filters initialize/reset to ALL; oversized loads require narrower filters rather than silently truncating totals.

The isolated harness uses the actual HR templates/shared scripts and stylesheet, with 10,000 SKUs and 1,003 workers. Observed runs opened the modal in approximately 134–270 ms, updated rate entry in approximately 18–33 ms, and returned a 100-row preview in approximately 115–181 ms. The final run measured 135.8 ms opening, 18.7 ms rate entry and 180.9 ms server preview. About 15 article rows were painted. These are local harness measurements, not a guarantee for every device or network.

## Validation and rollout

New migrations:

1. `20261029_000128_salary_commission_configuration.js`
2. `20261029_000129_finalized_payroll_guards.js`
3. `20261029_000130_payroll_history_integrity.js`

Deploy source and migrations together, using the project's normal migration process, then restart the application and reload the browser to load the updated screens. No package dependencies were added. The initial implementation was validated locally. The 30 October release publishes the salary/commission source changes to main; it does not restart the configured application or deploy to a hosted server.

Unit/shared-UI checks cover canonical scopes, invalid/injected input, grade exclusion precedence, worker/stage/branch conditions, loose-sale policies, weekly boundaries, salary history, daily Sundays, partial periods, schedule transitions and absence policies. Isolated PostgreSQL/Playwright checks cover direct/queued/approved commission changes, compact full-scope saves, off-screen edits, quality snapshots, stock quantities, frozen payroll, unpaid-day approval, duplicate protection, network timeouts, Urdu/mobile layout and bounded large lists. Test files are intentionally uncommitted.

Final validation: 17/17 unit/shared-UI tests passed; all 16 isolated database/browser scenario groups passed; 26 server scripts, seven templates and two shared browser scripts compiled. Targeted whitespace checks passed. Deliberately invalid input and duplicate finalization produced expected service error logs during negative checks.

### Test setup incident and retained additions

The first migration checks used the configured ERP development database because `knexfile.js` development configuration reads individual DB variables rather than `DATABASE_URL`. The additions reached the new schema and one unused branch named **Synthetic branch**; no test users, payroll runs or new commission rules were created there. Existing salary amounts and posted transaction records were not edited. Read-only verification found zero user/employee/labour/voucher links to that branch.

Automatic approval review rejected destructive cleanup. The user explicitly chose **Keep the additions for now**. The branch and schema additions therefore remain. Migrations 128/129 recognize the already-created feature schema so the normal migration process can register them; migration 130 contains subsequent integrity refinements and still needs normal rollout. The configured database was not used again for test writes after the connection issue was identified.

All subsequent validation pins DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD and DATABASE_URL to a separate localhost PostgreSQL instance. It verifies the server's actual data directory before resetting synthetic fixtures and asserts the actual database name and port before application writes. Its database contains synthetic fixtures only; notification senders are stubbed in its browser harness.

## Employee setup still required

Real employee pay terms must be configured against the existing employee, product, branch and worker records. Confirm fixed salary amounts and frequencies, the weekly ending day, eligible production stages, commission rates and units, return policy, partial-dozen policy and absence policy before enabling each rule. These business settings are intentionally not hardcoded into the application.

Existing per-dozen calculations are proportional to pairs; a separate whole-dozen rounding policy has not been introduced. Absence policies require explicit configuration before deductions are enabled.

## Main-branch publication validation — 30 October 2026

The release preserves main's newer asynchronous backdated commission recalculation and existing past-rate indicators. The merged source passed 13 salary/eligibility unit tests, all 16 isolated database/browser scenario groups, and compilation of 26 server scripts, seven templates and two shared scripts. Tests and temporary fixtures are excluded from the commit.

With main's current stylesheet, the release harness measured 684 ms opening, 8 ms rate entry, 96 ms server preview and 15 painted rows for 10,000 articles. Device and browser loading conditions affect these measurements. Earlier workspace measurements are recorded above for comparison.
