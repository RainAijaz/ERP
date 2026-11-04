# Commission categories, articles and batch setup

Implemented in the workspace on 3 November 2026. Companion design: `commission-expansion-plan.md`. Publishing the code does not deploy the application, apply migrations to the configured ERP database or alter real employees' pay terms.

## Employee setup

After migration 134, Add Commission opens the existing global modal with an employee selector, shared effective dates and a commission card. Add, duplicate or remove cards; one card stays expanded. Choose one Apply on kind per card and several values in its searchable selector. Exclusions, date overrides, return reversal, replacement of matching SKU exceptions and other commission bases are in advanced settings. A card can ignore the shared end date explicitly.

Review all commissions shows the financial change before Confirm and save all. A failed save preserves the form. The same save reference is retained after a network failure so retrying cannot duplicate writes. Invalid cards identify their card; conflicting equal-priority earning scopes reject before writes.

The Individual / SKU setup link preserves the previous multi-employee/SKU workflow. Existing individual rules, including new category/article rules, remain editable through the established edit interface. Legacy percentage/invoice bases are preserved when editing instead of silently converting them to a quantity rate.

## Product and calculation behavior

- Product Category uses the existing `erp.product_types` master and `items.product_type_id`. Article uses `erp.items` and dynamically covers child SKUs, including future variants.
- SKU rules and SKU exclusions retain their exact meaning. Category and article exclusions are separate fields. Existing special SKU rates stay unless matching replacement is explicitly selected. Replacement is limited to the same earning identity; unrelated branch/worker/stage exceptions remain.
- Within each existing branch tier, precedence is SKU > Article > Subgroup > Group > Category > All. Different commission bases remain independent; matching product scopes do not duplicate one basis.
- Existing packed-only defaults, proportional dozen calculation, explicit quantity policies, source workers/stages, return reversal and effective history remain supported. The UI now says Include commission on / Packed quantities only / All sold quantities, including loose pairs.
- Salesman earnings stay on sales vouchers. Other computable sources stay in `commission_ledger`. Employee ledger/balances and payroll combine them once; the existing Commission Ledger report remains a view of its existing ledger store.
- The existing PARTY setting remains available under Other existing commission types; it still has no automatic calculator and is excluded from recalculation.

## Safety and approvals

Batch normalization, validation, previews and application live in `commission-batch-service.js`. The controller formats localized responses. Both direct and approved saves use that service, existing supersession, shared eligibility, the common calculator and transactional audit logging.

Direct saves honor create/edit permissions and existing approval policy. Restricted writes queue one versioned `COMMISSION_BATCH_V1` request, with zero earning changes before approval. All rule changes and recalculation writes apply together. The existing screen-approval helper now accepts an optional transaction and defers notifications until commit; its default callers retain their previous behavior.

Reviewed-state hashes cover source vouchers, rule versions, stock quantities, attribution, payroll closure and product classification, not only totals. New batch approvals reject stale state atomically and recheck actual maker/approver permissions, branches and entity restrictions. Approval uses a fresh permission read through the existing authentication loader. Legacy approval payloads continue working.

The browser recalculation flow supplies a reviewed-state hash as well. Legacy filters-only API/CLI callers retain server-side recomputation compatibility; they do not acquire the new browser's reviewed-state guarantee unless they send `review_version: 1` and its `review_hash`.

Payroll locks protect both new batches and the existing rule-persistence service. A payroll period finalized after a request was submitted blocks its approval without changing the saved snapshot. Repeated and simultaneous identical saves resolve to the same batch; a reused reference with different content rejects.

The stale salesman breakdown defect is fixed: a line that no longer earns loses its obsolete commission metadata while retaining unrelated metadata. Recalculation also refreshes changed breakdowns when the total stays equal. GL, stock, sales prices/quantities and payment records are outside commission recalculation writes.

The main release preserves existing explicit-recalculation behavior for legacy individual and bulk rule saves. New commission cards apply their reviewed, bounded recalculation atomically. Existing zero-rate matches, reassigned-salesman handling, shadowed/past rate indicators, labour Grade B settings, and sales-voucher retry protection are retained.

New live sales, transfer and production postings retain article/category context. Historical lines missing those fields use current classification and show a review warning; the system cannot reconstruct an uncaptured historical category. Existing snapshots are preserved.

## Limits

One employee, up to 20 cards, up to 500 values per selector and 1,000 selected scope values per batch. Searches return at most 50 matches. Financial application retains the 500-write limit; preview scanning is also bounded. Large/backdated changes require a narrower effective range. No catalogue is preloaded into the card interface.

Clearing unmatched nonzero earnings requires explicit confirmation. The reviewed preview and save must contain the same clearing choice. Existing specialized branch exceptions and unrelated earning scopes are preserved by default.

## Validation

Final validation: **37/37 unit/contract checks and 41/41 isolated database/browser scenarios passed (78 total, zero failures/skips)**. Twenty-five server scripts and six templates compiled; targeted whitespace checks passed. See `backend/tests/commission-compatibility/README.md` and `.tmp-commission-compatibility/integration-features.log` for commands/evidence. Tests are intentionally uncommitted.

Verified scenarios include both storage models; sales/branch/transfer/FG/SFG/stage commissions separately and together in one batch; multiple categories/articles; future SKUs; preserved explicit SKU rates; effective-date/exclusion history; packed/loose quantities and returns; employee ledger/balances/openings, payroll and guarantee pay; read-only preview, stale-review rejection and concurrency; admin/granted/restricted writes; real approval/rejection/withdrawal routes; duplicate decisions; closure or revoked permissions during pending approval; transaction rollback; unchanged GL/stock/sale fields; invalid/injected inputs; empty form/timeout behavior; complete browser save; English/Urdu/mobile cards; and populated legacy-schema upgrade.

The harness uses a separate PostgreSQL cluster and synthetic database, verifies its actual identity before writes, suppresses notification delivery, and retains logs/screenshots. Actual login/session/CSRF delivery, deployment, all report exports and a fresh large-catalogue load benchmark are not claimed by this harness. Existing global report/filter structures were retained; no separate report layout or filter engine was introduced.

## Activation

Apply `20261103_000134_commission_categories_articles_batches.js` through the normal migration process after its existing dependencies, then restart the backend. Fresh-install DDL includes the scope columns and batch receipt table; migration 134 adds/validates the scope constraints and indexes for existing installations.

No migration/startup process recalculates all company history automatically. Backdated saves use the reviewed, bounded transaction. No real pay terms were configured as part of implementation.

Rollback is guarded: do not run older application code once category/article rules or new exclusions are in use. The migration refuses removal when new rule/exclusion/batch history exists. Use a compatible application rollback or forward correction rather than deleting commission history.
