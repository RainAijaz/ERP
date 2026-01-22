-- =====================================================================
-- 092_seeds.sql
-- PURPOSE:
--   Single consolidated seed file (CORE + COA) for ERP.
--
-- IMPORTANT SAFETY NOTES (READ THIS)
--   1) account_groups must have a UNIQUE constraint for ON CONFLICT to work:
--        - REQUIRED: UNIQUE (account_type, code)   (or make it a composite PK)
--      Otherwise: INSERT ... ON CONFLICT DO NOTHING will FAIL at runtime.
--
--   2) voucher_type seed MUST match your current DDL in 030_voucher_engine.sql.
--      Your voucher_type table has ONLY:
--        (code, name, requires_approval, affects_stock, affects_gl)
--      So this seed must NOT reference any non-existent columns like:
--        default_status_on_save   ❌ (does not exist)
--      "Default status on save" is an APP RULE when inserting voucher_header.status:
--        - requires_approval = true  -> save as PENDING
--        - requires_approval = false -> save as APPROVED
--      This is NOT a DB column in voucher_type in your current design.
--
--   3) Voucher-type codes MUST be consistent across:
--        - voucher_type seeds
--        - integrity_checks triggers
--        - module files (sales/purchase/inventory/production)
--      Example: your integrity checks validate purchase voucher types as PO/PI/PR.
--      Therefore, do NOT seed PURCHASE_ORDER/PURCHASE_INVOICE/PURCHASE_RETURN.
--      Seed them as:
--        PO / PI / PR ✅
--
-- DESIGN NOTES:
--   - This file is idempotent:
--       * ON CONFLICT DO NOTHING for dictionaries
--       * ON CONFLICT DO UPDATE for voucher_type + admin permissions
-- =====================================================================

SET search_path = erp;


-- =====================================================================
-- A) CORE SEEDS — REGISTRIES / DICTIONARIES
-- =====================================================================

-- ---------------------------------------------------------
-- A1) Role templates (baseline)
-- ---------------------------------------------------------
INSERT INTO erp.branches (code, name, is_active)
VALUES
  ('124', '124', true),
    ('207', '207', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO erp.role_templates (name, description)
VALUES ('Admin', 'System administrator (full approval authority)')
ON CONFLICT (name) DO NOTHING;


-- ---------------------------------------------------------
-- A2) Entity type registry
-- ---------------------------------------------------------
INSERT INTO erp.entity_type_registry (code, name, description)
VALUES
  ('VOUCHER',               'Voucher',     'Voucher header record'),
  ('ITEM',                  'Item',        'Item master record'),
  ('SKU',                   'SKU',         'SKU/Variant master record'),
  ('BOM',                   'BOM',         'Bill of Materials record'),
  ('PARTY',                 'Party',       'Customer/Supplier party'),
  ('ACCOUNT',               'Account',     'Chart of accounts record'),
  ('EMPLOYEE',              'Employee',    'Employee master record'),
  ('LABOUR',                'Labour',      'Labour master record'),
  ('STOCKCOUNTADJUSTMENT',  'Stock Count', 'Stock count session/document')
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------
-- A3) Audit action registry
-- ---------------------------------------------------------
INSERT INTO erp.audit_action_registry (code, name, description)
VALUES
  ('CREATE',  'Create',  'Entity created'),
  ('UPDATE',  'Update',  'Entity updated'),
  ('DELETE',  'Delete',  'Entity deleted'),
  ('SUBMIT',  'Submit',  'Submitted for approval'),
  ('APPROVE', 'Approve', 'Approved by checker'),
  ('REJECT',  'Reject',  'Rejected by checker'),
  ('CANCEL',  'Cancel',  'Cancelled/voided')
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------
-- A4) Approval request type registry
-- ---------------------------------------------------------
INSERT INTO erp.approval_request_type_registry (code, name, description)
VALUES
  ('MASTER_DATA_CHANGE', 'Entity Update',    'Maker-checker approval for master-data changes (Item/SKU/Party/Account/Employee/Labour)'),
  ('VOUCHER',            'Voucher Approval', 'Maker-checker approval for vouchers'),
  ('BOM',                'BOM Approval',     'Maker-checker approval for BOM')
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------
-- A5) Voucher types (transaction master)
-- NOTE:
--   This inserts ONLY the columns that exist in your voucher_type DDL:
--     (code, name, requires_approval, affects_stock, affects_gl)
--   No "default_status_on_save" column is referenced here.
--
-- ALSO IMPORTANT:
--   Purchase voucher type codes must be PO/PI/PR (to match your integrity checks).
-- ---------------------------------------------------------
INSERT INTO erp.voucher_type
  (code, name, requires_approval, affects_stock, affects_gl)
VALUES
  -- FINANCE / TREASURY
  ('CASH_VOUCHER',     'Cash Voucher',                           false, false, true),
  ('JOURNAL_VOUCHER',  'Journal Voucher',                        false, false, true),
  ('BANK_VOUCHER',     'Bank Voucher',                           false, false, true),

  -- PURCHASE (MATCHES INTEGRITY CHECKS: PO/PI/PR)
  ('PO',               'Purchase Order',                         false, false, false),
  ('PI',               'Purchase Invoice',                       true,  true,  true),
  ('PR',               'Purchase Return',                        false, true,  true),

  -- INVENTORY
  ('STN_OUT',          'Stock Transfer Note (Outward)',          false, true,  false),
  ('GRN_IN',           'Internal GRN (Incoming Transfer)',       false, true,  false),
  ('OPENING_STOCK',    'Opening Stock Voucher',                  true,  true,  true),
  ('STOCK_COUNT_ADJ',  'Stock Count Adjustment Voucher',         true,  true,  true),

  -- PRODUCTION
  ('PROD_SFG',         'Semi-Finished Production Voucher',       false, true,  true),
  ('PROD_FG',          'Finished Production Voucher',            false, true,  true),
  ('DCV',              'Department Completion Voucher (DCV)',    true,  true,  true),
  ('LABOUR_PROD',      'General Labour Production Voucher',      false, false, true),
  ('CONSUMP',          'Consumption Voucher',                    false, true,  true),
  ('PROD_PLAN',        'Production Planning',                    true,  false, false),
  ('LOSS',             'Abnormal Loss Voucher',                  true,  true,  true),

  -- SALES
  ('SALES_ORDER',      'Sales Order Voucher',                    false, false, false),
  ('SALES_VOUCHER',    'Sales Voucher',                          false, true,  true),

  -- RETURNABLES
  ('RDV',              'Returnable Dispatch Voucher',            false, false, false),
  ('RRV',              'Returnable Receipt Voucher',             false, false, false)

ON CONFLICT (code) DO UPDATE SET
  name              = EXCLUDED.name,
  requires_approval = EXCLUDED.requires_approval,
  affects_stock     = EXCLUDED.affects_stock,
  affects_gl        = EXCLUDED.affects_gl;


-- ---------------------------------------------------------
-- A6) Return reasons
-- ---------------------------------------------------------
INSERT INTO erp.return_reasons (code, description, affects_stock, is_active)
VALUES
  ('WRONG_SIZE',            'Wrong size delivered / ordered',                                true,  true),
  ('WRONG_COLOR',           'Wrong color / variant delivered',                               true,  true),
  ('WRONG_ITEM',            'Wrong SKU delivered',                                           true,  true),
  ('QUALITY_DEFECT',        'Manufacturing defect / quality issue',                          true,  true),
  ('DAMAGED_IN_TRANSIT',    'Courier / transit damage',                                     false, true),
  ('MISSING_ITEMS',         'Short shipment / missing items (claim/adjustment)',            false, true),
  ('OPENED_USED',           'Opened/used item returned (no restock allowed)',                false, true),
  ('CUSTOMER_CHANGED_MIND', 'Customer changed mind / no longer needed',                      true,  true),
  ('LATE_DELIVERY',         'Late delivery return request',                                  true,  true),
  ('OTHER',                 'Other',                                                        false, true)
ON CONFLICT (code) DO UPDATE SET
  description   = EXCLUDED.description,
  affects_stock = EXCLUDED.affects_stock,
  is_active     = EXCLUDED.is_active;


-- =====================================================================
-- B) CORE SEEDS — PERMISSION SCOPES
-- =====================================================================

INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description)
VALUES
  ('MODULE','administration','Branches/Users administration'),
  ('MODULE','master_data','Master data / setup'),
  ('MODULE','hr_payroll','HR & payroll'),
  ('MODULE','financial','Financial / accounting'),
  ('MODULE','purchase','Purchase'),
  ('MODULE','production','Production'),
  ('MODULE','inventory','Inventory'),
  ('MODULE','outward_returnable','Outward & returnable'),
  ('MODULE','sales','Sales')
ON CONFLICT (scope_type, scope_key) DO NOTHING;


-- =====================================================================
-- C) CORE SEEDS — ADMIN BASELINE PERMISSIONS
-- =====================================================================

INSERT INTO erp.role_permissions
  (role_id, scope_id, can_view, can_create, can_edit, can_delete, can_print, can_approve, can_post, can_unpost)
SELECT
  r.id,
  s.id,
  true, true, true, true, true, true, true, true
FROM erp.role_templates r
CROSS JOIN erp.permission_scope_registry s
WHERE lower(trim(r.name)) = 'admin'
ON CONFLICT (role_id, scope_id) DO UPDATE SET
  can_view    = EXCLUDED.can_view,
  can_create  = EXCLUDED.can_create,
  can_edit    = EXCLUDED.can_edit,
  can_delete  = EXCLUDED.can_delete,
  can_print   = EXCLUDED.can_print,
  can_approve = EXCLUDED.can_approve,
  can_post    = EXCLUDED.can_post,
  can_unpost  = EXCLUDED.can_unpost;


-- =====================================================================
-- D) COA SEEDS — ACCOUNT SUBGROUPS
-- IMPORTANT:
--   This requires UNIQUE (account_type, code) on erp.account_groups
--   (or a composite primary key), otherwise ON CONFLICT will fail.
-- =====================================================================

INSERT INTO erp.account_groups (account_type, code, name, is_contra) VALUES
('ASSET','cash_in_hand','Office Cash (Cash-in-Hand)',false),
('ASSET','bank','Bank',false),
('ASSET','bank_clearing','Bank Clearing / Undeposited Funds',false),
('ASSET','cash_with_salesman','Cash with Salesman',false),
('ASSET','accounts_receivable_control','Accounts Receivable (AR Control)',false),

('ASSET','inventory_rm','Inventory – Raw Materials',false),
('ASSET','inventory_sfg','Inventory – Semi-Finished',false),
('ASSET','inventory_fg','Inventory – Finished Goods',false),
('ASSET','inventory_transit','Inventory – Transit',false),

('ASSET','production_clearing','Production Clearing (WIP/Clearing)',false),

('LIABILITY','accounts_payable_control','Accounts Payable (AP Control)',false),
('LIABILITY','wages_payable','Wages Payable (Labour)',false),
('LIABILITY','salaries_payable','Salaries Payable (Employees)',false),
('LIABILITY','commission_payable','Commission Payable',false),
('LIABILITY','accrued_expenses_payable','Accrued Expenses Payable',false),
('LIABILITY','tax_payable','Tax Payable / Output Tax',false),

('LIABILITY','advances_from_customers','Advances from Customers',false),

('EQUITY','opening_balance_equity','Opening Balance Equity',false),
('EQUITY','owner_capital','Owner Capital',false),
('EQUITY','retained_earnings','Retained Earnings',false),
('EQUITY','owner_drawings','Owner Drawings (Withdrawals)',true),

('REVENUE','sales_revenue','Sales Revenue',false),
('REVENUE','other_income','Other Income',false),
('REVENUE','sales_returns','Sales Returns',true),
('REVENUE','sales_discounts','Sales Discounts',true),
('REVENUE','stock_adjustment_gain','Stock Adjustment Gain',false),

('EXPENSE','cogs_finished_goods','COGS – Finished Goods',false),
('EXPENSE','stock_adjustment_loss','Stock Adjustment Loss',false),
('EXPENSE','abnormal_loss_expense','Abnormal Loss Expense',false),
('EXPENSE','defected_return_expense','Defected Return Expense',false),
('EXPENSE','commission_expense','Commission Expense',false),
('EXPENSE','utilities_electricity','Electricity / Utilities Expense',false),
('EXPENSE','rent_expense','Rent Expense',false),
('EXPENSE','fuel_expense','Fuel Expense',false),
('EXPENSE','salary_expense','Salary Expense',false),
('EXPENSE','wages_expense','Wages Expense',false),
('EXPENSE','bank_charges','Bank Fees / Charges Expense',false)
ON CONFLICT DO NOTHING;
