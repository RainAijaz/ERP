# Payroll closing in employee and labour ledgers

Payroll closing now lives in the existing Employee Ledger and Labour Ledger reports. The separate Payroll Periods menu entries and page have been retired. Existing `/hr-payroll/payroll` bookmarks redirect to an accessible balances or ledger report; existing payroll calculations remain in their original tables.

## Usage

1. Load a person in the employee or labour ledger.
2. Choose **Close payroll period**. Dates default to a completed configured salary cycle near the report end date. For a different period, enter the complete configured week/month. Employee unpaid days default to zero; the existing effective-dated deduction policy validates any nonzero input. Labour deductions remain separate voucher adjustments.
3. Preview the full account across all branches. This deliberately does not use a branch-filtered ledger as the payroll total. Check the preview before finalizing.
4. Finalize. Users without direct edit permission submit through the existing approval workflow. Finalization recomputes and compares the preview before saving; approval replay performs the same check. Changed source figures require a fresh preview.
5. Record actual payments through the existing payment vouchers.

**Finalized periods** in each ledger opens the person's saved calculations. History loads 25 periods at a time with **Load older periods**; viewing a snapshot cannot finalize it again. Saved net payable is the amount at period close, not today's outstanding balance. Missing historical pay configuration does not hide stored periods.

Both balances reports and both ledgers show **Latest finalized period ends** independently from **Checked through**. This is the latest saved ending date on or before the report date across all branches, not a claim that every earlier period was closed. Review checks retain their existing branch selection and change-detection behavior; checking an account does not finalize payroll or record payment.

## Access and integrity

Ledger report-load access, the existing employee/labour screen-view access, person restrictions and access to every assigned branch are required for closing and saved-calculation details. Report-only readers retain review and finalized-date metadata without gaining payroll actions. Direct actions reuse the existing edit-permission/approval gate. Finalization and its activity log are committed together, including approval replay.

The UI invalidates previews when inputs change, guards duplicate clicks, and requires a report reload after an uncertain finalization response or queued approval. Existing overlap checks, preview hashes, database locks, saved-snapshot protections and closed-earnings guards remain in force.

## Validation and rollout

No new dependency or database migration is introduced. The existing salary, guaranteed-pay and review schema must already be deployed, as required by the updated reports. Restart the application through the normal deployment process to load server changes.

Validation passed 19 existing salary/commission/guaranteed-pay unit tests plus isolated PostgreSQL and Playwright scenarios covering direct/queued/approved finalization, employee deductions, labour guaranteed pay, stale previews, duplicate closes, closed-period guards, history pagination, historical report dates, permission/branch denials, empty/injected input, network timeouts, ALL filter defaults, English desktop and Urdu mobile rendering. Deliberately rejected inputs produce expected service error logs. Temporary tests are ignored under `.tmp-payroll-ledger` and were not committed or pushed.

Validation used a dedicated synthetic database `erp_payroll_ledger_test` on localhost port 55447, with its server data directory and database identity checked before writes. The configured ERP database and real employee pay records were not changed. This change does not restart or deploy the running ERP.
