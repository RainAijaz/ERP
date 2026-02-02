const navConfig = [
  {
    key: "administration",
    labelKey: "administration",
    scopeType: "MODULE",
    scopeKey: "administration",
    moduleGroup: "Administration",
    children: [
      {
        key: "setup",
        labelKey: "setup",
        type: "group",
        children: [
          { key: "branches", labelKey: "branches", scopeType: "SCREEN", scopeKey: "administration.branches", moduleGroup: "Administration", route: "/administration/branches" },
          { key: "users", labelKey: "users", scopeType: "SCREEN", scopeKey: "administration.users", moduleGroup: "Administration", route: "/administration/users" },
          { key: "roles", labelKey: "roles", scopeType: "SCREEN", scopeKey: "administration.roles", moduleGroup: "Administration", route: "/administration/roles" },
          { key: "permissions", labelKey: "permissions", scopeType: "SCREEN", scopeKey: "administration.permissions", moduleGroup: "Administration", route: "/administration/permissions" },
        ],
      },
      {
        key: "approvals",
        labelKey: "approvals",
        type: "group",
        children: [
          { key: "approvals", labelKey: "approvals", scopeType: "SCREEN", scopeKey: "administration.approvals", moduleGroup: "Administration", route: "/administration/approvals" },
          { key: "approval_settings", labelKey: "approval_settings", scopeType: "SCREEN", scopeKey: "administration.approval_settings", moduleGroup: "Administration", route: "/administration/approvals/settings" },
          { key: "audit_logs", labelKey: "audit_logs", scopeType: "SCREEN", scopeKey: "administration.audit_logs", moduleGroup: "Administration", route: "/administration/audit-logs" },
        ],
      },
    ],
  },
  {
    key: "master_data",
    labelKey: "master_data",
    scopeType: "MODULE",
    scopeKey: "master_data",
    moduleGroup: "Master Data",
    children: [
      {
        key: "basic_information",
        labelKey: "basic_information",
        type: "group",
        children: [
          { key: "units", labelKey: "units", scopeType: "SCREEN", scopeKey: "master_data.basic_info.units", moduleGroup: "Master Data", route: "/master-data/basic-info/units" },
          {
            key: "groups",
            labelKey: "groups",
            type: "group",
            children: [
              {
                key: "products",
                labelKey: "products",
                type: "group",
                children: [
                  { key: "product_groups", labelKey: "product_groups", scopeType: "SCREEN", scopeKey: "master_data.basic_info.product_groups", moduleGroup: "Master Data", route: "/master-data/basic-info/product-groups" },
                  { key: "product_subgroups", labelKey: "product_subgroups", scopeType: "SCREEN", scopeKey: "master_data.basic_info.product_subgroups", moduleGroup: "Master Data", route: "/master-data/basic-info/product-subgroups" },
                  { key: "product_types", labelKey: "product_types", scopeType: "SCREEN", scopeKey: "master_data.basic_info.product_types", moduleGroup: "Master Data", route: "/master-data/basic-info/product-types" },
                ],
              },
              { key: "party_groups", labelKey: "party_groups", scopeType: "SCREEN", scopeKey: "master_data.basic_info.party_groups", moduleGroup: "Master Data", route: "/master-data/basic-info/party-groups" },
              { key: "account_groups", labelKey: "account_groups", scopeType: "SCREEN", scopeKey: "master_data.basic_info.account_groups", moduleGroup: "Master Data", route: "/master-data/basic-info/account-groups" },
              { key: "departments", labelKey: "departments", scopeType: "SCREEN", scopeKey: "master_data.basic_info.departments", moduleGroup: "Master Data", route: "/master-data/basic-info/departments" },
            ],
          },
          { key: "sizes", labelKey: "sizes", scopeType: "SCREEN", scopeKey: "master_data.basic_info.sizes", moduleGroup: "Master Data", route: "/master-data/basic-info/sizes" },
          { key: "colors", labelKey: "colors", scopeType: "SCREEN", scopeKey: "master_data.basic_info.colors", moduleGroup: "Master Data", route: "/master-data/basic-info/colors" },
          { key: "grades", labelKey: "grades", scopeType: "SCREEN", scopeKey: "master_data.basic_info.grades", moduleGroup: "Master Data", route: "/master-data/basic-info/grades" },
          { key: "packing_types", labelKey: "packing_types", scopeType: "SCREEN", scopeKey: "master_data.basic_info.packing_types", moduleGroup: "Master Data", route: "/master-data/basic-info/packing-types" },
          { key: "cities", labelKey: "cities", scopeType: "SCREEN", scopeKey: "master_data.basic_info.cities", moduleGroup: "Master Data", route: "/master-data/basic-info/cities" },
          { key: "uom_conversions", labelKey: "uom_conversions", scopeType: "SCREEN", scopeKey: "master_data.basic_info.uom_conversions", moduleGroup: "Master Data", route: "/master-data/basic-info/uom-conversions" },
        ],
      },
      {
        key: "accounts_parties",
        labelKey: "accounts_parties",
        type: "group",
        children: [
          { key: "accounts", labelKey: "accounts", scopeType: "SCREEN", scopeKey: "master_data.accounts", moduleGroup: "Master Data", route: "/master-data/accounts" },
          { key: "parties", labelKey: "parties", scopeType: "SCREEN", scopeKey: "master_data.parties", moduleGroup: "Master Data", route: "/master-data/parties" },
        ],
      },
      {
        key: "products",
        labelKey: "products",
        type: "group",
        children: [
          { key: "finished", labelKey: "finished", scopeType: "SCREEN", scopeKey: "master_data.products.finished", moduleGroup: "Master Data", route: "/master-data/products/finished" },
          { key: "semi_finished", labelKey: "semi_finished", scopeType: "SCREEN", scopeKey: "master_data.products.semi_finished", moduleGroup: "Master Data", route: "/master-data/products/semi-finished" },
          { key: "raw_materials", labelKey: "raw_materials", scopeType: "SCREEN", scopeKey: "master_data.products.raw_materials", moduleGroup: "Master Data", route: "/master-data/products/raw-materials" },
          { key: "skus", labelKey: "skus", scopeType: "SCREEN", scopeKey: "master_data.products.skus", moduleGroup: "Master Data", route: "/master-data/products/skus" },
        ],
      },
      {
        key: "bom",
        labelKey: "bom",
        type: "group",
        children: [
          { key: "bom_list", labelKey: "bom_list", scopeType: "SCREEN", scopeKey: "master_data.bom", moduleGroup: "Master Data", route: "/master-data/bom" },
          { key: "bom_versions", labelKey: "bom_versions", scopeType: "SCREEN", scopeKey: "master_data.bom", moduleGroup: "Master Data", route: "/master-data/bom/versions" },
          { key: "bom_approval", labelKey: "bom_approval", scopeType: "SCREEN", scopeKey: "master_data.bom.approval", moduleGroup: "Master Data", route: "/master-data/bom/approval" },
        ],
      },
    ],
  },
  {
    key: "hr_payroll",
    labelKey: "hr_payroll",
    scopeType: "MODULE",
    scopeKey: "hr_payroll",
    moduleGroup: "HR & Payroll",
    children: [
      { key: "employees", labelKey: "employees", scopeType: "SCREEN", scopeKey: "hr_payroll.employees", moduleGroup: "HR & Payroll", route: "/master-data/hr-payroll/employees" },
      { key: "sales_commission", labelKey: "sales_commission", scopeType: "SCREEN", scopeKey: "hr_payroll.commissions", moduleGroup: "HR & Payroll", route: "/master-data/hr-payroll/commission" },
      { key: "allowances", labelKey: "allowances", scopeType: "SCREEN", scopeKey: "hr_payroll.allowances", moduleGroup: "HR & Payroll", route: "/master-data/hr-payroll/allowances" },
      {
        key: "labours",
        labelKey: "labours",
        type: "group",
        children: [
          { key: "labours_list", labelKey: "labours", scopeType: "SCREEN", scopeKey: "hr_payroll.labours", moduleGroup: "HR & Payroll", route: "/master-data/hr-payroll/labours" },
          { key: "labour_rates", labelKey: "labour_rates", scopeType: "SCREEN", scopeKey: "hr_payroll.labour_rates", moduleGroup: "HR & Payroll", route: "/master-data/hr-payroll/labour-rates" },
        ],
      },
    ],
  },
  {
    key: "financial",
    labelKey: "financial",
    scopeType: "MODULE",
    scopeKey: "financial",
    moduleGroup: "Financial",
    children: [
      {
        key: "vouchers",
        labelKey: "vouchers",
        type: "group",
        children: [
          { key: "cash_voucher", labelKey: "cash_voucher", scopeType: "VOUCHER", scopeKey: "CASH_VOUCHER", moduleGroup: "Financial", route: "/vouchers/cash" },
          { key: "bank_voucher", labelKey: "bank_voucher", scopeType: "VOUCHER", scopeKey: "BANK_VOUCHER", moduleGroup: "Financial", route: "/vouchers/bank" },
          { key: "journal_voucher", labelKey: "journal_voucher", scopeType: "VOUCHER", scopeKey: "JOURNAL_VOUCHER", moduleGroup: "Financial", route: "/vouchers/journal" },
        ],
      },
      {
        key: "reports",
        labelKey: "reports",
        type: "group",
        children: [{ key: "financial_reports", labelKey: "financial_reports", scopeType: "REPORT", scopeKey: "profit_and_loss", moduleGroup: "Financial", route: "/reports/financial" }],
      },
    ],
  },
  {
    key: "purchase",
    labelKey: "purchase",
    scopeType: "MODULE",
    scopeKey: "purchase",
    moduleGroup: "Purchase",
    children: [
      {
        key: "purchase",
        labelKey: "purchase",
        type: "group",
        children: [
          { key: "purchase_invoice", labelKey: "purchase_invoice", scopeType: "VOUCHER", scopeKey: "PI", moduleGroup: "Purchase", route: "/vouchers/purchase" },
          { key: "purchase_order", labelKey: "purchase_order", scopeType: "VOUCHER", scopeKey: "PO", moduleGroup: "Purchase", route: "/vouchers/purchase-order" },
          { key: "purchase_return", labelKey: "purchase_return", scopeType: "VOUCHER", scopeKey: "PR", moduleGroup: "Purchase", route: "/vouchers/purchase-return" },
        ],
      },
      {
        key: "reports",
        labelKey: "reports",
        type: "group",
        children: [{ key: "purchase_reports", labelKey: "purchase_reports", scopeType: "REPORT", scopeKey: "purchase_report", moduleGroup: "Purchase", route: "/reports/purchases" }],
      },
    ],
  },
  {
    key: "production",
    labelKey: "production",
    scopeType: "MODULE",
    scopeKey: "production",
    moduleGroup: "Production",
    children: [
      {
        key: "production",
        labelKey: "production",
        type: "group",
        children: [
          { key: "production_voucher", labelKey: "production", scopeType: "VOUCHER", scopeKey: "PROD_FG", moduleGroup: "Production", route: "/vouchers/production" },
          { key: "abnormal_loss", labelKey: "abnormal_loss", scopeType: "VOUCHER", scopeKey: "LOSS", moduleGroup: "Production", route: "/vouchers/abnormal-loss" },
        ],
      },
      {
        key: "reports",
        labelKey: "reports",
        type: "group",
        children: [{ key: "production_reports", labelKey: "production_reports", scopeType: "REPORT", scopeKey: "production_report", moduleGroup: "Production", route: "/reports/production" }],
      },
    ],
  },
  {
    key: "inventory",
    labelKey: "inventory",
    scopeType: "MODULE",
    scopeKey: "inventory",
    moduleGroup: "Inventory",
    children: [
      {
        key: "inventory",
        labelKey: "inventory",
        type: "group",
        children: [
          { key: "inventory_voucher", labelKey: "inventory_voucher", scopeType: "VOUCHER", scopeKey: "OPENING_STOCK", moduleGroup: "Inventory", route: "/vouchers/inventory" },
          { key: "stock_count", labelKey: "stock_count", scopeType: "VOUCHER", scopeKey: "STOCK_COUNT_ADJ", moduleGroup: "Inventory", route: "/vouchers/stock-count" },
          { key: "stock_transfer", labelKey: "stock_transfer", scopeType: "VOUCHER", scopeKey: "STN_OUT", moduleGroup: "Inventory", route: "/vouchers/stn" },
        ],
      },
      {
        key: "reports",
        labelKey: "reports",
        type: "group",
        children: [{ key: "inventory_reports", labelKey: "inventory_reports", scopeType: "REPORT", scopeKey: "stock_quantity", moduleGroup: "Inventory", route: "/reports/inventory" }],
      },
    ],
  },
  {
    key: "outward_returnable",
    labelKey: "outward_returnable",
    scopeType: "MODULE",
    scopeKey: "outward_returnable",
    moduleGroup: "Outward & Returnable",
    children: [
      {
        key: "outward_returnable",
        labelKey: "outward_returnable",
        type: "group",
        children: [{ key: "returnables", labelKey: "returnables", scopeType: "VOUCHER", scopeKey: "RDV", moduleGroup: "Outward & Returnable", route: "/vouchers/returnables" }],
      },
      {
        key: "reports",
        labelKey: "reports",
        type: "group",
        children: [{ key: "returnable_reports", labelKey: "returnable_reports", scopeType: "REPORT", scopeKey: "pending_returnables", moduleGroup: "Outward & Returnable", route: "/reports/returnables" }],
      },
    ],
  },
  {
    key: "sales",
    labelKey: "sales",
    scopeType: "MODULE",
    scopeKey: "sales",
    moduleGroup: "Sales",
    children: [
      {
        key: "sales",
        labelKey: "sales",
        type: "group",
        children: [
          { key: "sales_voucher", labelKey: "sales_voucher", scopeType: "VOUCHER", scopeKey: "SALES_VOUCHER", moduleGroup: "Sales", route: "/vouchers/sales" },
          { key: "sales_order", labelKey: "sales_order", scopeType: "VOUCHER", scopeKey: "SALES_ORDER", moduleGroup: "Sales", route: "/vouchers/sales-order" },
        ],
      },
      {
        key: "reports",
        labelKey: "reports",
        type: "group",
        children: [{ key: "sales_reports", labelKey: "sales_reports", scopeType: "REPORT", scopeKey: "sales_report", moduleGroup: "Sales", route: "/reports/sales" }],
      },
    ],
  },
];

const collectNavItems = (nodes, items = []) => {
  nodes.forEach((node) => {
    if (node.scopeType && node.scopeKey) {
      items.push({
        scopeType: node.scopeType,
        scopeKey: node.scopeKey,
        description: node.labelKey,
        moduleGroup: node.moduleGroup || null,
      });
    }
    if (node.children && node.children.length) {
      collectNavItems(node.children, items);
    }
  });
  return items;
};

const getNavScopes = () => collectNavItems(navConfig);

const syncNavScopes = async (knex) => {
  const scopes = getNavScopes();
  if (!scopes.length) return;
  const insertRows = scopes.map((scope) => ({
    scope_type: scope.scopeType,
    scope_key: scope.scopeKey,
    description: scope.description,
    module_group: scope.moduleGroup,
  }));

  await knex("erp.permission_scope_registry").insert(insertRows).onConflict(["scope_type", "scope_key"]).ignore();
};

module.exports = {
  navConfig,
  getNavScopes,
  syncNavScopes,
};
