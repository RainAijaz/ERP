# Stock counts and production labour filters

Inventory → Reports → **Stock Count / Adjustment Details**
(`/reports/inventory/stock-count-details`) lists warehouse and department WIP
`STOCK_COUNT_ADJ` vouchers. Filters include dates, permitted branches, stock
types, approval statuses, reasons, departments, vouchers and articles. Multi
selects use the shared searchable control and exclusive All selection.

The report compares saved system/count snapshots with actual posted ledger
movements. Pending and rejected vouchers contribute no posted movements.
Warehouse movements are aggregated by voucher line; WIP movements are
aggregated by voucher, department and SKU and displayed once. Missing snapshots
or missing postings are explicitly identified. Quantity totals remain separate
by stock type and unit. Cost columns use posted ledger costs, never selling
rates, and require the report's cost-field permission. Voucher links require
report details and voucher view permission and are limited to the current
branch because stock-count voucher numbers are branch-specific.

Migration `20261103_000133_stock_count_adjustment_details.js` registers the new
report permission scope `stock_count_details`. Grant the usual report rights
through Administration → Permissions for non-admin users who need access.

Production → Reports → **Production Control** and **Consumption** support one,
several or all labours, plus Unassigned / undetermined. Labour options include
historical approved vouchers so inactive workers remain reportable. Production
Control uses per-line DCV workers before header fallbacks and defaults its stage
scope to All. When voucher rows are folded into one entered article, their
worker labels are combined without multiplying the article quantity.

Consumption is attributed only when all matching approved source DCV rows
resolve to one worker, using source SKU, department and stage when available.
Shared or uncertain consumption stays unassigned and is never copied into
multiple workers' totals. Planning and department stock balances are not
assigned to labours because those records do not establish worker ownership.
Consumption and stock-count reports use read-only repeatable-read snapshots.

Verification: fictional records in a separate PostgreSQL instance cover
warehouse/WIP movements, split ledger postings, pending/rejected vouchers,
mixed units, missing postings, branch and cost permissions, historical workers,
single/multiple/All labour selection and ambiguous consumption. Browser checks
exercise actual routes, views and global controls in English/Urdu, desktop and
mobile, as well as invalid input, CSRF and simulated database failures. Test
scripts remain ignored local files and must not be committed.
