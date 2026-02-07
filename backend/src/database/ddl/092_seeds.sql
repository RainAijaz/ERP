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
  ('STOCKCOUNTADJUSTMENT',  'Stock Count', 'Stock count session/document'),
  ('UOM',                   'Unit of Measure', 'Basic info: units'),
  ('SIZE',                  'Size',        'Basic info: sizes'),
  ('COLOR',                 'Color',       'Basic info: colors'),
  ('GRADE',                 'Grade',       'Basic info: grades'),
  ('PACKING_TYPE',          'Packing Type','Basic info: packing types'),
  ('CITY',                  'City',        'Basic info: cities'),
  ('PRODUCT_GROUP',         'Product Group','Basic info: product groups'),
  ('PRODUCT_SUBGROUP',      'Product Subgroup','Basic info: product subgroups'),
  ('PRODUCT_TYPE',          'Product Type','Basic info: product types'),
  ('PARTY_GROUP',           'Party Group', 'Basic info: party groups'),
  ('ACCOUNT_GROUP',         'Account Group','Basic info: account groups'),
  ('DEPARTMENT',            'Department',  'Basic info: departments'),
  ('UOM_CONVERSION',        'UOM Conversion','Basic info: unit conversions'),
  ('BRANCH',                'Branch',      'Administration: branches'),
  ('USER',                  'User',        'Administration: users'),
  ('ROLE',                  'Role',        'Administration: roles'),
  ('PERMISSION',            'Permission',  'Administration: permissions')
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
-- A5b) Approval policy for voucher creation
-- ---------------------------------------------------------
INSERT INTO erp.approval_policy (entity_type, entity_key, action, requires_approval)
SELECT 'VOUCHER_TYPE', code, 'create', requires_approval
FROM erp.voucher_type
ON CONFLICT (entity_type, entity_key, action) DO UPDATE SET
  requires_approval = EXCLUDED.requires_approval,
  updated_at = now();


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
  ('MODULE','sales','Sales'),
  ('MODULE','reports','Reports')
ON CONFLICT (scope_type, scope_key) DO NOTHING;

-- Ensure module grouping for module-level entries
UPDATE erp.permission_scope_registry
SET module_group = 'Modules'
WHERE scope_type = 'MODULE' AND (module_group IS NULL OR module_group = 'Other');

-- =====================================================================
-- B1) SCREEN SCOPES — ADMINISTRATION + MASTER DATA (CODE-DRIVEN)
-- =====================================================================
INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
VALUES
  -- Administration
  ('SCREEN','administration.branches','Branches', 'Administration'),
  ('SCREEN','administration.users','Users', 'Administration'),
  ('SCREEN','administration.roles','Roles', 'Administration'),
  ('SCREEN','administration.permissions','Permissions', 'Administration'),
  ('SCREEN','administration.approvals','Approvals', 'Administration'),
  ('SCREEN','administration.approval_settings','Approval Settings', 'Administration'),
  ('SCREEN','administration.audit_logs','Activity Log', 'Administration'),

  -- Master Data > Basic Info
  ('SCREEN','master_data.basic_info.units','Units', 'Master Data'),
  ('SCREEN','master_data.basic_info.sizes','Sizes', 'Master Data'),
  ('SCREEN','master_data.basic_info.colors','Colors', 'Master Data'),
  ('SCREEN','master_data.basic_info.grades','Grades', 'Master Data'),
  ('SCREEN','master_data.basic_info.packing_types','Packing Types', 'Master Data'),
  ('SCREEN','master_data.basic_info.cities','Cities', 'Master Data'),
  ('SCREEN','master_data.basic_info.product_groups','Product Groups', 'Master Data'),
  ('SCREEN','master_data.basic_info.product_subgroups','Product Subgroups', 'Master Data'),
  ('SCREEN','master_data.basic_info.product_types','Product Types', 'Master Data'),
  ('SCREEN','master_data.basic_info.party_groups','Party Groups', 'Master Data'),
  ('SCREEN','master_data.basic_info.account_groups','Account Groups', 'Master Data'),
  ('SCREEN','master_data.basic_info.departments','Departments', 'Master Data'),
  ('SCREEN','master_data.basic_info.uom_conversions','UOM Conversions', 'Master Data'),

  -- Master Data > Accounts/Parties
  ('SCREEN','master_data.accounts','Accounts', 'Master Data'),
  ('SCREEN','master_data.parties','Parties', 'Master Data'),

  -- Master Data > Products
  ('SCREEN','master_data.products.raw_materials','Raw Materials', 'Master Data'),
  ('SCREEN','master_data.products.semi_finished','Semi-Finished Products', 'Master Data'),
  ('SCREEN','master_data.products.finished','Finished Products', 'Master Data'),
  ('SCREEN','master_data.products.skus','SKU / Variants', 'Master Data'),

  -- Master Data > BOM
  ('SCREEN','master_data.bom','BOM', 'Master Data'),
  ('SCREEN','master_data.bom.approval','BOM Approval', 'Master Data'),
  ('SCREEN','master_data.bom.versions','BOM Versions', 'Master Data')
ON CONFLICT (scope_type, scope_key) DO NOTHING;

-- =====================================================================
-- B2) SCREEN SCOPES — REQUIREMENTS-DRIVEN (NOT YET IMPLEMENTED)
-- =====================================================================
INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
VALUES
  -- HR & Payroll
  ('SCREEN','hr_payroll.employees','Employees', 'HR & Payroll'),
  ('SCREEN','hr_payroll.labours','Labours', 'HR & Payroll'),
  ('SCREEN','hr_payroll.labour_rates','Labour Rates', 'HR & Payroll'),
  ('SCREEN','hr_payroll.commissions','Sales Commissions', 'HR & Payroll'),
  ('SCREEN','hr_payroll.allowances','Allowances', 'HR & Payroll'),

  -- Financial
  ('SCREEN','financial.period_control','Audit Freeze / Period Control', 'Financial')
ON CONFLICT (scope_type, scope_key) DO NOTHING;

-- =====================================================================
-- B3) VOUCHER SCOPES — REQUIREMENTS + VOUCHER TYPES
-- =====================================================================
INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
VALUES
  -- Financial
  ('VOUCHER','CASH_VOUCHER','Cash Voucher', 'Financial'),
  ('VOUCHER','BANK_VOUCHER','Bank Voucher', 'Financial'),
  ('VOUCHER','JOURNAL_VOUCHER','Journal Voucher', 'Financial'),

  -- Purchase
  ('VOUCHER','PO','Purchase Order', 'Purchase'),
  ('VOUCHER','PI','Purchase Invoice', 'Purchase'),
  ('VOUCHER','PR','Purchase Return', 'Purchase'),

  -- Inventory
  ('VOUCHER','STN_OUT','Stock Transfer Note (Outward)', 'Inventory'),
  ('VOUCHER','GRN_IN','Internal GRN (Incoming Transfer)', 'Inventory'),
  ('VOUCHER','OPENING_STOCK','Opening Stock Voucher', 'Inventory'),
  ('VOUCHER','STOCK_COUNT_ADJ','Stock Count Adjustment Voucher', 'Inventory'),

  -- Production
  ('VOUCHER','PROD_SFG','Semi-Finished Production Voucher', 'Production'),
  ('VOUCHER','PROD_FG','Finished Production Voucher', 'Production'),
  ('VOUCHER','DCV','Department Completion Voucher (DCV)', 'Production'),
  ('VOUCHER','LABOUR_PROD','General Labour Production Voucher', 'Production'),
  ('VOUCHER','CONSUMP','Consumption Voucher', 'Production'),
  ('VOUCHER','PROD_PLAN','Production Planning', 'Production'),
  ('VOUCHER','LOSS','Abnormal Loss Voucher', 'Production'),

  -- Sales
  ('VOUCHER','SALES_ORDER','Sales Order Voucher', 'Sales'),
  ('VOUCHER','SALES_VOUCHER','Sales Voucher', 'Sales'),

  -- Outward & Returnable
  ('VOUCHER','RDV','Returnable Dispatch Voucher', 'Outward & Returnable'),
  ('VOUCHER','RRV','Returnable Receipt Voucher', 'Outward & Returnable')
ON CONFLICT (scope_type, scope_key) DO NOTHING;

-- =====================================================================
-- B4) REPORT SCOPES — REQUIREMENTS-DRIVEN
-- =====================================================================
INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description, module_group)
VALUES
  -- Master Data / BOM Reports
  ('REPORT','bom_cost_margin','BOM Cost & Margin Register', 'Reports'),
  ('REPORT','bom_pending_approval','Pending BOM Approval & Change Log', 'Reports'),
  ('REPORT','bom_version_history','BOM Version History', 'Reports'),
  ('REPORT','semi_finished_dependency','Semi-Finished Dependency Report', 'Reports'),

  -- Financial Reports
  ('REPORT','cash_book','Cash Book', 'Financial'),
  ('REPORT','cash_voucher_register','Cash Voucher Register', 'Financial'),
  ('REPORT','bank_transactions','Bank Transactions Report', 'Financial'),
  ('REPORT','expense_analysis','Expense Analysis Report', 'Financial'),
  ('REPORT','production_overhead','Production Over-Head Cost Analysis', 'Financial'),
  ('REPORT','non_production_expense','Non-Production Expense Analysis', 'Financial'),
  ('REPORT','accrued_expenses','Accrued Expenses Report', 'Financial'),
  ('REPORT','profitability_analysis','Profitability Analysis Report', 'Financial'),
  ('REPORT','profit_and_loss','Profit and Loss Statement', 'Financial'),
  ('REPORT','journal_voucher_register','Journal Voucher Register', 'Financial'),
  ('REPORT','account_activity_ledger','Account Activity Ledger', 'Financial'),
  ('REPORT','trial_balance','Trial Balance Summary', 'Financial'),
  ('REPORT','payroll_wage_balance','Payroll & Wage Balance Report', 'Financial'),

  -- Purchase Reports
  ('REPORT','supplier_balances','Supplier Balances Report', 'Purchase'),
  ('REPORT','supplier_ledger','Supplier Ledger Report', 'Purchase'),
  ('REPORT','purchase_report','Purchase Report', 'Purchase'),
  ('REPORT','purchase_return_report','Purchase Return Report', 'Purchase'),

  -- Production Reports
  ('REPORT','production_report','Production Report', 'Production'),
  ('REPORT','dvc_report','DVC Report', 'Production'),
  ('REPORT','consumption_report','Consumption Report', 'Production'),
  ('REPORT','pending_consumption_report','Pending Consumption Report', 'Production'),
  ('REPORT','labour_ledger','Labour Ledger Report', 'Production'),
  ('REPORT','labour_balances','Labour Balances Report', 'Production'),
  ('REPORT','loss_report','Loss Report (Normal/Abnormal)', 'Production'),

  -- Inventory Reports
  ('REPORT','stock_quantity','Stock Quantity Report', 'Inventory'),
  ('REPORT','stock_amount','Stock Amount Report', 'Inventory'),
  ('REPORT','stock_ledger','Stock Ledger Report', 'Inventory'),
  ('REPORT','stock_item_activity','Stock/Item Activity Report', 'Inventory'),
  ('REPORT','pending_outgoing_transfers','Pending Outgoing Transfers Report', 'Inventory'),
  ('REPORT','pending_incoming_transfers','Pending Incoming Transfers Report', 'Inventory'),
  ('REPORT','stock_count_register','Stock Count Register', 'Inventory'),
  ('REPORT','demand_gap','Demand Gap Report', 'Inventory'),

  -- Outward & Returnable Reports
  ('REPORT','pending_returnables','Pending Returnables Report', 'Outward & Returnable'),
  ('REPORT','overdue_returnables','Overdue Returnables Report', 'Outward & Returnable'),
  ('REPORT','asset_movement_history','Asset Movement History', 'Outward & Returnable'),

  -- Sales Reports
  ('REPORT','claim_report','Claim Report', 'Sales'),
  ('REPORT','sales_report','Sales Report', 'Sales'),
  ('REPORT','sales_return_report','Sales Return Report', 'Sales'),
  ('REPORT','sales_order_report','Sales Order Report', 'Sales'),
  ('REPORT','sale_discount_report','Sale Discount Report', 'Sales'),
  ('REPORT','net_sale_report','Net Sale Report', 'Sales'),
  ('REPORT','monthly_product_profitability','Monthly Product Profitability Report', 'Sales'),
  ('REPORT','customer_listings','Customer Listings Report', 'Sales'),
  ('REPORT','customer_balances','Customer Balances Report', 'Sales'),
  ('REPORT','customer_ledger','Customer Ledger Report', 'Sales')
ON CONFLICT (scope_type, scope_key) DO NOTHING;


-- =====================================================================
-- C) CORE SEEDS — ADMIN BASELINE PERMISSIONS
-- =====================================================================

INSERT INTO erp.role_permissions
  (role_id, scope_id, can_navigate, can_view, can_create, can_edit, can_delete, can_print, can_approve)
SELECT
  r.id,
  s.id,
  true, true, true, true, true, true, true
FROM erp.role_templates r
CROSS JOIN erp.permission_scope_registry s
WHERE lower(trim(r.name)) = 'admin'
ON CONFLICT (role_id, scope_id) DO UPDATE SET
  can_navigate = EXCLUDED.can_navigate,
  can_view    = EXCLUDED.can_view,
  can_create  = EXCLUDED.can_create,
  can_edit    = EXCLUDED.can_edit,
  can_delete  = EXCLUDED.can_delete,
  can_print   = EXCLUDED.can_print,
  can_approve = EXCLUDED.can_approve;


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
