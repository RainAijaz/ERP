# Salary review tracking

Run the normal database migrations before starting the updated application. Migration `20261102_000132_worker_salary_reviews.js` follows the guaranteed-pay migration and creates the review history table and latest-review indexes. No existing salaries or payments are changed.

Administrators can mark a checked-through date in Employee Ledger, Labour Ledger, Employee Balances (summary and details), and Labour Balances. The balances action is in the menu beside the person's name. Clicking the status opens the last review's date, administrator and date of checking. Other report users can read this metadata; a direct restricted-user submission follows the existing approval queue and requires an administrator's approval.

Reviews apply to the exact branch selection loaded in the report. An ALL-branches review is separate from a review of selected branches. A user must have report-load access and access to the person and branches before requesting a review. A check cannot be dated after the loaded report end or today.

Both balances reports reuse the global searchable multi-select controls for Review status and Checked by. Empty selections mean ALL; ALL is exclusive, and resetting the report restores ALL. Needs checking includes never checked, checked only through an earlier date, and recheck needed. Checked means reviewed through the As on date without a change to the reviewed sources. Totals are calculated after applying these filters.

Each check appends a history row, preserving its reviewer, requester, timestamp, branch scope and source fingerprint. Fingerprints are calculated in one database statement for the report's people, with each reviewed period's own cutoff. They cover the ledger's scoped voucher lines (including DCV labour attribution), staff-credit GL entries, commissions, salary/guarantee histories, allowances, payroll runs and worker branch mappings. Later-dated transactions do not invalidate an earlier check. Changes inside a checked period are shown as Recheck needed, including offsetting transactions whose net balance is unchanged.

The save and approval paths verify the fingerprint of the report originally reviewed and the previous review ID. Concurrent submissions are serialized per person and branch selection. Stale submissions require reloading and reviewing the report again. The review and activity log are written in one transaction. Approval requests are read-only in the approval preview; an approver cannot silently change the reviewed date or scope.

Report figures and review fingerprints are read from the same read-only, repeatable-read database transaction. A concurrent edit during page loading therefore cannot mark unseen values as reviewed. The report helpers share that transaction, including salary, allowances, commissions and financial entries.

Rollback refuses to remove a table containing review history. Preserve that history when planning a rollback. Temporary validation files are outside application source and excluded from Git.
