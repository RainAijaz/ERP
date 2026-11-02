# Guaranteed monthly pay: implementation plan

## Agreed behavior

- Opt in separately on each Employee/Labour record; default EXISTING preserves all current behavior.
- MONTHLY_GUARANTEE pays the greater of monthly salary and net approved eligible earnings. Employees use their existing monthly basic salary; labours gain a monthly salary amount.
- Eligible earnings are employee commission (including voucher-line salesman commission) or labour production/piece-rate earnings. Payments, journal adjustments, advances, staff purchases, allowances and opening balances do not enter the comparison.
- Retain source earnings and production costs. At month end show salary and an adjustment of min(salary, net eligible earnings); a negative earnings reversal receives a corresponding protection credit. This yields max(salary, earnings), including reversals.
- Allowances and configured absence deductions remain separate. No commission deficit carries to another month.
- Changes to guaranteed terms start on calendar-month boundaries. Employee partial employment follows its existing salary proration policy. Labour guarantee starts on the selected month and accrues at month end.

## Integration checklist (complete before rollout)

1. Add defaulted master fields and a migration with effective-dated guarantee history, valid worker foreign keys, closed-period protection and immutable labour payroll snapshots. Do not change real workers' arrangements.
2. Add shared validation and field definitions to existing forms; reuse searchable selects, localized labels, conditional fields and existing layouts. Explain the calculation with a concrete example.
3. Extend direct save, pending payload, old/new preview, administrator edit allowlist, edit validation and replay. Legacy requests preserve existing pay settings; status-only changes do not reset them. Payroll snapshots/hashes are server-produced and not editable as ordinary master fields.
4. Share the ledger's earning-direction and labour attribution rules with guarantee aggregation. Compute complete months before applying report date windows. Include historical adjustments in opening balances and balances-as-on. Require complete branch scope for guarantee totals rather than combining partial earnings with a full salary.
5. Extend existing payroll routes, list, preview, approval preview and replay to both worker kinds. Keep per-kind permissions, blocked-entity and branch access, fresh-preview matching, period overlap protection and activity logging.
6. Update employee/labour ledger detail and summary, balance detail and summary, payroll explanatory amounts, print/export data and translated labels. Gross commission reports remain gross source earnings and explain that payroll applies the guarantee separately. Financial wage-control report remains based on posted GL; payroll finalization does not create GL or payment vouchers.
7. Validate against synthetic data in a verified isolated PostgreSQL cluster. Cover lower/equal/higher/zero/negative earnings, month boundaries, history, multiple branches, payments excluded, defaults unchanged, both worker kinds, direct/queued/edited/approved paths, stale previews, duplicates, closed periods, malicious/empty inputs and request failures. Use Playwright for forms, approval edits, payroll, mobile and Urdu. Do not commit test files.

## Existing integration points

- `src/routes/hr-payroll/{employees,labours,master-router,payroll-runs}.js`
- `src/services/hr-payroll/{employee-configuration,salary-accrual,payroll-run,hr-payroll-report}-service.js`
- `src/utils/approval-{applier,request-edit}.js`, payroll approval preview provider
- Existing HR forms, reports, global searchable select and payroll screen

## Rollout

Apply source and the new migration together through the normal deployment process. No live database writes, employee configuration, payments, commits or deployment are part of implementation validation.
