-- =====================================================================
-- 092_seeds.sql
-- PURPOSE:
--   Single consolidated seed file (CORE + COA) for ERP.
--
--   CORE SEEDS (system-required, environment-safe):
--     - Role templates (Admin)
--     - Entity type registry (for audit/entity tracking)
--     - Audit action registry (standard audit log verbs)
--     - Approval request type registry (maker-checker categories)
--     - Voucher types (default_status_on_save derived from requires_approval)
--     - Return reasons (sales return rules)
--     - Permission scopes (MODULE/SCREEN/VOUCHER/REPORT)
--     - Admin baseline permissions (Admin gets all rights on all scopes)
--
--   COA SEEDS (configuration):
--     - Account subgroups (baseline Chart of Accounts buckets)
--
-- SAFETY / DESIGN NOTES:
--   1) This file is idempotent:
--        - Uses ON CONFLICT DO NOTHING for dictionaries
--        - Uses ON CONFLICT DO UPDATE for voucher_type + admin permissions
--   2) Approval vs Posting:
--        - Per your rule: simple vouchers save as APPROVED (NOT POSTED).
--        - POSTED is a separate operational action (GL/stock finalization).
--   3) Ordering matters:
--        - permission_scope_registry must be seeded BEFORE Admin grant-all,
--          otherwise Admin won't receive newly introduced scopes.
-- =====================================================================

-- Optional: ensure schema is correct if you use search_path
-- SET search_path = erp;


-- =====================================================================
-- A) CORE SEEDS — REGISTRIES / DICTIONARIES
-- =====================================================================

-- ---------------------------------------------------------
-- A1) Role templates (baseline)
--     - Insert Admin role template if missing.
-- ---------------------------------------------------------
INSERT INTO erp.role_templates (name, description)
VALUES ('Admin', 'System administrator (full approval authority)')
ON CONFLICT (name) DO NOTHING;


-- ---------------------------------------------------------
-- A2) Entity type registry
--     - Standardizes the "entity" codes referenced by logs, audit, etc.
-- ---------------------------------------------------------
INSERT INTO erp.entity_type_registry (code, name, description)
VALUES
  ('VOUCHER',               'Voucher',      'Voucher record'),
  ('ITEM',                  'Item',         'Item master record'),
  ('SKU',                   'SKU',          'SKU/Variant master record'),
  ('BOM',                   'BOM',          'Bill of Materials record'),
  ('PARTY',                 'Party',        'Customer/Supplier/Other party'),
  ('ACCOUNT',               'Account',      'Chart of accounts record'),
  ('STOCKCOUNTADJUSTMENT',  'Stock Count',  'Stock count session/document')
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------
-- A3) Audit action registry
--     - Standard action verbs recorded in activity logs.
-- ---------------------------------------------------------
INSERT INTO erp.audit_action_registry (code, name, description)
VALUES
  ('CREATE',  'Create',  'Entity created'),
  ('UPDATE',  'Update',  'Entity updated'),
  ('DELETE',  'Delete',  'Entity deleted'),
  ('SUBMIT',  'Submit',  'Submitted for approval'),
  ('APPROVE', 'Approve', 'Approved by checker'),
  ('REJECT',  'Reject',  'Rejected by checker'),
  ('POST',    'Post',    'Posted/finalized'),
  ('CANCEL',  'Cancel',  'Cancelled/voided')
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------
-- A4) Approval request type registry
--     - Categories shown in Pending Approvals / maker-checker workflow.
-- ---------------------------------------------------------
INSERT INTO erp.approval_request_type_registry (code, name, description)
VALUES
  ('VOUCHER',          'Voucher Approval',     'Maker-checker approval for vouchers'),
  ('BOM',              'BOM Approval',         'Maker-checker approval for BOM'),
  ('STOCKADJUSTMENT',  'Stock Count Approval', 'Approval for stock count adjustments')
ON CONFLICT (code) DO NOTHING;


-- ---------------------------------------------------------
-- A5) Voucher types (transaction master)
--     - IMPORTANT (your rule):
--         requires_approval=true  -> default_status_on_save=PENDING
--         requires_approval=false -> default_status_on_save=APPROVED
--     - This does NOT mean "POSTED".
-- ---------------------------------------------------------
INSERT INTO erp.voucher_type
  (code, name, requires_approval, affects_stock, affects_gl)
VALUES
  -- FINANCE / TREASURY
  ('CASH_VOUCHER',     'Cash Voucher',                           false, false, true),
  ('JOURNAL_VOUCHER',  'Journal Voucher',                        false, false, true),
  ('BANK_VOUCHER',     'Bank Voucher',                           false, false, true),

  -- PURCHASE
  ('PURCHASE_ORDER',   'Purchase Order',                         false, false, false),
  ('PURCHASE_INVOICE', 'Purchase Invoice',                       true,  true,  true),
  ('PURCHASE_RETURN',  'Purchase Return',                        false, true,  true),

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
  affects_gl        = EXCLUDED.affects_gl,
  -- Derived default approval status on save (NOT posting)
  default_status_on_save =
    CASE
      WHEN EXCLUDED.requires_approval THEN 'PENDING'::erp.approval_status
      ELSE 'APPROVED'::erp.approval_status
    END;


-- ---------------------------------------------------------
-- A6) Return reasons
--     - affects_stock=false means: return does not increase stock
--       (e.g., opened/used, damaged in transit, missing items claim).
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
-- NOTE:
--   Seed scopes BEFORE "Admin gets all scopes".
--   Whenever you add a new scope later, re-running this file ensures:
--     - scope exists
--     - Admin gets it automatically (via the grant-all section).
-- =====================================================================

INSERT INTO erp.permission_scope_registry (scope_type, scope_key, description)
VALUES
  -- -------------------- MODULES --------------------
  ('MODULE','system','System / core setup'),
  ('MODULE','security','Users / security'),
  ('MODULE','master_data','Master data / setup'),
  ('MODULE','hr_payroll','HR & payroll'),
  ('MODULE','financial','Financial / accounting'),
  ('MODULE','purchase','Purchase'),
  ('MODULE','production','Production'),
  ('MODULE','inventory','Inventory'),
  ('MODULE','outward_returnable','Outward & returnable'),
  ('MODULE','sales','Sales'),

  -- -------------------- SCREENS --------------------
  ('SCREEN','branches','Branches'),
  ('SCREEN','user_management','User Management'),
  ('SCREEN','user_rights','User Rights'),
  ('SCREEN','role_templates','Role Templates'),
  ('SCREEN','pending_approvals','Pending Approvals'),
  ('SCREEN','bill_of_materials','Bill of Materials'),
  ('SCREEN','account_information','Account Information'),
  ('SCREEN','party_information','Party Information'),
  ('SCREEN','product_setup_masters','Product Setup Masters'),
  ('SCREEN','global_uom_packing_rules','Global UOM Packing Rules'),
  ('SCREEN','raw_materials','Raw Materials'),
  ('SCREEN','semi_finished_products','Semi-Finished Products'),
  ('SCREEN','finished_products','Finished Products'),
  ('SCREEN','bom_voucher','Create and approve BOM versions'),
  ('SCREEN','employees','Employees'),
  ('SCREEN','labours','Labours'),
  ('SCREEN','sale_commission_rules','Sales Commission Rules'),
  ('SCREEN','employee_allowances','Employee Allowances'),
  ('SCREEN','labour_rates_setup','Labour Rates Setup'),
  ('SCREEN','departments','Departments'),
  ('SCREEN','audit_freeze','Lock or freeze accounting periods'),

  -- -------------------- VOUCHERS --------------------
  ('VOUCHER','cash_voucher','Record cash receipts and payments'),
  ('VOUCHER','journal_voucher','Record adjustments and accrual entries'),
  ('VOUCHER','bank_voucher','Record bank receipts and payments'),
  ('VOUCHER','purchase_order','Create purchase request before invoice'),
  ('VOUCHER','purchase_invoice','Record supplier purchase invoice'),
  ('VOUCHER','purchase_return','Return purchased items to supplier'),
  ('VOUCHER','stock_transfer_note_outward','Transfer stock to transit location'),
  ('VOUCHER','internal_grn_incoming_transfer','Receive transferred stock at destination'),
  ('VOUCHER','opening_stock_voucher','Enter opening inventory balances'),
  ('VOUCHER','stock_count_adjustment_voucher','Adjust stock after physical count'),
  ('VOUCHER','semi_finished_production_voucher','Record semi-finished production completion'),
  ('VOUCHER','finished_production_voucher','Record finished production completion'),
  ('VOUCHER','department_completion_voucher_dcv','Record department-wise work completion'),
  ('VOUCHER','general_labour_production_voucher','Post production labour cost entries'),
  ('VOUCHER','consumption_voucher','Post production material consumption'),
  ('VOUCHER','production_planning','Plan production without stock postings'),
  ('VOUCHER','abnormal_loss_voucher','Record losses and write-offs'),
  ('VOUCHER','sales_order_voucher','Create sales order for delivery'),
  ('VOUCHER','sales_voucher','Record sales, returns, and claims'),
  ('VOUCHER','returnable_gate_pass_outward','Send tools/assets outside premises'),
  ('VOUCHER','returnable_gate_pass_inward','Receive returned tools/assets inward'),

  -- -------------------- REPORTS --------------------
  ('REPORT','pending_approvals_report','List all items awaiting approval'),
  ('REPORT','activity_log_report','View all actions and changes'),
  ('REPORT','bom_cost_and_margin_register','Approved BOM costs and margins'),
  ('REPORT','pending_bom_approval_change_log','Pending BOM changes with impact'),
  ('REPORT','bom_version_history_report','BOM versions audit trail history'),
  ('REPORT','semi_finished_dependency_report','Where semi-finished is used'),
  ('REPORT','cash_book_report','Daily cash receipts and payments'),
  ('REPORT','cash_voucher_register','All cash vouchers with details'),
  ('REPORT','bank_transactions_report','Bank transactions with clearing status'),
  ('REPORT','expense_analysis_report','Expenses by department or group'),
  ('REPORT','production_overhead_cost_analysis_report','Production overhead costs by department'),
  ('REPORT','non_production_expense_analysis_report','Non-production overheads for period'),
  ('REPORT','accrued_expenses_report','Unpaid incurred expenses summary'),
  ('REPORT','profit_wise_profitability_analysis_report','Profit by product with toggles'),
  ('REPORT','profit_and_loss_statement','Period profit and loss statement'),
  ('REPORT','journal_voucher_register','All journal vouchers listing'),
  ('REPORT','account_activity_ledger','Account movement with running balance'),
  ('REPORT','trial_balance_summary','Trial balance debit equals credit'),
  ('REPORT','payroll_and_wage_balance_report','Employee and labour balances'),
  ('REPORT','supplier_balances_report','Supplier payable balances summary'),
  ('REPORT','supplier_ledger_report','Supplier ledger transactions listing'),
  ('REPORT','purchase_report','Purchases by supplier and item'),
  ('REPORT','purchase_return_report','Purchase returns by supplier and item'),
  ('REPORT','pending_incoming_transfers_report','Incoming transfers pending at destination'),
  ('REPORT','production_report','Production summary by date range'),
  ('REPORT','dvc_report','Department completion pending versus consumed'),
  ('REPORT','consumption_report','Material consumption postings summary'),
  ('REPORT','pending_consumption_report','Materials required for planned production'),
  ('REPORT','labour_ledger_report','Labour transactions and postings'),
  ('REPORT','labour_balances_report','Labour payable balances summary'),
  ('REPORT','loss_report','Normal and abnormal loss summary'),
  ('REPORT','stock_quantity_report','Stock quantities by branch and type'),
  ('REPORT','stock_amount_report','Stock valuation at cost and sale'),
  ('REPORT','stock_ledger_report','Stock movements with running balance'),
  ('REPORT','stock_item_activity_report','Opening to closing stock activity'),
  ('REPORT','pending_outgoing_transfers_report','Transfers sent but not received'),
  ('REPORT','stock_count_register','Stock counts audit and impacts'),
  ('REPORT','demand_gap_report','Demand versus stock gap analysis'),
  ('REPORT','pending_returnables_report','Returnables pending with days out'),
  ('REPORT','overdue_returnables_report','Overdue returnables needing follow-up'),
  ('REPORT','asset_movement_history_report','Asset outward/inward movement history'),
  ('REPORT','customer_listings_report','Customer list with filters'),
  ('REPORT','customer_balances_report','Customer receivables aging summary'),
  ('REPORT','customer_ledger_report','Customer ledger with allocations'),
  ('REPORT','claim_report','Claims list with pairs and issue'),
  ('REPORT','sales_report','Sales listing with filters'),
  ('REPORT','sale_return_report','Sales returns listing with reasons'),
  ('REPORT','sales_order_report','Sales orders status and details'),
  ('REPORT','sale_discount_report','Discounts applied across sales'),
  ('REPORT','net_sale_report','Net sales after returns'),
  ('REPORT','monthly_product_profitability_report','Monthly SKU profitability ranking')
ON CONFLICT (scope_type, scope_key) DO NOTHING;


-- =====================================================================
-- C) CORE SEEDS — ADMIN BASELINE PERMISSIONS
-- =====================================================================
-- PURPOSE:
--   Admin always has ALL rights for ALL scopes:
--     VIEW/CREATE/EDIT/DELETE/PRINT/APPROVE/POST/UNPOST
--
-- NOTE:
--   This depends on:
--     - role_templates contains 'Admin'
--     - permission_scope_registry contains all scopes
--   That is why it is placed AFTER the above seeds.
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
-- D) COA SEEDS — ACCOUNT SUBGROUPS (Chart of Accounts buckets)
-- =====================================================================
-- PURPOSE:
--   Provide a baseline COA structure used for:
--     - control accounts (AR/AP)
--     - inventory valuation buckets
--     - production WIP clearing
--     - common expense & revenue heads
--
-- IMPORTANT TECH NOTE:
--   ON CONFLICT DO NOTHING requires a UNIQUE constraint.
--   Recommended unique key:
--     UNIQUE (group_code, code)
-- =====================================================================

INSERT INTO erp.account_subgroups (group_code, code, name, is_contra) VALUES

-- ===================== ASSETS =====================
('ASSET','cash_in_hand','Office Cash (Cash-in-Hand)',false),
('ASSET','bank','Bank',false),
('ASSET','bank_clearing','Bank Clearing / Undeposited Funds',false),
('ASSET','cash_with_salesman','Cash with Salesman',false),
('ASSET','accounts_receivable_control','Accounts Receivable (AR Control)',false),

('ASSET','inventory_rm','Inventory – Raw Materials',false),
('ASSET','inventory_sfg','Inventory – Semi-Finished',false),
('ASSET','inventory_fg','Inventory – Finished Goods',false),
('ASSET','inventory_transit','Inventory – Transit',false),

-- WIP/Clearing bucket used in production postings
('ASSET','production_clearing','Production Clearing (WIP/Clearing)',false),

-- ===================== LIABILITIES =====================
('LIABILITY','accounts_payable_control','Accounts Payable (AP Control)',false),
('LIABILITY','wages_payable','Wages Payable (Labour)',false),
('LIABILITY','salaries_payable','Salaries Payable (Employees)',false),
('LIABILITY','commission_payable','Commission Payable',false),
('LIABILITY','accrued_expenses_payable','Accrued Expenses Payable',false),
('LIABILITY','tax_payable','Tax Payable / Output Tax',false),

-- Optional
('LIABILITY','advances_from_customers','Advances from Customers',false),

-- ===================== EQUITY =====================
('EQUITY','opening_balance_equity','Opening Balance Equity',false),
('EQUITY','owner_capital','Owner Capital',false),
('EQUITY','retained_earnings','Retained Earnings',false),
('EQUITY','owner_drawings','Owner Drawings (Withdrawals)',true),

-- ===================== REVENUE =====================
('REVENUE','sales_revenue','Sales Revenue',false),
('REVENUE','other_income','Other Income',false),

-- Contra revenue
('REVENUE','sales_returns','Sales Returns',true),
('REVENUE','sales_discounts','Sales Discounts',true),

-- Stock gain as income (if enabled in your rules)
('REVENUE','stock_adjustment_gain','Stock Adjustment Gain',false),

-- ===================== EXPENSES =====================
('EXPENSE','cogs_finished_goods','COGS – Finished Goods',false),
('EXPENSE','stock_adjustment_loss','Stock Adjustment Loss',false),
('EXPENSE','abnormal_loss_expense','Abnormal Loss Expense',false),

-- For “DEFECTED” returns where stock does NOT increase
('EXPENSE','defected_return_expense','Defected Return Expense',false),

('EXPENSE','commission_expense','Commission Expense',false),

-- Overheads
('EXPENSE','utilities_electricity','Electricity / Utilities Expense',false),
('EXPENSE','rent_expense','Rent Expense',false),
('EXPENSE','fuel_expense','Fuel Expense',false),
('EXPENSE','salary_expense','Salary Expense',false),
('EXPENSE','wages_expense','Wages Expense',false),
('EXPENSE','bank_charges','Bank Fees / Charges Expense',false)

ON CONFLICT DO NOTHING;
