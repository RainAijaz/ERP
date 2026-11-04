# SFG transfers with pending cost — 4 November 2026

Implemented on `codex/sfg-zero-cost-transfers` in the isolated checkout
`__codex_sfg_zero_cost`. The original working checkout and other branches have
been preserved. No live-site deployment was performed.

## Resulting behavior

- Existing source stock cost or last approved receipt cost takes priority.
- The existing approved-BOM fallback remains available for zero or negative source
  stock. A missing/unapproved BOM or incomplete recipe cost no longer blocks a
  transfer: the server records zero, `cost_source: COST_PENDING` and
  `cost_pending: true`. Positive on-hand stock without usable recorded value also
  moves at zero, without inventing a historical acquisition cost from today's BOM.
- Administrator transfers can post immediately. Restricted transfers and receipts
  still queue for approval. Existing negative-stock policies and audit logging
  continue to apply. Client-supplied costs and flags are ignored.
- Approval recalculates cost before stock is posted; a newly available documented
  cost clears the pending flag. Receipt retains the approved dispatch cost,
  including zero. Adding a BOM after dispatch does not reprice that dispatch or
  its receipt automatically.
- Saved dispatch and receipt rows show a localized "Cost pending (0)" label.
  Existing zero-cost dispatches can also be received. Transfer quantities,
  rejected quantities, edits and deletions use the existing global stock logic.
- Explicit historical valuation reconciliation clears the pending marker when it
  establishes a documented cost. No historical reconciliation is run by this change.
- Only the known incomplete-BOM domain error can fall back to zero. Database and
  unexpected failures still abort and roll back; invalid negative receipt costs
  remain errors. Strict BOM-cost callers retain their existing validation.

Zero is provisional: inventory and downstream production values may remain
understated until a separate valuation correction is performed.

## Verification

49 Playwright checks passed against the local ERP database, using rollback-only
fixtures. No test business records were retained.

- 36 checks in `backend/tests/e2e/sfg-zero-cost-transfer.spec.js`: administrator
  dispatch/receipt without a BOM; pending and incomplete BOMs; positive unvalued
  stock; known-cost priority; repeated negative stock; creator/restricted/approval
  flows; rate changes before approval; receipt after a later BOM approval; rejected
  quantities; edit/delete rollback; explicit reconciliation; production material
  and labour costing; nested/cyclic BOMs; invalid/empty/injection-shaped inputs;
  database and simulated network timeouts; English/Urdu labels in both voucher modes.
- 13 existing checks in `backend/tests/e2e/sfg-transfer-valuation.spec.js`:
  source-cost preservation, approval routing, historical/WIP reconciliation,
  repeatability, stale-preview and quantity-drift safeguards, negative-stock cost
  handling and unchanged FG selling-price transfers. Two old assertions requiring
  rejection of zero-cost transfers were excluded because the new policy replaces
  that behavior and the new suite tests the replacement.
- JavaScript syntax and patch whitespace checks passed.

Test files and outputs remain local only. They are excluded from the patch and
have not been committed or pushed. No database migration or dependency is needed.

## Applying the patch

The sibling deployment package contains `sfg-zero-cost.patch`, with changes to
five source files. Check it against the target checkout before applying; do not
overwrite unrelated server customizations. Restart the application's normal web
process after deployment. No live voucher was created, changed or confirmed.

The changes are implemented and tested locally. Deployment remains a separate step.

[SYSTEM-STATUS: GATEKEEPER-ACTIVE]
