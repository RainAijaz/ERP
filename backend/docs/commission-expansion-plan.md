# Commission expansion: compatibility and verification plan

Status: implemented in the workspace on 3 November 2026. This document retains the design and historical planning findings; see `commission-expansion-implementation.md` for the delivered behavior, validation and activation requirements. Real employee pay terms were not changed by this work.

## Outcome

Configure one employee's sales, production and other supported commissions in one session. Use independent, collapsible cards with shared default dates, searchable multi-selection, readable summaries and one Save all action. Add Product Category and true Article selection to product scopes and exclusions. Preserve existing rules, approvals, effective dates, ledger accounting and payroll protections.

No test suite can guarantee the absence of every issue. Release requires the explicit checks below, including real database, browser and financial reconciliation checks; pure calculation tests alone are insufficient.

## Existing behavior that must survive

| Area | Current implementation / compatibility requirement |
| --- | --- |
| Product hierarchy | `items.product_type_id` references `erp.product_types`, displayed as Product Category. Reuse it; do not create a second category master. Articles are `erp.items`; SKUs are children through `erp.variants`. |
| Scope resolution | `commission-rule-resolver.js` chooses one rule per commission basis, with branch-specific rules before unpinned rules, then SKU > SUBGROUP > GROUP > ALL. Inherited SKU copies are fallbacks, not explicit overrides. |
| Rate types | Preserve PER_PAIR and proportional PER_DOZEN calculations and all supported commission bases. Different bases can earn together; overlapping product scopes for the same basis must not add together. |
| Eligibility | `commission-eligibility-service.js` owns branches, quality, source workers, department, stage, exclusions and packed/loose policy. Exclusions on applicable broad rules also constrain special rates. |
| Defaults | Existing sales rules remain packed-only unless explicitly changed. Legacy SKU rules can inherit their broad rule's quantity policy. Return reversal and Replace existing article rates retain existing values/defaults. |
| Rule history | `commission-rules-service.js` supersedes effective-dated versions. Exclusions and quantity policy change a version; worker/stage/branch conditions identify earning scopes. Do not create duplicate earning scopes when exclusions are edited. |
| Storage | SALESMAN_SALE uses SKU commission metadata plus one auto EMPLOYEE sales-voucher line. BRANCH_SALE, TRANSFER and production types use `erp.commission_ledger`. Do not move salesman earnings into the other store or count both. |
| Recalculate | `commission-recalc-service.js` resolves rules using each approved voucher's date/branch. Preview is read-only; apply rebuilds server-side. Clearing unmatched earnings is opt-in. Current limit is 500 writes. PARTY is deliberately not computable. |
| Approval replay | Existing single-SKU, SKU_MULTI_UPSERT, bulk scope and COMMISSION_RECALC payloads remain supported. Current recalc approval rebuilds rows and skips amounts that changed since review; legacy partial-success semantics must be characterized, not silently rewritten. |
| Reports | Employee ledger/balances combine the two commission stores with salary, allowances, payments, purchases and advances. The existing Commission Ledger report reads `commission_ledger` only; do not assume it already includes salesman earnings. |
| Payroll | Finalized payroll and immutable snapshots must remain protected. Guaranteed monthly pay and salary-review fingerprints consume earnings too and belong in the regression scope. |

Some existing route comments still say rules are not effective-dated; the service does use effective dates. Tests must target runtime behavior, not those stale comments.

## Existing defect found by the new tests

`integration.test.cjs` reproduces an existing clearing defect: after a salesman rule is deactivated, explicit clearing sets the auto employee line's amount/rate/directions to zero but retains its old SKU `meta.commission` breakdown. `enrichSalesVoucherLines` returns the original line when no breakdown matches, so `planSalesmanCommissionRecomputeTx` reads that stale object as the next breakdown. This can make product drill-down disagree with the employee amount. Keep the assertion failing until corrected; it is a release blocker, not an expected feature-contract failure.

The fix should derive commission from clean calculation input (or explicitly track whether a fresh breakdown exists), then remove only the obsolete commission key while retaining all other metadata. Test full removal, one excluded line among still-earning lines, return reversal, repeat clear, approval replay and closed-period rollback. This was diagnosed during planning and is now fixed by the implementation; the regression assertion passes.

The existing manual recalc endpoint also rebuilds from filters at apply time without a reviewed-state hash. This prevents forged write descriptors, but does not promise that the numbers still equal an earlier browser preview. The new review flow must bind a server-generated fingerprint to both totals and matching context; test this explicitly instead of assuming the old endpoint already provides it.

## Product model and conflict policy

1. Add `CATEGORY` and `ARTICLE` scopes with category and item foreign keys, indexes and exact-one-target checks. Keep all existing IDs, scope values, source_rule_id links, eligibility keys and rows. Update both fresh-install DDL and the next available forward migration after checking the current migration sequence. No automatic data relabeling or conversion.
2. Use a real article ID for an article rule. It dynamically covers every eligible child SKU, including SKUs added later. Preserve explicit SKU rates as advanced exceptions. Existing SKU exclusions continue excluding only that SKU; they must never silently broaden into whole-article exclusions.
3. Add `excluded_category_ids` and `excluded_article_ids` beside current exclusion fields. Validate/deduplicate all IDs with the shared service, enforce relevant FG/SFG item types and scoped access, and show unknown/deleted IDs as validation errors rather than silently ignoring them.
4. Preserve the existing outer branch priority. Within each branch tier use SKU > ARTICLE > SUBGROUP > GROUP > CATEGORY > ALL. This retains all existing pairwise precedence. Display that broader rates are fallbacks; matching categories and groups do not add commissions for the same basis.
5. Category and group are separate classifications, not an assumed category-parent/group-child tree. Show overlap warnings where both match. Reject duplicate/conflicting equal-priority cards for the same earning scope, effective window and basis. Normalize selection order before conflict checks. Detect intersections between worker/stage/branch sets, not just identical arrays.
6. Values within a selector use OR (category A or B); distinct conditions use AND (selected products, eligible branch, worker and stage). Exclusions override inclusion and specific-rate exceptions, but an unrelated product rule must not suppress earnings.
7. A card selects one Apply on kind and many values. Mixed kinds use separate cards so their rates, exclusions and dates are unambiguous. Source switching clears inapplicable fields. Whole-dozen rounding and loose-only policy are out of scope; retain proportional dozen calculation and the existing two quantity choices.
8. Review quantity-policy inheritance when category/article rules are introduced: a legacy SKU inherits from its nearest applicable broad quantity rule; an explicitly set SKU/article policy wins. Keep existing group/subgroup inheritance results identical when no new scopes exist.

## Shared service changes, in dependency order

### 1. Freeze a compatibility baseline

Capture fixture rule versions, preview amounts, posted commission details, employee ledger/balances, payroll preview, GL and stock entries. Include legacy inherited SKU copies and deliberately edited overrides. Run in a dedicated synthetic database, never the configured development database. Record exact test revision and environment.

### 2. Expand product context and schema

Extend eligibility normalization/reference validation, `matchesProduct`, exclusions, option searches and the common rule resolver. Add category/item identifiers to the common product context and stored posting snapshots for sales, transfer, FG/SFG completion and stage completion. Preserve current snapshots; do not overwrite historical classifications during recalculation.

Old snapshots do not contain the new classification fields. Use their captured fields where present and define an explicit legacy fallback to current item/category where absent. Show a warning in recalc/approval previews when new scopes rely on that fallback. Former category membership cannot be reconstructed from today's master. Never claim those fallback classifications are historically exact.

### 3. Add an atomic batch service

Create a service in `src/services/hr-payroll/` for normalize -> validate every card -> resolve access/overlap -> preview -> apply. Controllers only call services and format localized responses. Reuse existing supersession, eligibility, audit, payroll guards and recalculation functions rather than a second calculator.

One employee per batch; each card has its own source, scope, selections, rate, eligibility and explicit date overrides. Shared dates are defaults copied into cards, not mutable references. Keep legacy multi-employee SKU entry available separately. Bound card counts, selection counts and request size server-side; paginated searches/coverage previews must not submit only the visible page.

Save all runs in one transaction: either every card and its permitted recalculation succeeds or none does. Lock the employee/affected identities consistently with payroll guards. Use a request idempotency key bound to user + employee + canonical payload hash; retry returns the original result, and reusing the key with different content is rejected. Validate that rules have not changed since the reviewed preview.

Apply all rule changes first, then recalculate merged affected employee/type/date ranges once against the final rules. Never recalculate after each intermediate card. Do not broaden recalculation past authorized branches. If the write limit or closed payroll prevents an atomic save, return a clear reviewable error before partial changes; keep the existing legacy endpoint behavior unchanged until separately migrated.

### 4. Extend the existing approval gate

Use `req.user.permissions` through the existing screen-approval gate. Authorized changes apply immediately; restricted writes queue one versioned batch request with all cards and localized success feedback. Queueing has zero effect on rules, voucher commission, reports or payroll. Branch/entity validation remains required before queueing; a queued request cannot bypass data access.

Dispatch the new batch mode before generic employee/scope inference in `approval-applier.js`. Preview every card, resolved products, dates, exclusions, explicit exceptions and financial impact. Store slim validated intentions plus reviewed fingerprint, not client write descriptors. Approval revalidates current permissions/access, references, snapshots, conflicts, payroll closure and reviewed state, then calls the same batch service transaction. New batches reject stale reviews atomically; keep old payload replay and old recalc partial-match semantics compatible.

Reject/withdraw changes no earnings. Double approve, concurrent saves and network retries must not duplicate history or earnings. Activity logs identify requester, approver, batch, employee, cards and affected vouchers through the existing audit path; verify persisted logs, not merely the call to queueAuditLog.

Proposed test-first HTTP contract (new endpoints only):

| Endpoint | Payload/result |
| --- | --- |
| POST `/hr-payroll/employees/commissions/batch-preview` | `{version:1, employee_id, defaults:{effective_from,effective_to}, cards:[...]}`; returns a 64-character SHA-256 `preview_hash`, normalized card summaries and financial preview; writes nothing. |
| POST `/hr-payroll/employees/commissions/batch-save` | Same payload plus `preview_hash` and `idempotency_key`; 200 for direct application, 202 with `approval_request_id` for queued application, 400 for invalid cards, 409 for stale preview or changed reuse of an idempotency key. |
| Versioned queue payload | `mode: COMMISSION_BATCH_V1`, complete normalized cards, reviewed fingerprint and requester/access context. Old modes remain readable. |

Each card has a stable `card_id`, commission_type, apply_on, the matching `category_ids` / `article_ids` / `group_ids` / `subgroup_ids` / `sku_ids`, commission_basis, rate_type, value, reverse_on_returns and eligibility. Dates override shared defaults only when explicit. The executable batch contract fixes these names so UI, server and approval replay cannot evolve into incompatible payloads.

### 5. Build the compact UI on existing components

Use the global HR modal/form classes and shared searchable-select.js. Keep employee and default dates at the top, one expanded card, collapsed plain-language summaries, Add/Duplicate/Remove and Save all. Exclusions and SKU exceptions are collapsed. Show errors on their card and a concise overall summary; a failed save preserves entered values. Clone/reset must not share selector state, handlers, IDs, cache or dependent field values.

English/Urdu keys must be added to the existing localization mechanism. Use mobile cards/scrolling for previews; preserve focus and Enter behavior in editable voucher-style rows through the existing navigation partial where such rows are used. Do not invent a new voucher/report layout or custom dropdown implementation.

### 6. Carry changes through postings, recalc and reports

Use the expanded resolver in live sales, transfer, production and backdated recalculation. Capture matched rule, scope, rate unit, article/category context, quantity and exclusions for explanation. Preserve the two storage models and natural keys. Recalc must leave sales quantities/prices/discounts, sales header, GL, stock and payment records unchanged; only commission metadata/employee commission lines/commission-ledger rows may change.

Extend coverage, history, approval previews and report descriptions so new rules do not fall into unclassified buckets or disappear from lists. Keep report totals based on posted earnings, not today's rules. If adding salesman rows to the Commission Ledger report, make that an explicit, separately tested unification of both stores; never accomplish it by copying salesman earnings into commission_ledger.

Employee ledger opening + period credits - period debits must equal closing. Detail, collapsed groups, balances, exports and payroll previews must reconcile without duplicate nested totals. Verify guaranteed-pay top-ups are recomputed from earnings, saved finalized payroll remains unchanged and salary reviews correctly detect affected earnings. Global report filters initialize/reset to exclusive ALL through the shared filter mechanism.

## Regression / acceptance matrix

| ID | Cases | Required assertions |
| --- | --- | --- |
| LEGACY | SKU, inherited SKU, GROUP, SUBGROUP, ALL; branch-pinned and unpinned | Existing fixtures produce identical winning rules, money and dated versions when new features are unused. |
| PRODUCT | Several categories/articles per card; article with multiple variants/grades; newly added SKU | All intended children match once; other articles/categories do not; explicit SKU rates still win; unrelated exclusions do not leak. |
| EXCLUDE | Category/article/group/subgroup/SKU/grade exclusions; remove exclusion with future effective date | Exclusions constrain special rates; old dates retain old exclusions; removed exclusions do not leave old active versions suppressing earnings. |
| QUANTITY | Packed 24 pairs + loose 3; per pair and per dozen; partial dozen; return-only and mixed returns | Eligible quantities 24 or 27 as configured; Rs6/dozen gives Rs12 or Rs13.50 before returns; reversal toggles correct; no double UOM conversion. |
| SOURCES | Own sales, branch sales, FG transfer, FG completion, SFG completion, DCV stage; old header attribution and line attribution | Correct workers/stages/branches and stock-in quantities; no FG/SFG leakage. PARTY remains unsupported for recalc. |
| BATCH | Mixed card types, shared/overridden dates, multiple selections, duplicate/remove/reorder | Same result as equivalent valid individual saves, one transaction, no intermediate recalc, exact card error messages. |
| FAILURE | Empty payload, malformed JSON, injected IDs/search text, NaN/negative rates, excessive arrays, deleted references | Validation errors, no partial rules, no approval/earnings side effects; localized feedback. |
| ACCESS | Admin, create/edit-granted non-admin, restricted viewer, cross-branch/blocked employee | Correct immediate/queued path; no leakage or bypass through preview/search/recalc/approval; one persisted audit trail per operation. |
| APPROVAL | Queue/review/approve/reject/withdraw, pending isolation, duplicate decision, stale/new/deleted rule or product, finalized payroll during wait | No earning changes before approval; decision is authorized; stale new batch rejects atomically; legacy modes still replay correctly. |
| RECALC | Preview/read-only, arbitrary dates, inclusive ends, effective-date split, branch scope, drafts/rejected/void excluded | Fresh posting equals recalc; descriptors/client totals ignored; only approved vouchers in range change. |
| IDEMPOTENCY | Repeat apply, resubmit after timeout, concurrent recalc/save/approve | No duplicate auto employee lines, ledger rows, history or requests; posted amount stable after second run. |
| CLEAR | Rule removed/inactive, no new matching rule, grade exclusion introduced | Nonzero stored commission is not cleared without explicit option; confirmed clear zeros employee direction AND raw amount and removes stale breakdown. |
| STALE | Changed rules/earnings/attribution after preview, same-total different rule breakdown | Rebuild authoritative writes; new batch/recalc fingerprint detects changed reviewed context, not only total. Record existing legacy recalc semantics explicitly. |
| TRANSACTION | Mid-write DB failure, deadlock/timeout, one closed-period voucher in batch | Full rollback; no partial approval/rules/commission; user can retry safely. |
| FINANCIAL | Before/after GL, stock, sale line columns, unrelated employee/payment rows | Byte-for-byte invariant except allowed commission fields and audit metadata. |
| REPORTS | Employee ledger/balances, commission report, opening balances, detail/group totals, filtered branches/dates, exports | Exact posted amounts; salesman counted once; other commission counted once; no dropped category/article rows; global ALL/reset works. |
| PAYROLL | Open preview, closed run, weekly/monthly/daily salary, guarantee top-up, salary review | Only intended open earnings change; salary terms/advances/payments unchanged; closed snapshot immutable; guarantee floor not added twice. |
| UI | English/Urdu/mobile, keyboard, 10,000+ SKU catalogue, lazy multi-select, pagination | No duplicate controls/events; no full-catalogue load; off-screen selections survive; dependent values clear correctly. |
| NETWORK | Search/preview timeout, out-of-order responses, Save all response lost | Visible localized error; stale responses cannot overwrite state; save retries reuse idempotency key. |

## Test delivery in this planning change

Tests under `backend/tests/commission-compatibility/` are intentionally uncommitted. The README specifies safe commands and distinguishes passing baseline checks from red feature contracts. New-scope contracts intentionally fail against today's application until those additions exist; do not skip them and declare the new feature complete. The synthetic integration harness pins every database connection setting and checks server data directory, name and port before fixtures; it cannot use the normal ERP database. Notification senders are disabled in the harness only. Authentication/session delivery is outside the injected-user harness and requires a separate full-app login run before release.

Planning-stage evidence: 27/27 pure baseline checks passed; 14/15 isolated database/browser checks passed, with the stale salesman breakdown defect failing; 10/10 new-scope contracts and 6/6 new batch contracts are red because those features are not implemented. The integration suite covers the real services/routes/replay listed in its README; the broader matrix remains a release requirement, not a claim that every scenario is already automated.

## Release gates and rollout

1. Baseline suite green with exact financial fixture assertions; list every known gap/failure.
2. Additive migration verified on fresh install and populated synthetic legacy database; migration is repeat-safe through the normal migration runner, not repeated direct up calls. Existing rows/settings compare equal. Check indexes/query plans for category/article scope and exclusion matching.
3. New-scope contracts green; batch/approval/browser acceptance tests green for both direct and queued paths. No skipped required cases count as completion.
4. Recalc/live-posting parity, transactional rollback and employee ledger/balances/payroll reconciliation green for every computable source. Exercise the global report/filter/export UI and full-app login/approval routes too.
5. Read-only deployment preview of affected employees/vouchers; administrator reviews any historical category fallback and proposed clearing. Do not auto-recalculate all history on migration or startup.
6. Deploy schema then compatible application code in the project's normal release process. Introduce cards/new scope creation behind a capability check during transition. Existing payloads remain readable. Backdated changes retain the normal gated review, payroll locks and bounded recalculation rules.
7. Roll back new-feature exposure without deleting new rule history. Older app versions that cannot interpret CATEGORY/ARTICLE must not run once those rules are active; use a compatible application rollback or forward fix. Take the normal database backup before release.

Definition of done: every matrix row has executable evidence on the final implementation, old and new modes coexist, all financial invariants reconcile, localized global UI checks pass, and no outstanding test failure is described as verified functionality.
