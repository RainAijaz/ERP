# Basic Info Groups E2E Scenario Catalog

Scope: Master Data -> Basic Information -> Groups pages.

## 1) Product Groups (`/master-data/basic-info/product-groups`)

1. Page loads with HTTP 200.
2. Add button is visible.
3. Download and print buttons are visible.
4. Create modal opens.
5. Create modal closes with cancel.
6. Empty required submit is blocked by form validation.
7. Relevant controls render: name, name_ur, item_types multi-checkbox.
8. Create record A succeeds.
9. Create record B succeeds.
10. Edit modal pre-fills record A data.
11. Edit save updates record A.
12. Search finds edited record A.
13. Search miss shows no matching rows.
14. Toggle deactivates record A.
15. Inactive filter shows deactivated record A.
16. Active filter hides deactivated record A.
17. Toggle re-activates record A.
18. Relevance check: item_types selection persists in edit modal.
19. Hard delete removes record B.
20. Hard delete removes record A.

## 2) Product Subgroups (`/master-data/basic-info/product-subgroups`)

1. Page loads with HTTP 200.
2. Add button is visible.
3. Download and print buttons are visible.
4. Create modal opens.
5. Create modal closes with cancel.
6. Empty required submit is blocked by form validation.
7. Relevant controls render: group_id, name, name_ur, item_types.
8. Create record A succeeds.
9. Create record B succeeds.
10. Edit modal pre-fills record A data.
11. Edit save updates record A.
12. Search finds edited record A.
13. Search miss shows no matching rows.
14. Toggle deactivates record A.
15. Inactive filter shows deactivated record A.
16. Active filter hides deactivated record A.
17. Toggle re-activates record A.
18. Relevance check: selected group_id persists in edit modal.
19. Hard delete removes record B.
20. Hard delete removes record A.

## 3) Product Types (`/master-data/basic-info/product-types`)

1. Page loads with HTTP 200.
2. Add button is visible.
3. Download and print buttons are visible.
4. Create modal opens.
5. Create modal closes with cancel.
6. Empty required submit is blocked by form validation.
7. Relevant controls render: name and name_ur.
8. Create record A succeeds.
9. Create record B succeeds.
10. Edit modal pre-fills record A data.
11. Edit save updates record A.
12. Search finds edited record A.
13. Search miss shows no matching rows.
14. Toggle deactivates record A.
15. Inactive filter shows deactivated record A.
16. Active filter hides deactivated record A.
17. Toggle re-activates record A.
18. Relevance check: auto-generated code is visible and readonly on edit.
19. Hard delete removes record B.
20. Hard delete removes record A.

## 4) Sales Discount Policies (`/master-data/basic-info/sales-discount-policies`)

1. Page loads with HTTP 200.
2. Add button is visible.
3. Download and print buttons are visible.
4. Create modal opens.
5. Create modal closes with cancel.
6. Empty required submit is blocked by form validation.
7. Relevant controls render: product_group_id and max_pair_discount.
8. Create record A succeeds.
9. Create record B succeeds.
10. Edit modal pre-fills record A data.
11. Edit save updates record A.
12. Search finds edited record A.
13. Search miss shows no matching rows.
14. Toggle deactivates record A.
15. Inactive filter shows deactivated record A.
16. Active filter hides deactivated record A.
17. Toggle re-activates record A.
18. Relevance check: policy ties to selected product_group and decimal discount persists.
19. Hard delete removes record B.
20. Hard delete removes record A.

## 5) Party Groups (`/master-data/basic-info/party-groups`)

1. Page loads with HTTP 200.
2. Add button is visible.
3. Download and print buttons are visible.
4. Create modal opens.
5. Create modal closes with cancel.
6. Empty required submit is blocked by form validation.
7. Relevant controls render: party_type, name, name_ur.
8. Create record A succeeds.
9. Create record B succeeds.
10. Edit modal pre-fills record A data.
11. Edit save updates record A.
12. Search finds edited record A.
13. Search miss shows no matching rows.
14. Toggle deactivates record A.
15. Inactive filter shows deactivated record A.
16. Active filter hides deactivated record A.
17. Toggle re-activates record A.
18. Relevance check: party_type options include CUSTOMER, SUPPLIER, BOTH.
19. Hard delete removes record B.
20. Hard delete removes record A.

## 6) Account Groups (`/master-data/basic-info/account-groups`)

1. Page loads with HTTP 200.
2. Add button is visible.
3. Download and print buttons are visible.
4. Create modal opens.
5. Create modal closes with cancel.
6. Empty required submit is blocked by form validation.
7. Relevant controls render: account_type, name, name_ur.
8. Create record A succeeds.
9. Create record B succeeds.
10. Edit modal pre-fills record A data.
11. Edit save updates record A.
12. Search finds edited record A.
13. Search miss shows no matching rows.
14. Toggle deactivates record A.
15. Inactive filter shows deactivated record A.
16. Active filter hides deactivated record A.
17. Toggle re-activates record A.
18. Relevance check: account_type options include ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE.
19. Hard delete removes record B.
20. Hard delete removes record A.

## 7) Departments (`/master-data/basic-info/departments`)

1. Page loads with HTTP 200.
2. Add button is visible.
3. Download and print buttons are visible.
4. Create modal opens.
5. Create modal closes with cancel.
6. Empty required submit is blocked by form validation.
7. Relevant controls render: name, name_ur, is_production.
8. Create record A succeeds.
9. Create record B succeeds.
10. Edit modal pre-fills record A data.
11. Edit save updates record A.
12. Search finds edited record A.
13. Search miss shows no matching rows.
14. Toggle deactivates record A.
15. Inactive filter shows deactivated record A.
16. Active filter hides deactivated record A.
17. Toggle re-activates record A.
18. Relevance check: is_production toggle persists after edit.
19. Hard delete removes record B.
20. Hard delete removes record A.

## 8) Production Stages (`/master-data/basic-info/production-stages`)

1. Page loads with HTTP 200.
2. Add button is visible.
3. Download and print buttons are visible.
4. Create modal opens.
5. Create modal closes with cancel.
6. Empty required submit is blocked by form validation.
7. Relevant controls render: name, dept_id, is_active.
8. Create record A succeeds.
9. Create record B succeeds.
10. Edit modal pre-fills record A data.
11. Edit save updates record A.
12. Search finds edited record A.
13. Search miss shows no matching rows.
14. Toggle deactivates record A.
15. Inactive filter shows deactivated record A.
16. Active filter hides deactivated record A.
17. Toggle re-activates record A.
18. Relevance check: dept_id dropdown only includes active production departments.
19. Hard delete removes record B.
20. Hard delete removes record A.
