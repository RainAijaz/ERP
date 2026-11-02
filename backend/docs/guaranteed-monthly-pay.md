# Guaranteed monthly pay for employees and labours

The implementation plan is recorded in `guaranteed-monthly-pay-plan.md`.

## Setup

Use the existing Employee or Labour add/edit form. Pay arrangement defaults to the existing calculation:

- Employees: salary plus earned commission.
- Labours: production/piece-rate earnings plus allowances.

For selected people choose **Monthly salary or earned amount, whichever is higher**. Employees must use Monthly payroll and their existing Basic salary. Labours enter Guaranteed monthly salary. Enter the first day of the effective month. To stop the guarantee, choose the existing arrangement and enter the first day of the new month. No worker is opted in automatically.

The guarantee is settled per calendar month. For salary 30,000 and eligible earnings 45,000, payroll shows salary 30,000, earned amount 45,000, adjustment 30,000 and extra earnings 15,000, resulting in 45,000 before separate allowances/deductions. A month earning 20,000 produces salary 30,000, earned amount 20,000 and adjustment 20,000, resulting in 30,000.

Eligible employee earnings include approved commission-ledger entries and the existing salesman commission voucher lines. Eligible labour earnings use the same direct/line/header worker attribution and payable direction as the labour ledger, restricted to production voucher types. Pending vouchers, payments, journals, staff purchases, allowances and opening balances do not enter the comparison. Net earnings reversals can be negative; the guarantee then supplies a protection credit. A shortfall never carries into another month.

## Approvals and history

Direct saves and approved saves use the same validation. Users with screen view access but without direct create/edit rights submit changes through the existing approval system. Administrators can edit the proposed arrangement, salary and effective date before approving. Both old/new previews use the existing forms. Legacy payloads retain omitted current settings; status-only requests do not overwrite pay terms.

The database captures effective-dated guarantee history for both worker types. Salary amount/frequency changes cannot rewrite a later scheduled guarantee. Employee salary history and existing partial-employment treatment remain in use. Labour guarantee salary accrues at month end from the configured effective month. Inactivating a master record does not erase its pay history; stop the guarantee explicitly using a new effective month.

## Payroll and reports

The existing Payroll periods screen includes both worker kinds. Access follows the appropriate Employee/Labour screen, branch mappings and blocked-entity settings. A guarantee needs complete earnings across every assigned branch, so incomplete branch report filters are rejected with a localized explanation.

Payroll shows the guaranteed salary, earned amount, adjustment, extra earnings and salary-plus-extra total before the existing ledger balance totals. Employee unpaid-day deductions are applied after the comparison under their configured policy. Labour unpaid-day deductions are not inferred from employee policies; use separately approved voucher adjustments.

Employee/Labour ledger detail and category summaries, opening balances and balance-as-on reports use the same month-end adjustments. Labour balances show accrued guarantee salary and adjustments explicitly. Existing report tables, print/download controls, responsive wrappers and global filter behavior remain in use. Commission reports continue to show gross earned commission and explain where to find the salary settlement.

Finalization is available only after the period end date, uses a fresh server calculation, prevents overlapping runs, and stores an immutable snapshot. Queued closing proposals are recomputed on approval. Their computed amounts cannot be edited as master fields. Source earnings, voucher dates/attribution and relevant allowances are protected against changing closed periods. Future corrections must be dated in an open period.

Finalization follows the existing payroll architecture: it does not transfer money or create GL/payment vouchers. The financial wage-control report continues to reflect posted GL. Existing financial vouchers record payments.

## Rollout

Deploy the source together with migration `20261102_000131_guaranteed_monthly_pay.js`, after the existing salary-history and payroll-guard migrations 128–130, then restart the application through the normal process. The migration defaults all existing records to EXISTING; it does not assign any real worker a guarantee.

Migration 131 adds pay-arrangement fields, labour salary fields, worker guarantee history, labour payroll snapshots, source/closing guards and supporting indexes. It preserves accounting history and deliberately requires a reviewed forward migration for reversal.

Implementation validation uses a separate verified PostgreSQL cluster and synthetic records. Live employee/labour terms, live financial records, deployment and payment are outside those checks. Test files are kept out of git.

## Validation completed

- 28 unit checks passed, including existing salary and approval regressions.
- A clean migration succeeded in the verified isolated database.
- Browser checks exercised direct and restricted create/update for both worker types, administrator edits of pending requests, approval replay, history and audit records, payroll closing approvals, read-only calculated proposals, stale-preview rejection and per-kind permissions.
- Employee/Labour detail and summary ledgers and balances reconciled for negative, zero, lower, equal and higher earnings, pending vouchers, mixed employee commission sources, payments, journals, allowances and approved employee absence deductions.
- Snapshot immutability, duplicate closing, backdating, historical salary changes and multi-worker DCV header/line reassignment were verified. Mobile Urdu forms/reports, request failure handling, empty/injected input and existing print areas were exercised.
- 19 server files and 10 templates compiled; targeted whitespace checks passed. Deliberately invalid actions generated the expected service error logs.
