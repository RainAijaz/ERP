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
  ('PERMISSION',            'Permission',  'Administration: permissions'),
  ('MASTER_DATA_IMPORT',    'Master Data Import', 'Master data import audit activity')
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
  ('STOCK_COUNT_ADJ',  'Stock Count Voucher',                    true,  true,  true),

  -- PRODUCTION
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
  ('WRONG_SIZE',            'Wrong Size delivered ',                                true,  true),
  ('WRONG_ITEM',            'Wrong Item delivered',                                           true,  true),
  ('QUALITY_DEFECT',        'Quality Issue',                          true,  true),
  ('MISSING_ITEMS',         'Missing items',            false, true),
  ('CUSTOMER_CHANGED_MIND', 'Customer changed mind',                      true,  true),
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
  ('SCREEN','master_data.basic_info.sales_discount_policies','Sales Discount Policies', 'Master Data'),
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
  ('VOUCHER','STOCK_COUNT_ADJ','Stock Count Voucher',            'Inventory'),

  -- Production
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
  ('REPORT','expense_trends','Expense Trends Report', 'Financial'),
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
-- C1) OPTIONAL URDU BACKFILL FOR SEEDED MASTER DATA
-- NOTE:
--   Applies ONLY when *_ur columns exist in your schema.
--   Safe on older schemas because each update is guarded by column checks.
-- =====================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'erp' AND table_name = 'branches' AND column_name = 'name_ur'
  ) THEN
    UPDATE erp.branches b
    SET name_ur = CASE b.code
      WHEN '124' THEN '۱۲۴'
      WHEN '207' THEN '۲۰۷'
      ELSE b.name_ur
    END
    WHERE (b.name_ur IS NULL OR trim(b.name_ur) = '')
      AND b.code IN ('124', '207');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'erp' AND table_name = 'role_templates' AND column_name = 'name_ur'
  ) THEN
    UPDATE erp.role_templates r
    SET name_ur = CASE
      WHEN lower(trim(r.name)) = 'admin' THEN 'ایڈمن'
      ELSE r.name_ur
    END
    WHERE (r.name_ur IS NULL OR trim(r.name_ur) = '');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'erp' AND table_name = 'role_templates' AND column_name = 'description_ur'
  ) THEN
    UPDATE erp.role_templates r
    SET description_ur = CASE
      WHEN lower(trim(r.name)) = 'admin' THEN 'سسٹم ایڈمنسٹریٹر (مکمل منظوری اختیار)'
      ELSE r.description_ur
    END
    WHERE (r.description_ur IS NULL OR trim(r.description_ur) = '');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'erp' AND table_name = 'voucher_type' AND column_name = 'name_ur'
  ) THEN
    UPDATE erp.voucher_type v
    SET name_ur = CASE v.code
      WHEN 'CASH_VOUCHER' THEN 'کیش واؤچر'
      WHEN 'JOURNAL_VOUCHER' THEN 'جرنل واؤچر'
      WHEN 'BANK_VOUCHER' THEN 'بینک واؤچر'
      WHEN 'PO' THEN 'خرید آرڈر'
      WHEN 'PI' THEN 'خرید انوائس'
      WHEN 'PR' THEN 'خرید واپسی'
      WHEN 'STN_OUT' THEN 'اسٹاک ٹرانسفر نوٹ (روانہ)'
      WHEN 'GRN_IN' THEN 'داخلی جی آر این (موصولی ٹرانسفر)'
      WHEN 'OPENING_STOCK' THEN 'ابتدائی اسٹاک واؤچر'
      WHEN 'STOCK_COUNT_ADJ' THEN 'اسٹاک گنتی واؤچر'
      WHEN 'DCV' THEN 'ڈیپارٹمنٹ کمپلیشن واؤچر (ڈی سی وی)'
      WHEN 'LABOUR_PROD' THEN 'عمومی لیبر پیداوار واؤچر'
      WHEN 'CONSUMP' THEN 'کنزمپشن واؤچر'
      WHEN 'PROD_PLAN' THEN 'پروڈکشن پلاننگ'
      WHEN 'LOSS' THEN 'غیر معمولی نقصان واؤچر'
      WHEN 'SALES_ORDER' THEN 'سیلز آرڈر واؤچر'
      WHEN 'SALES_VOUCHER' THEN 'سیلز واؤچر'
      WHEN 'RDV' THEN 'ریٹرنیبل ڈسپیچ واؤچر'
      WHEN 'RRV' THEN 'ریٹرنیبل رسید واؤچر'
      ELSE v.name_ur
    END
    WHERE (v.name_ur IS NULL OR trim(v.name_ur) = '');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'erp' AND table_name = 'return_reasons' AND column_name = 'description_ur'
  ) THEN
    UPDATE erp.return_reasons r
    SET description_ur = CASE r.code
      WHEN 'WRONG_SIZE' THEN 'غلط سائز موصول ہوا'
      WHEN 'WRONG_ITEM' THEN 'غلط آئٹم موصول ہوا'
      WHEN 'QUALITY_DEFECT' THEN 'معیار کا مسئلہ'
      WHEN 'MISSING_ITEMS' THEN 'اشیاء نامکمل'
      WHEN 'CUSTOMER_CHANGED_MIND' THEN 'کسٹمر نے فیصلہ تبدیل کیا'
      WHEN 'LATE_DELIVERY' THEN 'تاخیر سے ڈیلیوری پر واپسی درخواست'
      WHEN 'OTHER' THEN 'دیگر'
      ELSE r.description_ur
    END
    WHERE (r.description_ur IS NULL OR trim(r.description_ur) = '');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'erp' AND table_name = 'permission_scope_registry' AND column_name = 'description_ur'
  ) THEN
    UPDATE erp.permission_scope_registry p
    SET description_ur = CASE p.scope_key
      WHEN 'administration' THEN 'برانچز اور صارفین کی انتظامیہ'
      WHEN 'master_data' THEN 'ماسٹر ڈیٹا اور سیٹ اپ'
      WHEN 'hr_payroll' THEN 'ایچ آر اور پے رول'
      WHEN 'financial' THEN 'مالیاتی اور اکاؤنٹنگ'
      WHEN 'purchase' THEN 'خریداری'
      WHEN 'production' THEN 'پیداوار'
      WHEN 'inventory' THEN 'انوینٹری'
      WHEN 'outward_returnable' THEN 'آؤٹ ورڈ اور ریٹرنیبل'
      WHEN 'sales' THEN 'سیلز'
      WHEN 'reports' THEN 'رپورٹس'
      ELSE p.description_ur
    END
    WHERE p.scope_type = 'MODULE'
      AND (p.description_ur IS NULL OR trim(p.description_ur) = '');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'erp' AND table_name = 'permission_scope_registry' AND column_name = 'module_group_ur'
  ) THEN
    UPDATE erp.permission_scope_registry p
    SET module_group_ur = CASE p.module_group
      WHEN 'Modules' THEN 'ماڈیولز'
      WHEN 'Administration' THEN 'انتظامیہ'
      WHEN 'Master Data' THEN 'ماسٹر ڈیٹا'
      WHEN 'HR & Payroll' THEN 'ایچ آر اور پے رول'
      WHEN 'Financial' THEN 'مالیاتی'
      WHEN 'Purchase' THEN 'خریداری'
      WHEN 'Production' THEN 'پیداوار'
      WHEN 'Inventory' THEN 'انوینٹری'
      WHEN 'Outward & Returnable' THEN 'آؤٹ ورڈ اور ریٹرنیبل'
      WHEN 'Sales' THEN 'سیلز'
      WHEN 'Reports' THEN 'رپورٹس'
      ELSE p.module_group_ur
    END
    WHERE (p.module_group_ur IS NULL OR trim(p.module_group_ur) = '');
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'erp' AND table_name = 'account_posting_classes' AND column_name = 'name_ur'
  ) THEN
    UPDATE erp.account_posting_classes a
    SET name_ur = CASE a.code
      WHEN 'bank' THEN 'بینک'
      WHEN 'cash' THEN 'کیش'
      ELSE a.name_ur
    END
    WHERE (a.name_ur IS NULL OR trim(a.name_ur) = '');
  END IF;
END $$;


-- =====================================================================
-- D) COA SEEDS — ACCOUNT SUBGROUPS
-- IMPORTANT:
--   This requires UNIQUE (account_type, code) on erp.account_groups
--   (or a composite primary key), otherwise ON CONFLICT will fail.
-- =====================================================================

INSERT INTO erp.account_posting_classes (code, name, is_system, is_active) VALUES
('bank', 'Bank', true, true),
('cash', 'Cash', true, true)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  is_system = EXCLUDED.is_system,
  is_active = EXCLUDED.is_active;

INSERT INTO erp.account_groups (account_type, code, name) VALUES
('ASSET','cash_in_hand','Office Cash (Cash-in-Hand)'),
('ASSET','bank','Bank'),
('ASSET','bank_clearing','Bank Clearing / Undeposited Funds'),
('ASSET','cash_with_salesman','Cash with Salesman'),
('ASSET','accounts_receivable_control','Accounts Receivable (AR Control)'),

('ASSET','inventory_rm','Inventory – Raw Materials'),
('ASSET','inventory_sfg','Inventory – Semi-Finished'),
('ASSET','inventory_fg','Inventory – Finished Goods'),
('ASSET','inventory_transit','Inventory – Transit'),

('ASSET','production_clearing','Production Clearing (WIP/Clearing)'),

('LIABILITY','accounts_payable_control','Accounts Payable (AP Control)'),
('LIABILITY','wages_payable','Wages Payable (Labour)'),
('LIABILITY','salaries_payable','Salaries Payable (Employees)'),
('LIABILITY','commission_payable','Commission Payable'),
('LIABILITY','accrued_expenses_payable','Accrued Expenses Payable'),
('LIABILITY','tax_payable','Tax Payable / Output Tax'),

('LIABILITY','advances_from_customers','Advances from Customers'),

('EQUITY','opening_balance_equity','Opening Balance Equity'),
('EQUITY','owner_capital','Owner Capital'),
('EQUITY','retained_earnings','Retained Earnings'),
('EQUITY','owner_drawings','Owner Drawings (Withdrawals)'),

('REVENUE','sales_revenue','Sales Revenue'),
('REVENUE','other_income','Other Income'),
('REVENUE','sales_returns','Sales Returns'),
('REVENUE','sales_discounts','Sales Discounts'),
('REVENUE','stock_adjustment_gain','Stock Adjustment Gain'),

('EXPENSE','cogs_finished_goods','COGS – Finished Goods'),
('EXPENSE','stock_adjustment_loss','Stock Adjustment Loss'),
('EXPENSE','abnormal_loss_expense','Abnormal Loss Expense'),
('EXPENSE','defected_return_expense','Defected Return Expense'),
('EXPENSE','commission_expense','Commission Expense'),
('EXPENSE','utilities_electricity','Electricity / Utilities Expense'),
('EXPENSE','rent_expense','Rent Expense'),
('EXPENSE','fuel_expense','Fuel Expense'),
('EXPENSE','salary_expense','Salary Expense'),
('EXPENSE','wages_expense','Wages Expense'),
('EXPENSE','bank_charges','Bank Fees / Charges Expense')
ON CONFLICT DO NOTHING;
