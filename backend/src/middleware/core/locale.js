const { parseCookies, setCookie } = require("../utils/cookies");

const translations = {
  en: {
    // --- USERS MODULE ---
    add_user: "Add User",
    edit_user: "Edit User",
    manage_system_access: "Manage system access",
    back_to_users: "Back to users",
    leave_blank_keep: "(Set new password (leave blank to keep current))",
    select_role: "Select Role",
    assigned_branches: "Assigned Branches",
    branch_access_hint: "User can only access data for assigned branches.",
    is_active_user: "Is Active User",
    role: "Role",
    email: "Email",
    selected: "Selected",

    // --- ROLES MODULE ---
    add_role: "Add Role",
    manage_user_roles: "Manage user roles",
    back_to_roles: "Back to roles",
    role_name: "Role Name",
    description: "Description",

    // --- PERMISSIONS MODULE ---
    configure_access_rights: "Configure access rights",
    user_overrides: "User Overrides",
    select_user: "Select User",
    module: "Module",
    screen: "Screen",
    navigate: "Navigate",
    navigation: "Navigation",
    voucher: "Voucher",
    report: "Report",
    view: "View",
    create: "Create",
    delete: "Delete",
    approve: "Approve",
    post: "Post",
    approval_settings: "Approval Settings",
    approval_rules: "Approval Rules",
    requires_approval: "Requires Approval",
    approval_submitted:
      "Approval request submitted. Changes will apply after approval.",
    approval_sent:
      "Change request sent for approval. It will be applied once reviewed.",
    approval_sent_negative_stock:
      "Insufficient stock would make inventory negative. Voucher has been submitted for Administrator approval.",
    notice: "Notice",
    approval_approved: "Approval request approved.",
    approval_rejected: "Approval request rejected.",
    approval_request_updated: "Approval request updated.",
    approval_request_updated_detail:
      "Your pending approval request was updated: {summary}",
    approval_no_changes: "No changes found in approval request.",
    approval_edit_failed: "Unable to update approval request.",
    approval_edit_invalid_payload: "Invalid approval edit payload.",
    approval_edit_no_fields: "No editable fields found in this request.",
    approval_edit_delete_not_allowed: "Delete requests cannot be edited.",
    approval_request_not_found:
      "Approval request not found or already decided.",
    approval_apply_failed:
      "Approval applied, but change could not be executed.",
    approval_updates:
      "Since your last login: {approved} approved, {rejected} rejected.",
    approval_approved_detail: "Your approval request was approved: {summary}",
    approval_rejected_detail: "Your approval request was rejected: {summary}",
    permission_denied: "Permission denied.",
    error_invalid_id: "Invalid ID.",
    error_not_found: "Record not found.",
    override_mode_active: "Override mode active",
    user_overrides_hint:
      "User-only changes apply to this user only (role permissions still apply unless overridden).",
    role_changes_global_hint:
      "Role permissions apply to all users assigned to this role.",
    save_permissions: "Save Permissions",
    search_permissions: "Search permissions...",
    expand_all: "Expand all",
    collapse_all: "Collapse all",
    scope_missing: "Scope missing in registry",
    select_target_to_configure: "Select a target to configure.",
    select_user_to_configure: "Select a user to configure permissions.",
    select_role_to_configure: "Select a role to configure permissions.",
    choose_role_above: "Choose a role above to view and update permissions.",
    choose_role_or_user_above:
      "Choose a role or user above to configure permissions.",
    back_to_branches: "Back to branches",
    edit_branch: "Edit Branch",
    branch_code: "Branch Code",
    unique_identifier_hint: "Short unique code for this branch (e.g. LHR01)",
    branch_name: "Branch Name",
    city: "City",
    is_active: "Is Active",
    active_branch_hint:
      "Inactive branches are hidden from selection and cannot be used for new transactions.",
    save_changes: "Save Changes",
    manage_company_locations: "Manage branch locations and availability",
    add_new_branch: "Add Branch",
    code: "Code",
    no_records_found: "No records found.",
    no_navigate_access_message:
      "Records are hidden because you don't have navigation access.",
    // --- BRAND & AUTH ---
    brand: "CHAND EVA",
    erp_system_copyright: "ERP System \u00a9 2026",
    dashboard: "Dashboard",
    welcome: "Welcome back. Select a module from the navigation to begin.",
    branch: "Branch",
    branch_changed_reload_confirm:
      "Branch changed in another tab. Reload this page with the new branch context? Unsaved changes will be lost.",
    signed_in_as: "Signed in as",
    logout: "Logout",
    sign_in: "Sign in",
    use_credentials: "Use your ERP credentials to continue.",
    username: "Username",
    password: "Password",
    login: "Login",
    incorrect_credentials: "Incorrect username or password. Try again.",
    user_inactive: "User is inactive. Contact admin.",
    login_failed: "Login failed. Please try again.",

    // --- MODULES ---
    administration: "Administration",
    setup: "Setup",
    security: "Security",
    branches: "Branches",
    users: "Users",
    roles: "Roles",
    permissions: "Permissions",
    approvals: "Approvals", // Renamed from "Pending Approvals" to be generic
    pending_approvals: "Pending Approvals",
    audit_logs: "Activity Log",
    master_data: "Master Data",
    accounts_parties: "Accounts & Parties",
    accounts: "Accounts",
    parties: "Parties",
    products: "Products",
    basic_information: "Basic Information",
    hr_payroll: "HR & Payroll",
    financial: "Financial",
    purchase: "Purchase",
    production: "Production",
    inventory: "Inventory",
    outward_returnable: "Outward & Returnables",
    assets: "Assets",
    asset: "Asset",
    asset_master: "Asset Master",
    asset_types: "Asset Types",
    returnable_assets: "Returnable Assets",
    sales: "Sales",
    master_data_import: "Master Data Import",
    master_data_import_description:
      "Upload Excel sheets, run a dry-run validation, then apply changes safely in one transaction.",
    import_admin_mode: "Admin apply mode",
    import_non_admin_mode: "Approval submit mode",
    import_upload_file: "Upload Excel Workbook",
    import_excel_file: "Excel File",
    import_last_file: "Last selected file",
    import_targets: "Import Targets",
    import_target_basic_master_data: "Basic Master Data",
    import_target_basic_master_data_desc:
      "Units, Sizes, Colors, Grades, Groups, Cities, Departments, and UOM conversions.",
    import_target_account_groups_desc:
      "Account groups import with account type, optional code, and active status.",
    import_target_accounts_desc:
      "Chart of accounts import with branch mapping and posting class resolution.",
    import_target_parties_desc:
      "Customer/supplier party import with city, group, and branch mapping.",
    import_target_products_desc:
      "Item import for RM/SFG/FG with product-group, subgroup, and base-unit mapping.",
    import_target_skus_desc:
      "SKU import for FG/SFG variants with dimension matching and sale-rate updates.",
    import_dry_run: "Run Dry-Run",
    import_apply_changes: "Apply Import",
    import_submit_for_approval: "Submit For Approval",
    import_non_admin_submit_notice:
      "Non-admin users cannot apply directly. This will be submitted for approval.",
    import_preview_summary: "Dry-Run Summary",
    import_rows_read: "Rows Read",
    import_rows_planned: "Rows Planned",
    import_create_update: "Create + Update",
    import_errors: "Errors",
    import_target: "Target",
    import_create: "Create",
    import_update: "Update",
    import_skip: "Skip",
    import_skip_reasons: "Skip Reasons",
    import_required_columns: "Required columns",
    import_optional_columns: "Optional columns",
    import_validation_errors: "Validation Errors",
    import_entity_units: "Units",
    import_entity_sizes: "Sizes",
    import_entity_colors: "Colors",
    import_entity_grades: "Grades",
    import_entity_packing_types: "Packing Types",
    import_entity_cities: "Cities",
    import_entity_product_groups: "Product Groups",
    import_entity_product_subgroups: "Product Subgroups",
    import_entity_product_types: "Product Types",
    import_entity_sales_discount_policies: "Sales Discount Policies",
    import_entity_party_groups: "Party Groups",
    import_entity_departments: "Departments",
    import_entity_uom_conversions: "UOM Conversions",
    import_entity_account_groups: "Account Groups",
    import_entity_accounts: "Accounts",
    import_entity_parties: "Parties",
    import_entity_products: "Products",
    import_entity_skus: "SKUs",
    import_file_too_large:
      "The selected file is too large. Maximum size is 20MB.",
    import_file_required: "Please select an Excel file.",
    import_fix_errors_first:
      "Please resolve all dry-run validation errors before applying import.",
    import_apply_success: "Master data import completed successfully.",
    sheet: "Sheet",
    error: "Error",

    // --- COMMON LABELS ---
    add: "Add",
    list: "List",
    show: "Show",
    rows: "Rows",
    status: "Status",
    type: "Type",
    search: "Search",
    all: "All",
    dozens: "Dozens",
    unit_pair: "Pair",
    unit_dozen: "Dozen",
    others: "Others",
    none: "NONE",
    not_applicable: "N/A",
    active: "Active",
    inactive: "Inactive",
    sr_no: "Sr.No",
    actions: "Actions",
    no_entries: "No entries yet.",
    yes: "Yes",
    no: "No",
    edit: "Edit",
    activate: "Activate",
    deactivate: "Deactivate",
    permanent_delete: "Permanent Delete",
    confirm: "Confirm",
    are_you_sure: "Are you sure?",
    continue: "Continue",
    cancel: "Cancel",
    save: "Save",
    audit: "Audit",
    created: "Created",
    updated: "Updated",
    bill_number: "Bill Number",
    enter_details_save: "Enter details and save.",
    showing: "Showing",
    to: "to",
    of: "of",
    entries: "entries",
    download: "Download",
    print: "Print",
    enter: "Enter",
    filters: "Filters",
    apply: "Apply",
    clear: "Clear",
    include: "Include",
    exclude: "Exclude",
    replace_with: "Replace With",
    select: "Select",
    load: "Load",
    voucher_no: "Voucher No",
    transfer_out: "Transfer Out",
    transfer_in: "Transfer In",
    stock_transfer: "Stock Transfer",
    stock_transfer_out: "Stock Transfer Out",
    stock_transfer_in: "Stock Transfer In",
    stock_transfer_out_voucher: "Stock Transfer Out Voucher",
    stock_transfer_in_voucher: "Stock Transfer In Voucher",
    transfer_ref_no: "Transfer Ref No",
    source_branch: "Source Branch",
    destination_branch: "Destination Branch",
    destination_branch_required: "Destination branch is required.",
    bill_book_no_required: "Bill Book No is required.",
    transfer_reference_required: "Transfer reference is required.",
    select_transfer_reference: "Select Transfer Reference",
    transfer_reason: "Transfer Reason",
    transfer_reason_rebalancing: "Rebalancing",
    transfer_reason_demand: "Demand",
    transfer_reason_return: "Return",
    transfer_reason_other: "Other",
    transporter_name: "Transporter Name",
    available_qty: "Available Qty",
    qty: "Qty",
    delivery_qty: "Delivery Qty",
    transfer_qty: "Transfer Qty",
    expected_qty: "Expected Qty",
    received_qty: "Received Qty",
    received_qty_required: "Received quantity is required.",
    rejected_qty: "Rejected Qty",
    variance_qty: "Variance Qty",
    variance_reason: "Variance Reason",
    variance_reason_required: "Variance reason is required.",
    received_by_user_name: "Received By",
    received_date_time: "Received Date",
    bill_book_no: "Bill Book No",
    reference_no: "Reference No",
    labour: "Labour",
    as_on: "As On",
    order_by: "Order By",
    report_type: "Report Type",
    purchase_type: "Purchase Type",
    cash_account: "Cash Account",
    bank_account: "Bank Account",
    journal_type: "Journal Type",
    select_account_name: "Select Account Name",
    enter_code: "Enter Code",
    note: "Note",
    enter_note: "Enter A Note",
    voucher_deleted_read_only: "This voucher is deleted and is now read-only.",
    prev: "Prev",
    next: "Next",
    new: "New",
    back_to_list: "Back to list",
    date: "Date",
    date_range: "Date Range",
    select_date_range: "Select Date Range",
    invalid_date_range: "Invalid date range.",
    open_date_range_picker: "Open date range picker",
    weekday_sun_short: "Su",
    weekday_mon_short: "Mo",
    weekday_tue_short: "Tu",
    weekday_wed_short: "We",
    weekday_thu_short: "Th",
    weekday_fri_short: "Fr",
    weekday_sat_short: "Sa",
    date_filters_auto_corrected:
      "Some date filters were invalid and have been reset.",
    previous_balance: "Previous Balance",
    opening_balance: "Opening Balance",
    closing_balance: "Closing Balance",
    total: "Total",
    grand_total: "Grand Total",
    summary: "Summary",
    details: "Details",
    book_number: "Book Number",
    remarks: "Remarks",
    vouchers_label: "Vouchers",
    items_label: "Items",
    parties_label: "Parties",
    group_header: "Group Header",
    line_item: "Line Item",
    subtotal: "Subtotal",
    summary_row: "Summary Row",
    action: "Action",
    submitted_for_approval: "Submitted For Approval",
    deletion_requested: "Deletion Requested",
    entity: "Entity",
    entity_type: "Entity Type",
    voucher_summary: "Voucher Summary",
    change_summary: "Change Summary",
    view_voucher: "Open Voucher",
    line_count: "Line Count",
    total_amount: "Total Amount",
    raw_request_data: "Raw Request Data",
    show_raw_data: "Show raw data",
    all_branches: "All branches",
    audit_context_details: "Audit Context Details",
    saving: "Saving...",
    load_failed: "Failed to load content.",
    error_saving: "Error saving.",
    error_generic: "Error.",
    review_and_fix: "Please review and resolve the issues below.",
    error_record_in_use:
      "This record is being used in other ERP areas and cannot be deleted.",
    error_duplicate_record: "A record with the same details already exists.",
    error_invalid_value: "One or more values are invalid.",
    error_due_date_must_be_after_voucher:
      "Payment due date must be after voucher date.",
    error_advance_amount_exceeds_final:
      "Advanced received amount cannot exceed final amount.",
    error_sales_order_requires_credit_sale:
      "Sales order reference requires credit sale.",
    error_single_sales_order_only:
      "Please select lines from only one sales order.",
    error_sales_order_not_found: "Selected sales order was not found.",
    error_no_open_sales_order_lines:
      "No open sales order lines found for the selected customer.",
    error_line_sale_and_return_conflict:
      "A line cannot have both sale and return quantity together.",
    error_line_sale_or_return_required:
      "Each line requires either sale quantity or return quantity.",
    error_line_pair_rate_required: "Pair rate must be greater than zero.",
    error_line_discount_must_be_less_than_rate:
      "Pair discount must be less than pair rate.",
    error_line_sales_order_line_required:
      "Sales order line is required for this row.",
    error_line_return_not_allowed_from_so:
      "Return quantity is not allowed in sales order linked rows.",
    error_line_sales_order_source_invalid:
      "Selected sales order line is invalid.",
    error_line_sales_order_qty_exceeds_open:
      "Delivered quantity exceeds open quantity in selected sales order line.",
    error_cash_received_must_equal_final:
      "Amount received must equal final amount for cash sale.",
    ok: "OK",
    unexpected_response: "Unexpected response",
    network_error: "Network error. Please try again.",

    // --- SKU & MATRIX SPECIFIC ---
    skus: "SKUs",
    skus_description: "Maintain SKU variants and pricing.",
    check_availability: "Check Availability",
    no_new_combinations: "All selected combinations already exist.",
    new_combinations_found: "new combinations found.",
    sale_rate: "Sale Rate",
    sku_code: "SKU Code",
    barcode: "Barcode",
    size: "Size",
    color: "Color",
    grade: "Grade",
    grade_rank: "Grade Rank",
    packing_type: "Packing Type",
    article: "Article",
    rates: "Rates",

    // --- APPROVALS & STATUSES ---
    pending: "Pending",
    closed: "Closed",
    complete: "Complete",
    approved: "Approved",
    rejected: "Rejected",
    unknown: "Unknown",
    requester: "Requester",
    old_rate: "Old Rate",
    new_rate: "New Rate",
    approve: "Approve",
    reject: "Reject",
    rate_change_submitted: "Rate change submitted for approval.",
    request_approved: "Request approved.",
    request_rejected: "Request rejected.",

    // --- ERRORS & MESSAGES ---
    saved_successfully: "Saved successfully.",
    error_required_fields: "Please fill all required fields.",
    error_cash_voucher_single_direction:
      "Cash voucher must be single-direction: use either receipt or payment.",
    error_unable_save:
      "Unable to save. Check for duplicate values or invalid data.",
    error_immutable_field:
      "Cannot edit physical variant properties. Create a new SKU instead.",
    error_update_status: "Unable to update status. This item may be in use.",
    error_delete: "Unable to delete. This item may be in use.",
    error_duplicate_code: "Code already exists.",
    error_duplicate_name:
      "Request could not be approved because the name already exists.",
    error_pair_uom_missing:
      "PAIR UOM is missing. Run the latest database migration.",
    error_production_base_unit_pair:
      "Finished and Semi-Finished articles must use PAIR as base unit.",

    // --- EXISTING KEYS (Preserved) ---
    units: "Units",
    groups: "Groups",
    party_groups: "Party Groups",
    account_groups: "Account Groups",
    account_type: "Account Type",
    account_group: "Account Group",
    posting_class: "Posting Class",
    help_posting_class:
      "Optional classification used for posting behavior (for example, Bank). Leave blank for normal accounts.",
    account_code: "Account Code",
    account_name: "Account Name",
    contra_account: "Contra Account",
    lock_posting: "Lock Posting",
    party_type: "Party Type",
    party_group: "Party Group",
    party_code: "Party Code",
    party_name: "Party Name",
    address: "Address",
    phone_primary: "Phone (Primary)",
    phone_secondary: "Phone (Secondary)",
    phone_1: "Phone 1",
    phone_2: "Phone 2",
    city: "City",
    customer: "Customer",
    supplier: "Supplier",
    vendor_party: "Vendor",
    select_vendor: "Select Vendor",
    vendor_capabilities: "Vendor Capabilities",
    vendor_capabilities_help:
      "Choose what this supplier can handle (Material, Repair, Service).",
    material_capability: "Material",
    repair_capability: "Repair",
    service_capability: "Service",
    asset_code: "Asset Code",
    asset_name: "Asset Name",
    asset_type: "Asset Type",
    select_asset_type: "Select Asset Type",
    home_branch: "Home Branch",
    assets_description:
      "Manage non-stock assets used in outward and returnable vouchers.",
    asset_master_description:
      "Maintain the asset master for tools, moulds, fixtures, and accessories.",
    asset_types_description:
      "Define asset categories used by assets and returnable vouchers.",
    returnable_assets_description:
      "Maintain returnable tools, moulds, fixtures, and accessories for outward/receipt vouchers.",
    credit_allowed: "Credit Allowed",
    credit_limit: "Credit Limit",
    error_select_vendor_capabilities:
      "Please select at least one vendor capability for supplier.",
    departments: "Departments",
    production_stages: "Production Stages",
    product_groups: "Product Groups",
    product_group: "Product Group",
    product_subgroups: "Product Sub-Groups",
    product_types: "Product Types",
    sales_discount_policies: "Sales Discount Policies",
    sizes: "Sizes",
    colors: "Colors",
    grades: "Grades",
    packing_types: "Packing Types",
    cities: "Cities",
    uom_conversions: "UOM Conversions",
    finished: "Finished",
    semi_finished: "Semi-Finished",
    raw_materials: "Raw Materials",
    semi_finished_goods: "Semi-Finished Goods",
    finished_goods: "Finished Goods",
    article_name: "Article Name",
    article_sku: "Article SKU",
    group: "Group",
    sub_group: "Sub Group",
    base_unit: "Base Unit",
    pair_uom_required: "PAIR UOM required",
    category: "Category",
    uses_sfg: "Uses SFG",
    sfg_part: "SFG Part",
    sfg_part_type: "SFG Part Type",
    upper: "Upper",
    step: "Step",
    color_rates: "Color Rates",
    avg_purchase_rate: "Avg Purchase Rate",
    current_purchase_rate: "CURRENT RATE",
    fixed_purchase_rate: "Standard Rate",
    weighted_average_rate: "Weighted Avg Rate",
    rate_difference: "Rate Difference",
    variance_amount: "Variance (Amt)",
    variance_percent: "Variance (%)",
    high_variance: "High Variance",
    high_variance_threshold: "High Variance Threshold",
    rate_alert_legend: "Legend",
    purchase_report_header_group_tooltip:
      "Group label based on current Order By selection.",
    purchase_report_header_voucher_no_tooltip:
      "System voucher number for the purchase transaction.",
    purchase_report_header_date_tooltip:
      "Voucher posting date used in the selected filter range.",
    purchase_report_header_bill_number_tooltip:
      "Supplier bill/reference number entered on voucher.",
    purchase_report_header_party_name_tooltip:
      "Supplier linked with this purchase entry.",
    purchase_report_header_raw_material_tooltip:
      "Raw material item on the purchase line.",
    purchase_report_header_quantity_tooltip:
      "Purchased quantity for this line/group.",
    purchase_report_header_standard_rate_tooltip:
      "Standard (fixed) rate maintained in RM rate master.",
    purchase_report_header_weighted_avg_rate_tooltip:
      "Weighted average historical rate from RM rate master.",
    purchase_report_header_current_rate_tooltip:
      "Rate used in this voucher line.",
    purchase_report_header_variance_amount_tooltip:
      "Difference amount: CURRENT RATE - Standard Rate.",
    purchase_report_header_variance_percent_tooltip:
      "Difference percent against Standard Rate.",
    purchase_report_header_amount_tooltip:
      "Line/group amount after quantity x CURRENT RATE.",
    purchase_report_header_branch_tooltip: "Branch where voucher is posted.",
    min_stock: "Min Stock",
    sizes_label: "Sizes",
    usage: "Usage In",
    expanded: "Expanded",
    one_color: "One Color",
    one_size: "One Size",
    only: "Only",
    variant_id: "Variant ID",
    purchase_rate: "Purchase Rate",
    sizes_help: "Select one or more sizes used by this semi-finished item.",
    finished_description:
      "Maintain finished articles, categories, and SFG usage flags.",
    finished_setup_note: "Set up sizes and variants for finished items.",
    semi_finished_description:
      "Maintain semi-finished items and their applicable sizes.",
    raw_materials_description:
      "Maintain raw materials with per-color purchase rates.",
    bom: "BOM",
    bom_list: "BOM Register",
    bom_versions: "Versions",
    bom_approval: "Approval",
    delete_draft: "Delete",
    bom_description: "Manage global BOM drafts, approvals, and versions.",
    submit_bom_request: "Submit BOM Request",
    bom_new_title: "Add BOM",
    bom_edit_title: "Edit BOM",
    bom_header: "BOM Setup",
    bom_output_qty: "Output Quantity",
    bom_output_batch_size: "Planned Output Qty",
    bom_output_uom: "Output Unit (UOM)",
    bom_tab_rm:
      "List Raw Material Used for This Article (Based on BOM Header Planned Output Qty)",
    bom_tab_sfg: "List Semi-Finished Products Used (If Any)",
    bom_tab_sfg_per_sku: "List Semi-Finished Products Used For Each SKU",
    bom_tab_labour: "List Labour Rates For This Article",
    bom_tab_variant_rules: "Variant Rules",
    bom_rm_rules_size_wise: "Size-Wise Raw Material Rules",
    bom_rm_section_hint:
      "Select material and consumption department here. Color, size, unit, and required quantity are read-only references; maintain SKU-wise quantity and variants in SKU Rules.",
    bom_rm_view_material_lines: "Material Lines",
    bom_rm_view_variant_rules: "Size Rules",
    bom_sku_rules: "SKU Rules",
    bom_advanced_rules: "Advanced Rules",
    bom_color_rules: "Color Rules",
    bom_color_scope_hint:
      "Choose a SKU variant scope to edit material color mapping.",
    bom_sku_rules_hint:
      "Enter SKU-wise required quantity and optional color/size overrides for BOM Header Planned Output Qty. Material Lines required quantity is derived from these rules.",
    bom_select_sku: "Select SKU",
    bom_no_sku_available: "No SKU available for selected article.",
    bom_no_material_lines_for_sku_rules:
      "Add material lines first to edit SKU rules.",
    bom_labour_selection_title: "Labours List",
    bom_labour_selection_hint:
      "Rows are auto-loaded from active Labour Rates for the selected article. Review and adjust only if needed.",
    bom_labour_size_rules_title: "SKU Rules",
    bom_labour_size_rules_hint:
      "Select a SKU to review labour rates by size scope. Rates are auto-fetched from Labour Rates.",
    bom_labour_col_rate: "Rate",
    bom_labour_locked_from_rates: "Locked (from Labour Rates)",
    bom_labour_locked_message:
      "This rate is managed from Labour Rates and is read-only in Add BOM.",
    bom_labour_sku_rules_hint:
      "Select a SKU to set labour rates. These rates apply by SKU size scope.",
    bom_no_labour_selected: "Add labour lines first to set size-wise rates.",
    bom_packing_rules: "Packing Rules",
    bom_sku_overrides: "SKU Overrides",
    bom_rm_col_material: "Material",
    bom_rm_col_color: "Color Variant",
    bom_rm_col_size: "Size Variant",
    bom_rm_col_department: "Consumption Department",
    bom_rm_col_actions: "Actions",
    bom_sku_variant_scope: "SKU Variant Scope",
    bom_hint_material: "Select the raw material used in this BOM.",
    bom_hint_base_unit:
      "Base unit is picked from the selected material and is read-only.",
    bom_hint_consumption_department:
      "Production department that consumes this material.",
    bom_hint_actions: "Use plus/minus to add or remove rows.",
    bom_hint_size_rule_material: "Material to which this size rule applies.",
    bom_hint_size_rule_uom: "Unit for the size-specific quantity.",
    bom_hint_size_rule_qty: "Required quantity for the selected size.",
    bom_hint_color_rule_material:
      "Material whose color mapping you want to control.",
    bom_hint_rm_color:
      "Raw material color to consume for the selected SKU scope.",
    bom_hint_packing_rule_material: "Base material that will be replaced.",
    bom_hint_packing: "Packing type condition for this replacement.",
    bom_hint_size_optional:
      "Optional size filter; leave blank to apply for all sizes.",
    bom_hint_replace_with: "Material to consume instead of base material.",
    bom_hint_sku: "Specific SKU for this exception rule.",
    bom_hint_target_rm: "Target raw material to override for this SKU.",
    bom_hint_override_qty:
      "Optional quantity override for this SKU and material.",
    bom_hint_exclude: "Exclude this material for the selected SKU.",
    bom_hint_size: "Size scope for this line.",
    bom_hint_article_sku: "Finished article SKU this row applies to.",
    bom_hint_semi_finished: "Semi-finished SKU used in this BOM.",
    bom_hint_step_upper_sku:
      "Select the semi-finished SKU used for this finished SKU.",
    bom_hint_step_sku: "Select step SKU used for this finished SKU.",
    bom_hint_upper_sku: "Select upper SKU used for this finished SKU.",
    bom_hint_required_qty: "Required quantity for this line.",
    bom_hint_step_quantity:
      "Quantity of selected step/upper SKU required for this finished SKU.",
    bom_hint_labour: "Labour master to apply cost from.",
    bom_hint_department: "Production department for this labour.",
    bom_hint_rate_type: "Cost basis (per pair or per dozen).",
    bom_hint_rate_value: "Rate amount for selected basis.",
    bom_source_base: "Base",
    bom_source_size_rule: "Size Rule",
    bom_source_color_rule: "Color Rule",
    bom_source_packing_rule: "Packing Rule",
    bom_source_sku_override: "SKU Override",
    bom_source_excluded: "Excluded",
    bom_rules_size_picker_hint:
      "Choose a size tab to edit material quantities for that size.",
    bom_rules_active_size_label: "Editing Rules For Size",
    bom_rules_count_label: "Rules",
    bom_rules_col_qty: "Required Qty",
    bom_rules_col_uom: "Unit",
    bom_sfg_col_step_upper_sku: "Step/Upper SKU",
    bom_sfg_col_step_qty: "Step Quantity",
    bom_sfg_col_consumed_stage: "Consumed In Stage",
    bom_all_skus: "All SKUs",
    bom_all_skus_no_color: "All SKUs (no color variants)",
    bom_header_change_modal_title: "BOM setup changed",
    bom_header_change_modal_message:
      "You changed BOM Setup fields. This affects material, SFG, and labour sections.",
    bom_header_change_modal_hint:
      "Save Draft & Switch: saves current draft and opens selected BOM context. Apply: keeps new header values and clears impacted sections.",
    bom_header_change_modal_apply: "Apply",
    bom_header_change_modal_save_switch: "Save Draft & Switch",
    bom_header_change_qty_title: "Apply Planned Output Qty Change?",
    bom_header_change_qty_message:
      "Material/SFG quantities will be cleared. Item, level, material selections, departments, and labour selections stay.",
    bom_header_change_qty_hint:
      "Apply will keep new planned output quantity and clear quantity fields for re-entry.",
    bom_header_change_uom_title: "Apply Output Unit Change?",
    bom_header_change_uom_message:
      "Unit-sensitive quantity fields will be cleared and need re-entry.",
    bom_header_change_uom_hint:
      "Apply will keep new output unit and clear quantity fields for re-entry.",
    bom_header_change_identity_title: "Switch BOM Context?",
    bom_header_change_identity_message: "This starts a different BOM context.",
    bom_header_change_identity_hint:
      "'Save Draft & Switch' saves current draft and opens selected BOM context. 'Delete Draft & Switch' clears current sections and switches without saving.",
    bom_header_change_apply_start_fresh: "Delete Draft & Switch",
    bom_header_change_save_switch: "Save Draft & Switch",
    bom_header_required_message:
      "Complete the BOM setup first. Material, SFG, and labour sections unlock after that.",
    all_sizes: "All Sizes",
    quantity: "Quantity",
    bom_normal_loss_pct: "Normal Loss %",
    bom_create_new_version: "Create New Version",
    bom_revise: "Revise",
    bom_no_available_articles:
      "No new articles are available. Use BOM Register to revise an existing BOM.",
    bom_version_created: "New version created.",
    bom_versions_description:
      "Track version history and status by item and level.",
    bom_specific: "Specific",
    scope: "Scope",
    level: "Level",
    bom_stage: "Stage",
    bom_workflow_stage: "Stage",
    bom_stage_mandatory_in_flow: "Mandatory In Flow",
    bom_stage_strict_sequence: "Follow Sequence",
    bom_type: "Type",
    bom_type_finished_goods: "Finished Goods BOM",
    bom_type_semi_finished: "Semi-Finished BOM",
    version: "Version",
    item_status: "Item Status",
    bom_lifecycle: "BOM Status",
    save_draft: "Save Draft",
    send_for_approval: "Send for Approval",
    department: "Department",
    bom_rule_add_rm: "Add RM",
    bom_rule_remove_rm: "Remove RM",
    bom_rule_replace_rm: "Replace RM",
    bom_rule_adjust_qty: "Adjust Qty",
    bom_rule_change_loss: "Change Loss",
    bom_error_item_required: "Please select an item.",
    bom_error_level_required: "Please select a valid BOM level.",
    bom_error_output_qty_required: "Output quantity must be greater than zero.",
    bom_error_output_uom_required: "Output UOM is required.",
    bom_error_item_base_uom_missing:
      "Selected article has no base unit. Please set Base Unit in product master first.",
    bom_error_output_uom_conversion_missing:
      "Output Unit must have an active conversion to the article Base Unit in UOM Conversions.",
    bom_error_item_not_found: "Selected item does not exist.",
    bom_error_level_item_mismatch: "Selected level does not match item type.",
    bom_error_rm_line_invalid:
      "Complete this raw material row: select material and department.",
    bom_error_rm_department_duplicate:
      "This material is already added for the selected consumption department. Use a different material or department.",
    bom_error_rm_item_invalid: "Raw material line must reference an RM item.",
    bom_error_rm_uom_required: "Raw material UOM is required.",
    bom_error_rm_color_required:
      "Select color for this raw material because color-wise rates are configured.",
    bom_error_rm_size_required:
      "Select size for this raw material because size-wise rates are configured.",
    bom_error_rm_color_invalid:
      "Selected color is not configured in active rates for this raw material.",
    bom_error_rm_size_invalid:
      "Selected size is not configured in active rates for this raw material.",
    bom_error_loss_pct_invalid: "Normal loss % must be between 0 and 100.",
    bom_error_sfg_not_allowed_for_sfg_level:
      "Semi-finished BOM cannot include SFG section lines.",
    bom_error_sfg_line_invalid: "Invalid semi-finished line.",
    bom_error_sfg_section_incomplete:
      "Complete all mandatory fields in Semi-Finished section (Article SKU, Step/Upper SKU, and Step Quantity).",
    bom_error_sfg_item_invalid:
      "Selected SKU must belong to a semi-finished item.",
    bom_error_sfg_uom_required: "SFG UOM is required.",
    bom_error_sfg_requires_approved_bom:
      "Selected SFG item has no approved BOM.",
    bom_error_labour_line_invalid: "Invalid labour line.",
    bom_error_labour_department_duplicate:
      "This labour is already added for the selected department. Choose a different labour or department.",
    bom_error_labour_rate_type_invalid: "Invalid labour rate type.",
    bom_error_size_required_for_specific_scope:
      "Size is required for specific scope.",
    bom_error_packing_required_for_specific_scope:
      "Packing type is required for specific scope.",
    bom_error_color_required_for_specific_scope:
      "Color is required for specific scope.",
    bom_error_color_scope_not_allowed_no_sku_colors:
      "This article has no SKU color variants. Use 'All SKUs' for color scope.",
    bom_error_material_required_for_specific_scope:
      "Target material is required for specific scope.",
    bom_error_variant_action_invalid: "Invalid variant action type.",
    bom_error_variant_invalid_size:
      "Selected size is invalid for this BOM article.",
    bom_error_variant_invalid_color:
      "Selected color is invalid for this BOM article.",
    bom_error_variant_invalid_qty:
      "Adjusted quantity must be greater than zero.",
    bom_error_variant_invalid_uom: "Select a unit for adjusted quantity.",
    bom_error_variant_replace_requires_target:
      "Provide replacement material or raw material color.",
    bom_error_color_rules_required_no_sku_colors:
      "This article has no SKU color variants. Add Color Rules for each raw material that has multiple color rates.",
    bom_error_color_rule_missing_for_material_prefix:
      "Color rule missing for material",
    bom_error_missing_material_rates: "Missing required material rates.",
    bom_error_missing_material_rates_detail:
      "Missing active purchase rates for",
    bom_error_draft_exists: "A draft already exists for this item and level.",
    bom_error_existing_bom:
      "A BOM already exists for this article. Use BOM Register/Revise instead of Add BOM.",
    bom_error_only_draft_editable: "Only draft BOM can be edited.",
    bom_error_item_inactive_cannot_activate:
      "Cannot activate BOM while the article is inactive.",
    bom_error_lifecycle_not_available:
      "BOM lifecycle is not available. Run latest database migration.",
    bom_error_approve_requires_draft: "Only draft BOM can be approved.",
    bom_error_new_version_requires_approved:
      "New version can only be created from an approved BOM.",
    bom_error_already_pending:
      "A pending approval already exists for this BOM.",
    bom_error_fix_fields:
      "Please fix the following validation issues before saving BOM.",
    bom_error_stage_missing_mapping:
      "Selected production department has no active stage mapping.",
    bom_error_stage_inactive_or_missing:
      "Selected production stage is missing or inactive.",
    bom_error_stage_duplicate_in_flow:
      "This production department/stage is already added in flow.",
    bom_error_stage_sequence_duplicate:
      "Duplicate sequence is not allowed in production flow.",
    bom_error_stage_mapping_sync_conflict:
      "Production stage mapping sync failed due duplicate stage master data. Please retry save.",
    bom_error_sfg_duplicate_line:
      "Duplicate Semi-Finished line is not allowed.",
    bom_error_sku_override_table_missing:
      "SKU override storage is not available. Please run latest migration.",
    bom_error_row_prefix: "Row",
    bom_error_rule_prefix: "Rule",
    bom_error_sku_override_required:
      "Select SKU, target raw material, and consumption department.",
    bom_error_sku_override_target_missing:
      "Target raw material + department must match a BOM material line.",
    bom_error_sku_override_duplicate:
      "Duplicate SKU override for the same material and department.",
    bom_error_sku_override_item_mismatch:
      "Selected SKU does not belong to this BOM article.",
    bom_error_sku_override_no_change:
      "Add at least one change: exclude, quantity, replacement material, or color.",
    bom_error_approval_requirements:
      "Please complete all mandatory BOM rows before sending for approval.",
    bom_error_approval_blocked:
      "BOM cannot be sent for approval yet. Resolve the following BOM readiness issues.",
    bom_error_approval_missing_sfg_rows:
      "Complete all Semi-Finished rows for every Article SKU before sending for approval.",
    bom_error_approval_missing_sku_rules:
      "Complete all SKU Rules rows (quantity and required color variant) before sending for approval.",
    employees: "Employees",
    sales_commission: "Sales Commission",
    allowances: "Allowances",
    labours: "Labours",
    labour_rates: "Labour Rates",
    employees_description: "Manage employee master records for HR and payroll.",
    labours_description:
      "Manage labour master records for production and wage processing.",
    sales_commission_description:
      "Sales commission rules will be configured here per employee and product scope.",
    allowances_description: "Employee allowance rules will be configured here.",
    hr_screen_description:
      "Manage HR and payroll setup using the same universal workflow and approvals.",
    hr_screen_planned_note:
      "This screen path is active and connected to permissions. Detailed workflow implementation is scheduled in the next phase.",
    requirement_ref: "Requirement Ref",
    screen: "Screen",
    id: "ID",
    name: "Name",
    cnic: "CNIC",
    phone_number: "Phone Number",
    designation_role: "Designation / Role",
    payroll_type: "Payroll Type",
    payroll_monthly: "Monthly",
    payroll_daily: "Daily",
    payroll_piece_rate: "Piece Rate",
    payroll_multiple: "Multiple",
    basic_salary: "Basic Salary",
    production_category: "Production Category",
    production_category_finished: "Finished",
    production_category_semi_finished: "Semi-Finished",
    placeholder_employee_code: "EMP-001",
    placeholder_employee_name: "Ali Raza",
    placeholder_labour_code: "LAB-001",
    placeholder_labour_name: "Rafiq",
    placeholder_employee_cnic: "35202-1234567-1",
    placeholder_phone_number: "0300-0000000",
    placeholder_designation_role: "Sales Officer",
    error_invalid_payroll_type: "Invalid payroll type selected.",
    error_invalid_salary: "Basic salary must be a non-negative number.",
    error_invalid_status: "Invalid status selected.",
    error_branch_out_of_scope:
      "One or more selected branches are outside your branch access.",
    error_invalid_production_category: "Invalid production category selected.",
    error_invalid_salary_precision:
      "Basic salary supports up to 2 decimal places and valid range only.",
    error_select_department: "Please select a department.",
    error_labour_department_in_use:
      "Department cannot be removed from labour because existing vouchers/rates/BOM already reference it.",
    error_invalid_cnic: "Invalid CNIC format.",
    error_invalid_phone_number: "Invalid phone number format.",
    error_duplicate_cnic: "CNIC already exists.",
    error_duplicate_phone_number: "Phone number already exists.",
    apply_on: "Apply On",
    apply_on_sku: "Article (SKU)",
    apply_on_subgroup: "Product Sub-Group",
    apply_on_group: "Product Group",
    apply_on_all: "All Products (Flat)",
    apply_on_flat: "Flat",
    target_type: "Target Type",
    target: "Target",
    impact: "Impact",
    affected_skus: "Affected SKUs",
    select_target_to_preview_impact: "Select a target to preview impact.",
    resolved_from: "Resolved From",
    overridden: "Overridden",
    applied: "Applied",
    product_scope: "Product Scope",
    coverage_scope_fg: "Finished",
    coverage_scope_sfg: "Semi-Finished",
    coverage_scope_both: "Both",
    item_selector: "Item Selector",
    commission_basis: "Commission Basis",
    commission_basis_net_sales_percent: "% of Net Sales",
    commission_basis_gross_margin_percent: "% of Gross Margin",
    commission_basis_fixed_per_unit: "Fixed per Basic Unit",
    commission_basis_fixed_per_invoice: "Fixed per Invoice",
    rate: "Rate",
    value_type: "Value Type",
    value_type_percent: "Percent",
    value_type_fixed: "Fixed",
    value: "Value",
    reverse_on_returns: "Reverse on Returns",
    allowance_type: "Allowance Type",
    amount_type: "Amount Type",
    amount_type_fixed: "Fixed",
    amount_type_percent_basic: "% of Basic",
    amount: "Amount",
    frequency: "Frequency",
    frequency_monthly: "Monthly",
    frequency_daily: "Daily",
    taxable: "Taxable",
    applies_to_all_labours: "Apply to All Labours",
    rate_type: "Rate Type",
    view_rate_in: "VIEW RATE AS",
    rate_type_per_dozen: "Per Dozen",
    rate_type_per_pair: "Per Pair",
    rate_value: "Rate Value",
    batch_dozen_rates: "Batch Dozen Rates",
    article_type: "Article Type",
    article_type_fg: "Finished Goods (FG)",
    article_type_sfg: "Semi-Finished Goods (SFG)",
    load_skus: "Load SKUs",
    current_dozen_rate: "Current Dozen Rate",
    new_dozen_rate: "New Dozen Rate",
    row_notes: "Row Notes",
    effective_from: "Effective From",
    effective_to: "Effective To",
    apply_rate_to_selected: "Apply To Selected",
    filter_primary: "Primary Filter",
    filter_secondary: "Secondary Filter",
    error_invalid_apply_on: "Invalid apply-on selection.",
    error_invalid_commission_basis: "Invalid commission basis selected.",
    error_invalid_value_type: "Invalid value type selected.",
    error_invalid_rate_type: "Invalid rate type selected.",
    error_invalid_rate_value:
      "Invalid value. Enter a non-negative number with up to 2 decimals.",
    error_action_not_allowed: "This action is not allowed.",
    error_select_sku: "Please select an article (SKU).",
    error_select_subgroup: "Please select a product sub-group.",
    error_select_group: "Please select a product group.",
    error_select_labour: "Please select a labour.",
    error_duplicate_commission_rule:
      "A similar commission rule already exists.",
    error_invalid_amount_type: "Invalid amount type selected.",
    error_invalid_frequency: "Invalid frequency selected.",
    error_duplicate_allowance_rule:
      "Allowance type already exists for this employee.",
    error_duplicate_labour_rate_rule:
      "A similar labour rate rule already exists.",
    placeholder_allowance_type: "House, Conveyance, Mobile",
    placeholder_raw_material_name: "e.g. Synthetic Leather Sheet",
    placeholder_raw_material_name_ur: "e.g. مصنوعی چمڑا",
    vouchers: "Vouchers",
    cash_voucher: "Cash Voucher",
    cash_voucher_description:
      "Create and submit cash payment/receipt vouchers with approval-ready workflow.",
    bank_voucher: "Bank Voucher",
    bank_voucher_description:
      "Create and submit bank vouchers with pending/cleared/failed references.",
    journal_voucher: "Journal Voucher",
    journal_voucher_description:
      "Create balanced journal vouchers for accruals, adjustments, and closing entries.",
    reports: "Reports",
    financial_reports: "Financial Reports",
    recent_vouchers: "Recent Vouchers",
    cash_receipt: "Cash Receipt",
    cash_payment: "Cash Payment",
    bank_receipt: "Bank Receipt",
    bank_payment: "Bank Payment",
    debit: "Debit",
    total_debit: "Total Debit",
    total_credit: "Total Credit",

    credit: "Credit",
    from_date: "From Date",
    to_date: "To Date",
    voucher_type: "Voucher Type",
    stock_type: "Stock Type",
    voucher_register: "Voucher Register",
    voucher_register_purpose_tooltip:
      "Lists voucher entries for audit, reconciliation, and posting traceability.",
    cash_book: "Cash Book",
    cash_book_purpose_tooltip:
      "Shows cash movement with opening, in-period, and closing balances.",
    cash_voucher_register: "Cash Voucher Register",
    cash_voucher_register_purpose_tooltip:
      "Shows cash voucher activity only, filtered for cash-side controls.",
    bank_transactions: "Bank Transactions Report",
    bank_transactions_purpose_tooltip:
      "Tracks bank voucher transactions and clearance status for reconciliation.",
    expense_analysis: "Expense Analysis Report",
    expense_analysis_purpose_tooltip:
      "Analyzes period expense by department/group/account with variance drivers.",
    expense_trends: "Expense Trends Report",
    expense_trends_purpose_tooltip:
      "Shows expense trends over time to identify spikes and direction changes.",
    department_breakdown: "Department Breakdown",
    expense_breakdown: "Expense Breakdown",
    time_granularity: "Time Granularity",
    period: "Period",
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
    current_period_total: "Current Period Total",
    net_expense_this_period: "Net Expense (This Period)",
    net_expense_previous_period: "Net Expense (Previous Period)",
    previous_period_total: "Previous Period Total",
    change_vs_previous: "Change vs Previous",
    change_vs_previous_help:
      "Positive means expense increased versus previous period. Negative means expense decreased.",
    average_per_bucket: "Average per Bucket",
    average_per_bucket_help:
      "Average net expense across non-zero buckets only; buckets with zero net expense are excluded.",
    highest_bucket: "Peak Expense Period",
    trend_chart: "Trend Chart",
    trend_chart_click_hint: "Click any chart point to open that period.",
    load_report_to_view: "Select filters and click Load to view the report.",
    monthly_short_range_daily_hint:
      "Time Granularity: Monthly. Date Range is short, so Daily buckets are used.",
    weekly_short_range_daily_hint:
      "Time Granularity: Weekly. Date Range under 7 days, so Daily buckets are used.",
    no_data_for_selected_period:
      "No expense entries found for the selected period.",
    popup_blocked_new_tab:
      "Popup blocked. Allow popups to open Expense Analysis in a new tab.",
    current_period: "Current Period",
    previous_period: "Previous Period",
    change_percentage: "Change %",
    delta: "Delta",
    delta_tooltip: "Current period total minus previous period total.",
    contribution_to_delta: "% of Delta",
    contribution_to_delta_tooltip:
      "Each row's share of absolute change within displayed drivers.",
    contribution_to_driver_movement: "% of Driver Movement",
    new_expense: "New Expense",
    dropped_to_zero: "Dropped to zero",
    variance_drivers: "Variance Drivers",
    variance_drivers_help:
      "Shows the biggest account groups behind period-over-period movement.",
    expense_credit_dominant_warning:
      "Some periods are net reversals (credits are higher than debits). Open that period to review adjustment/refund entries.",
    start_at: "Start At",
    drilldown_starts_at: "Drill-down Starts At",
    start_department: "Department",
    start_group: "Group",
    start_account: "Account",
    level_department: "Department Level",
    level_group: "Group Level",
    level_account: "Account Level",
    production_overhead: "Production Overhead Cost Analysis",
    production_overhead_purpose_tooltip:
      "Breaks down overhead costs linked to production operations.",
    non_production_expense: "Non-Production Expense Analysis",
    non_production_expense_purpose_tooltip:
      "Shows expenses outside production functions for control visibility.",
    accrued_expenses: "Accrued Expenses Report",
    accrued_expenses_purpose_tooltip:
      "Lists accrued expense postings pending settlement/reversal review.",
    profitability_analysis: "Profitability Analysis Report",
    profitability_analysis_purpose_tooltip:
      "Analyzes profitability indicators using financial movement data.",
    profit_and_loss: "Profit and Loss Statement",
    profit_and_loss_purpose_tooltip:
      "Summarizes income and expense to show net profit/loss for the period.",
    profit_derivation: "Profit Derivation",
    profit_derivation_note:
      "Formula and substituted values for selected filters.",
    pl_gross_sales: "Gross Sales",
    pl_sales_returns: "Sales Returns",
    pl_discounts: "Discounts",
    pl_net_sales: "Net Sales",
    pl_opening_inventory: "Opening Inventory",
    pl_purchases: "Purchases",
    pl_direct_costs: "Direct Costs",
    pl_closing_inventory: "Closing Inventory",
    pl_cogs: "Cost of Goods Sold (COGS)",
    pl_gross_profit: "Gross Profit",
    pl_operating_expenses: "Operating Expenses",
    pl_operating_profit_ebit: "Operating Profit (EBIT)",
    pl_other_income: "Other Income",
    pl_other_expenses: "Other Expenses",
    pl_finance_cost: "Finance Cost",
    pl_net_profit_before_tax: "Net Profit Before Tax",
    journal_voucher_register: "Journal Voucher Register",
    journal_voucher_register_purpose_tooltip:
      "Lists journal vouchers for adjustment and accrual audit review.",
    account_activity_ledger: "Account Activity Ledger",
    account_activity_ledger_purpose_tooltip:
      "Provides transaction-wise movement and running balance for a selected account.",
    trial_balance: "Trial Balance Summary",
    trial_balance_purpose_tooltip:
      "Summarizes debit/credit balances across accounts for period validation.",
    payroll_wage_balance: "Payroll & Wage Balance Report",
    payroll_wage_balance_purpose_tooltip:
      "Shows payroll and wage account balances for control and reconciliation.",
    all_voucher_types: "All Voucher Types",
    cashier: "Cashier",
    cashiers: "Cashiers",
    all_cashiers: "All Cashiers",
    any_cashier: "Any Cashier",
    include_na: "Include N/A",
    include_non_department_postings: "Include Non-department postings (N/A)",
    include_non_department_postings_hint:
      "Includes lines where department is not applicable (cash/bank/advances/transfers).",
    percent_of_department: "% of Department",
    percent_of_total: "% of Total",
    trend_vs_previous_period: "Trend vs Previous Period",
    transactions_count: "Transactions",
    voucher_lines: "Voucher Lines",
    gross_expense: "Gross Expense",
    credits_adjustments: "Credits / Adjustments",
    net_expense: "Net Expense",
    top_departments: "Top Departments",
    top_account_groups: "Top Account Groups",
    top_accounts: "Top Accounts",
    biggest_increase_vs_previous: "Biggest Increase vs Previous Period",
    top_groups: "Top Groups",
    payee: "Payee",
    back: "Back",
    quick_ranges: "Quick Ranges",
    this_month: "This Month",
    last_month: "Last Month",
    last_3_months: "Last 3 Months",
    year_to_date: "Year to Date",
    goods_receipt_note: "Goods Receipt Note",
    goods_receipt_note_voucher: "Goods Receipt Note Voucher",
    goods_receipt_note_description:
      "Record received raw material quantities when rates are not finalized yet.",
    general_purchase: "General Purchase",
    general_purchase_voucher: "General Purchase Voucher",
    general_purchase_description:
      "Record supplier invoice for cash or credit and auto-reference open GRNs.",
    purchase_invoice: "General Purchase",
    purchase_order: "Purchase Order",
    purchase_return: "Purchase Return",
    purchase_return_voucher: "Purchase Return Voucher",
    returnables: "Returnables",
    returnable_dispatch_voucher: "Dispatch (Outward)",
    returnable_receipt_voucher: "Receipt (Return Inward)",
    gate_pass: "Gate Pass",
    expected_return_date: "Expected Return Date",
    rgp_outward_reference: "RGP-Outward Reference",
    select_outward_reference: "Select Outward Reference",
    item_name: "Item Name",
    item_type: "Item Type",
    select_item: "Select Item",
    select_item_type: "Select Item Type",
    select_condition: "Select Condition",
    condition_at_dispatch: "Condition At Dispatch",
    condition_on_return: "Condition On Return",
    sent_qty: "Qty Sent",
    balance_pending: "Balance Pending",
    received_quantity: "Received Quantity",
    returnable_status: "Returnable Status",
    ref_line: "Ref Line",
    recent_vouchers: "Recent Vouchers",
    vr_no: "VR No",
    no_data: "No data found.",
    generic_error: "Something went wrong. Please try again.",
    purchase_return_description:
      "Record returned raw materials against supplier and reason.",
    raw_material: "Raw Material",
    select_raw_material: "Select Raw Material",
    select_supplier: "Select Supplier",
    payment_type: "Payment Type",
    cash_purchase: "Cash Purchase",
    credit_purchase: "Credit Purchase",
    cash_paid_account: "Cash Paid Account",
    grn_reference: "GRN Reference",
    auto_select_open_grn: "Auto select from open GRN quantities",
    open_qty: "Open Qty",
    deliver_qty: "Deliver Qty",
    select_grn_lines: "Select at least one GRN line.",
    single_grn_voucher_only: "Select GRN lines from a single voucher.",
    single_outward_voucher_only:
      "Select outward reference lines from a single voucher.",
    reason: "Reason",
    return_reason: "Return Reason",
    select_reason: "Select Reason",
    select_department: "Select Department",
    select_labour: "Select Labour",
    select_sku: "Select SKU",
    cash_account_required: "Cash account is required for cash purchase.",
    return_reason_damaged: "Damaged",
    return_reason_wrong_item: "Wrong Item",
    return_reason_quality_issue: "Quality Issue",
    return_reason_excess_qty: "Excess Quantity",
    return_reason_rate_dispute: "Rate Dispute",
    return_reason_late_delivery: "Late Delivery",
    return_reason_other: "Other",
    supplier_reports: "Supplier Reports",
    supplier_balance_information: "Supplier Balance Information",
    supplier_balances_report_purpose_tooltip:
      "Shows payable balance by supplier as of a selected date.",
    supplier_listings: "Supplier Listings",
    supplier_listings_purpose_tooltip:
      "Directory view of suppliers and their classification details.",
    supplier_ledger_report: "Supplier Ledger Report",
    supplier_ledger_report_purpose_tooltip:
      "Shows supplier-wise transaction ledger with running payable movement.",
    supplier_balances_report: "Supplier Balances Report",
    labour_ledger_report: "Labour Ledger Report",
    labour_ledger_report_purpose_tooltip:
      "Shows labour-wise transaction ledger with running balances.",
    labour_balances_report: "Labour Balances Report",
    labour_balances_report_purpose_tooltip:
      "Shows current payable/receivable balance by labour.",
    employee_ledger_report: "Employee Ledger Report",
    employee_ledger_report_purpose_tooltip:
      "Shows employee-wise transaction ledger with running balances.",
    employee_balances_report: "Employee Balances Report",
    employee_balances_report_purpose_tooltip:
      "Shows current payable/receivable balance by employee.",
    report_not_configured_yet: "This report is not configured yet.",
    purchase_reports: "Purchase Report",
    purchase_reports_purpose_tooltip:
      "Analyzes purchases by party, material, quantity, and amount.",
    abnormal_loss: "Abnormal Loss",
    abnormal_loss_voucher: "Abnormal Loss Voucher",
    finished_production_voucher: "Finished Production Voucher",
    semi_finished_production_voucher: "Semi-Finished Production Voucher",
    department_completion_voucher: "Department Completion Voucher",
    consumption_voucher: "Consumption Voucher",
    labour_production_voucher: "Labour Production Voucher",
    production_planning_voucher: "Production Planning Voucher",
    finished_production_voucher_description:
      "Record finished production and automatically generate related consumption and labour vouchers.",
    semi_finished_production_voucher_description:
      "Record semi-finished production and automatically generate related consumption and labour vouchers.",
    department_completion_voucher_description:
      "Record department-wise completed quantity and push it into WIP pool.",
    consumption_voucher_description:
      "Auto-generated consumption voucher linked to approved production vouchers.",
    labour_production_voucher_description:
      "Auto-generated labour voucher linked to approved production vouchers.",
    production_planning_voucher_description:
      "Plan future production quantities without posting consumption or labour.",
    production_reports: "Production Reports",
    production_reports_purpose_tooltip:
      "Entry point for production control, planning, and pending flow reports.",
    production_control_report: "Production Control Report",
    production_control_report_purpose_tooltip:
      "Tracks approved production output by voucher, SKU, and department.",
    consumption_report: "Consumption Report",
    consumption_report_purpose_tooltip:
      "Shows approved consumption voucher movement by department and stock item.",
    planned_consumption: "Planned Consumption",
    planned_consumption_purpose_tooltip:
      "Compares planned production against BOM-based expected material consumption.",
    department_wip_report: "Department-wise Pending Production Report",
    department_wip_report_purpose_tooltip:
      "Shows stage-wise pending production using previous-stage net WIP balance.",
    report_usage_help: "How to Use This Report",
    department_wip_report_usage_point_1:
      "Use As Of Date as the snapshot cutoff for pending calculation.",
    department_wip_report_usage_point_2:
      "Pending for a department is taken from previous-stage net balance (IN minus OUT).",
    department_wip_report_usage_point_3:
      "Loss, consumption, and conversion OUT movements are already deducted from pending.",
    department_wip_balances_report: "Department WIP Balances Report",
    department_wip_balances_report_purpose_tooltip:
      "Shows current department WIP balances by SKU and branch as of selected date.",
    department_wip_ledger_report: "Department WIP Ledger Report",
    department_wip_ledger_report_purpose_tooltip:
      "Shows movement ledger and closing balance for selected department and SKU.",
    as_of_date: "As Of Date",
    aging_bucket: "Aging Bucket",
    pending_articles: "Pending Articles",
    avg_aging_days: "Avg Aging (Days)",
    max_aging_days: "Max Aging (Days)",
    pending_pairs: "Pending Pairs",
    pending_dozen: "Pending Dozen",
    opening_pairs: "Opening Pairs",
    in_pairs: "In Pairs",
    out_pairs: "Out Pairs",
    closing_pairs: "Closing Pairs",
    closing_dozen: "Closing Dozen",
    sku_count: "SKU Count",
    open_ledger: "Open Ledger",
    movement: "Movement",
    in_movement: "IN",
    out_movement: "OUT",
    production_type: "Production Type",
    loss_type: "Loss Type",
    plan_kind: "Plan Kind",
    voucher_lines_required: "Voucher lines are required.",
    is_required: "is required",
    must_be_positive: "must be greater than zero",
    inventory_voucher: "Inventory Voucher",
    opening_stock_voucher: "Opening Stock Voucher",
    stock_count: "Stock Count",
    stock_count_adjustment_voucher: "Stock Count Voucher",
    stock_transfer: "Stock Transfer",
    reason_notes: "Reason Notes",
    system_stock_qty: "System Stock Qty",
    physical_stock_qty: "Physical Stock Qty",
    difference_qty: "Difference Qty",
    amount_difference: "Amount Difference",
    inventory_reports: "Inventory Reports",
    inventory_reports_purpose_tooltip:
      "Entry point for stock valuation and stock balance reporting.",
    stock_amount_report: "Stock Amount Report",
    stock_amount_report_purpose_tooltip:
      "Shows stock quantity, rate, and amount by filters and view type.",
    stock_balances_report: "Stock Balances Report",
    stock_balances_report_purpose_tooltip:
      "Shows stock quantities only (without values) by selected filters.",
    stock_ledger_report: "Stock Ledger Report",
    stock_movement_report: "Stock Movement Report",
    stock_transfer_report: "Stock Transfer Report",
    stock_transfer_report_purpose_tooltip:
      "Shows approved stock transfer in/out movement with branch, voucher, and SKU level filters.",
    pair_quantity: "Pair Quantity",
    qty_out: "Qty Out",
    transfer_status: "Transfer Status",
    partially_approved: "Partially Approved",
    ref_bill_no: "Ref/Bill No",
    voucher_count: "Voucher Count",
    mixed: "Mixed",
    dispatch_date: "Dispatch Date",
    received_date: "Received Date",
    stock_ledger_report_purpose_tooltip:
      "Shows stock movement ledger with opening, inward, outward, and closing balances for selected stock type and item.",
    stock_movement_report_purpose_tooltip:
      "Shows opening, production, purchase, sale, adjustment, and closing stock movement for selected filters.",
    stock_ledger_error_select_date_range:
      "Please select a valid date range to load Stock Ledger report.",
    stock_ledger_error_select_stock_item:
      "Please select a SKU/Raw Material to load Stock Ledger report.",
    sale_rate_basis: "Sale Basis",
    cost_rate_basis: "Cost Basis",
    returnables: "Returnables",
    returnable_reports: "Returnable Reports",
    pending_returnables: "Pending Returnables",
    pending_returnables_purpose_tooltip:
      "Shows open returnable cases pending return from counterparties.",
    overdue_returnables: "Overdue Returnables",
    overdue_returnables_purpose_tooltip:
      "Shows overdue returnable cases and vendor performance indicators.",
    returnables_vendor_dispatched_qty: "Dispatched Qty",
    returnables_vendor_returned_qty: "Returned Qty",
    returnables_vendor_open_qty: "Open Qty",
    returnables_vendor_overdue_open_qty: "Overdue Open Qty",
    returnables_vendor_avg_cycle_days: "Avg Cycle Days",
    returnables_vendor_on_time_rate: "On-Time Return Rate",
    returnables_vendor_open_cases: "Open Cases",
    returnables_vendor_condition_mismatch_cases: "Condition Mismatch Cases",
    returnables_vendor_risk_level: "Risk Level",
    sales_voucher: "Sales Voucher",
    sales_order: "Sales Order",
    sales_voucher_description:
      "Record direct sales or deliveries against sales orders with cash/credit handling.",
    sales_order_description:
      "Record customer sales orders with pending delivery quantities.",
    sales_reports: "Sales Reports",
    customer_reports: "Customer Reports",
    customer_balance_information: "Customer Balance Information",
    customer_balances_report_purpose_tooltip:
      "Shows receivable/payable balance by customer as of selected date.",
    customer_balances_report: "Customer Balances Report",
    customer_ledger_report: "Customer Ledger Report",
    customer_ledger_report_purpose_tooltip:
      "Shows customer-wise transaction ledger with running balances.",
    customer_listings: "Customer Listings",
    customer_listings_purpose_tooltip:
      "Directory view of customers and their grouping details.",
    sales_order_report: "Sales Order Report",
    sales_order_report_purpose_tooltip:
      "Tracks sales orders, delivered quantity, and remaining pending quantity.",
    sales_report: "Sales Report",
    sales_report_purpose_tooltip:
      "Analyzes sales performance by voucher, party/account, and article.",
    sale_return_report: "Sale Return Report",
    sale_return_report_purpose_tooltip:
      "Analyzes returned sales quantities and values by filters.",
    customer_contact_analysis: "Customer Contact Analysis",
    customer_contact_analysis_purpose_tooltip:
      "Summarizes customer contact and billing behavior over selected dates.",
    sales_order_report: "Sales Order Report",
    sales_report: "Sales Report",
    sale_return_report: "Sale Return Report",
    sales_discount_report: "Sales Discount Report",
    sales_discount_report_purpose_tooltip:
      "Shows discount impact by voucher/customer to monitor margin leakage.",
    primary_customer_name: "Primary Customer Name",
    total_bill_amount: "Total Bill Amount",
    highest_bill: "Highest Bill",
    bill_count: "Bill Count",
    last_purchase_date: "Last Purchase Date",
    product_groups_bought: "Product Groups Bought",
    pending_delivery_qty: "Pending Delivery Qty",
    remaining_qty: "Remaining Qty",
    select_customer: "Select Customer",
    select_salesman: "Select Salesman",
    salesman: "Salesman",
    select_sales_order: "Select Sales Order",
    select_article: "Select Article",
    sale_mode: "Sale Mode",
    sale_mode_direct: "Direct Sale",
    sale_mode_from_so: "From Sales Order",
    cash_sale: "Cash Sale",
    credit_sale: "Credit Sale",
    customer_name: "Customer Name",
    sales_order_link: "Sales Order Link",
    sales_order_line: "Sales Order Line",
    payment_due_date: "Payment Due Date",
    advance_receive: "Advance Payment Received",
    receive_into_account: "Payment Received Account",
    receive_into_account_if_any: "Payment Received Account (if any)",
    advance_received_amount: "Advanced Received Amount",
    payment_received_amount: "Payment Received Amount",
    payment_received_amount_if_any: "Payment Received Amount (if any)",
    current_payment_received: "Current Payment Received",
    sales_order_advance_received: "Sales Order Advance Received",
    sales_order_previous_payments_received:
      "Previous Payments Received for this Order",
    sales_order_total_amount: "Total Order Amount",
    sales_order_total_received_with_current:
      "Total Received (Sales Order + Current)",
    sales_order_total_received_for_order: "Total Received for this Order",
    current_voucher_amount: "Current Voucher Amount",
    remaining_receivable: "Remaining Receivable",
    error_advance_receive_enabled_no_amount:
      "Advance receive is enabled but no advanced payment amount was entered.",
    error_cash_sale_no_advanced_amount:
      "Cash sale requires Advanced Received Amount.",
    error_current_payment_exceeds_receivable:
      "Current payment exceeds remaining receivable for this sales order.",
    delivery_method: "Delivery Method",
    customer_pickup: "Customer Pickup",
    our_delivery: "Our Delivery",
    extra_discount: "Extra Discount",
    total_sales_amount: "Total Sales Amount",
    total_returns_amount: "Total Returns Amount",
    current_delivery_amount: "Current Delivery Amount",
    outstanding_for_current_delivery: "Outstanding for Current Delivery",
    final_amount: "Final Amount",
    remaining_amount: "Remaining Amount",
    sale_qty: "Sale Qty",
    return_qty: "Return Qty",
    pair_discount: "Pair Discount",
    total_discount: "Total Discount",
    pairs: "Pairs",
    loose: "Loose",
    packed: "Packed",
    print_gate_pass: "Print Gate Pass",
    thank_you_for_your_visit: "THANK YOU FOR YOUR VISIT",
    prepared_by: "Prepared By",
    checked_by: "Checked By",
    approved_by: "Approved By",
    auto_translate: "Auto Translate",
    translate_to_urdu: "Translate to Urdu",
    translation_fetching: "Fetching translation...",
    translation_idle: "Click Auto Translate to fill Urdu name",
    translation_ready: "Translated",
    translation_failed: "Translation unavailable",
    tooltip_account_type:
      "Main accounting classification (Asset, Liability, Equity, Revenue, Expense).",
    tooltip_code: "Short code used in reports and filtering.",
    tooltip_contra: "Offsets the balance of its parent group.",
    help_unit_code: "Short unique key used by the system (e.g., PCS, KG).",
    help_unit_name: "Descriptive name shown on reports and documents.",
    modules: "Modules",
    overview: "Overview",
    context: "Context",
    changed_fields: "Changed Fields",
    approved_values: "Approved Values",
    decision: "Decision",
    requested_entity: "Requested Entity",
    applied_entity: "Applied Entity",
    request_type: "Request Type",
    entity_id: "Entity ID",
    requested_by: "Requested By",
    old_value: "Old Value",
    new_value: "New Value",
    before: "Before",
    after: "After",
    user: "User",
    page: "Page",
    source: "Source",
    today: "Today",
    last_7_days: "Last 7 Days",
    last_30_days: "Last 30 Days",
    loading: "Loading",
    expand: "Expand",
    collapse: "Collapse",
    created_by: "Created By",
    created_at: "Created At",
    basic_info: "Basic Info",
    config: "Config",
    add_row: "Add Row",
    usage_help: "Usage Help",
    generated_combinations: "Generated Combinations",
    select_options_to_generate: "Select options to generate",
    edit_rates: "Edit Rates",
    packing: "Packing",
    sku: "SKU",
    previous_rate: "Previous Rate",
    previous_dozen_rate: "Previous Dozen Rate",
    shown_rows_totals: "Totals for shown rows",
    balance: "Balance",
    no_labours_found_for_department:
      "No active labours found for selected department.",
    bom_error_snapshot_mismatch:
      "Draft snapshot mismatch. Please refresh and retry.",
    bom_error_department_must_be_production:
      "Selected department must be an active Production department.",
    bom_error_labour_department_invalid:
      "Selected labour is not valid for this department.",
    bom_error_variant_value_invalid_json: "Invalid variant value payload.",
    add_branch: "Add Branch",
    manage_permissions: "Manage Permissions",
    account_access: "Account Access",
    account_access_subtitle:
      "Control which accounts this user can't view in account activity.",
    account_access_financial_reports_context:
      "Financial -> Reports: Account Activity restrictions",
    block_summary: "Block Summary",
    block_view_details: "Block View Details",
    account_details_access_limited:
      "Details are not allowed for the selected account. Summary is available.",
    account_access_saved: "Account access saved.",
    account_access_save_failed: "Failed to save account access.",
    user_not_found: "User not found.",
    edit_role: "Edit Role",
    field_required: "This field is required.",
    error_branch_code_exists: "Branch code already exists.",
    branch_not_found: "Branch not found.",
    error_select_branch: "Please select a branch.",
    error_invalid_account_group: "Invalid account group selected.",
    error_invalid_posting_class: "Invalid posting class selected.",
    unit_code_exists: "Unit code already exists.",
    error_unit_code_locked: "Unit code cannot be changed.",
    error_select_party_group: "Please select party group.",
    error_party_group_type: "Party type does not match selected group.",
    error_select_city: "Please select city.",
    error_select_phone: "Please enter at least one phone number.",
    deleted_successfully: "Deleted successfully.",
    error_no_target_skus_found: "No target SKUs found for selected filters.",
    error_select_article_type: "Please select article type.",
    error_invalid_article_type: "Invalid article type selected.",
    error_select_rate_type: "Please select rate type.",
    error_dcv_missing_labour_rate_for_sku:
      "Line {line}: Labour rate is missing for {sku}. Please add this Labour + Department + SKU in Labour Rates.",
    approval_pending_subject: "Pending Approval",
    approval_pending_details: "Your request is submitted and pending approval.",
    approval_request_id: "Approval Request ID",
    audit_logs_description: "Track system activity and changes.",
    branch_name_ur: "Branch Name (Urdu)",
    name_ur: "Name (Urdu)",
    role_name_ur: "Role Name (Urdu)",
    choose_option_top_right: "Choose option from top-right.",
    dismiss: "Dismiss",
    proceed_change: "Proceed with change",
    permanent_delete_message: "This action permanently deletes the record.",
    conversion_same_units: "From and To units cannot be same.",
    conversion_factor: "Conversion factor must be greater than zero.",
    conversion_exists: "Conversion already exists.",
    view_pending_approval: "View pending approval",
    error_select_commission_basis: "Please select commission basis.",
    success_bulk_commission_saved_counts:
      "Created: {created}, Updated: {updated}.",
    success_bulk_labour_rate_saved_counts:
      "Created: {created}, Updated: {updated}.",
    error_group_subgroup_only_for_bulk_commission:
      "For this screen, group/sub-group commission changes are allowed only via bulk save.",
    generic_error: "Error.",
    error_invalid_bulk_commission_payload: "Invalid bulk commission payload.",
    success_bulk_commission_saved: "Bulk commission saved successfully.",
    saved: "Saved",
    error_invalid_bulk_labour_rate_payload: "Invalid labour rate payload.",
    success_bulk_labour_rate_saved: "Bulk labour rates saved successfully.",
    no_records_found: "No records found",
    uom_conversion_help:
      "Define how one unit converts into another (e.g., 1 BOX = 10 PCS).",
    add_conversion: "Add Conversion",
    from_unit: "From Unit",
    to_unit: "To Unit",
    select_unit: "Select unit",
    select_option: "Select option",
    select_all: "Select all",
    applies_to_labours: "Applies To Labours",
    factor: "Factor",
    error_add_valid_purchase_rate:
      "Please add at least one valid purchase rate.",
    select_module: "Select a Module",
    select_module_approval_rules:
      "Select a module from the sidebar to view approval rules.",
    permissions_subtitle: "Manage user and role access levels",
    all_modules: "All Modules",
    select_module_permissions:
      "Select a module from the sidebar to view and edit its permissions.",
    read_only: "Read-only",
    permissions_read_only_hint:
      "You have access to view permissions, but you cannot edit them.",
    permissions_tip_view:
      "Grants permission to open this module. Required for any other action.",
    permissions_tip_navigate: "Allows navigating through existing records..",
    permissions_tip_load:
      "Allows loading report data using the selected filters.",
    permissions_tip_view_details:
      "Allows opening voucher/invoice drill-down links from report rows.",
    permissions_tip_create: "Enables the Add New form to save new entries.",
    permissions_tip_edit:
      "Unlocks the ability to change data in existing records.",
    permissions_tip_deactivate: "Enables the option to deactivate records.",
    permissions_tip_delete: "Permanently removes records.",
    permissions_tip_approve: "Grants authority to finalize a record status.",
    permissions_tip_print: "Enables report print output.",
    permissions_tip_download: "Enables the Download and Export buttons.",
    permissions_tip_export_excel_csv:
      "Allows exporting report output to Excel/CSV files.",
    permissions_tip_filter_all_branches:
      "Allows filtering reports across all branches instead of own branch only.",
    permissions_tip_view_cost_fields:
      "Allows viewing cost/rate sensitive columns in reports.",
    view_details: "View Details",
    export_excel_csv: "Export Excel/CSV",
    filter_all_branches: "All Branch Filters",
    view_cost_fields: "View Cost Fields",
    groups_description:
      "Manage groups used across products, parties, accounts, and departments.",
    product_groups_description: "Define RM/SFG/FG visibility groups.",
    party_groups_description: "Segment customers and suppliers.",
    account_groups_description: "Subgroups under standard COA headings.",
    departments_description: "Production vs non-production cost centers.",
    open: "Open",
    language: "Language",
    english: "English",
    urdu: "Urdu",
    pair_rate: "Pair Rate",
    dozen_rate: "Dozen Rate",
    variants: "Variants",
    advanced_filters: "Advanced Filters",
    average_dozen_discount: "Average Dozen Discount",
    average_pair_discount: "Average Pair Discount",
    bom_error_labour_rate_global_missing:
      "Global labour rate is missing for one or more selected lines.",
    close_date: "Close Date",
    complete_date: "Complete Date",
    daily_discount_trend: "Daily Discount Trend",
    dcv_stage_auto_from_department:
      "Stage is auto-selected from the chosen department.",
    delivered_qty: "Delivered Qty",
    discount_pct: "Discount %",
    discount_pct_of_gross_sales: "Discount % of Gross Sales",
    discounted_vouchers: "Discounted Vouchers",
    dozen: "Dozen",
    draft: "Draft",
    draft_saved: "Draft saved successfully.",
    error_cash_settlement_must_equal_total:
      "Cash settlement must equal total amount.",
    gross_amount: "Gross Amount",
    gross_sales_before_discount: "Gross Sales Before Discount",
    high_discount_alerts: "High Discount Alerts",
    highest_discount_voucher: "Highest Discount Voucher",
    invoice: "Invoice",
    line: "Line",
    line_discount_total: "Line Discount Total",
    method: "Method",
    net_amount: "Net Amount",
    net_sales_after_discount: "Net Sales After Discount",
    normal_loss_pct: "Normal Loss %",
    open_approval: "Open Approval",
    ordered_qty: "Ordered Qty",
    path: "Path",
    payment_account: "Payment Account",
    policy_breach_count: "Policy Breach Count",
    policy_excess_discount: "Policy Excess Discount",
    policy_limit_exceeded: "Policy Limit Exceeded",
    product: "Product",
    refund_amount: "Refund Amount",
    refund_due: "Refund Due",
    sales_type: "Sales Type",
    select_stage: "Select Stage",
    serial_no: "Serial No",
    stage: "Stage",
    top_customers_by_discount: "Top Customers by Discount",
    top_items_by_discount: "Top Items by Discount",
    top_salesmen_by_discount: "Top Salesmen by Discount",
    total_dozen_sold: "Total Dozen Sold",
    total_pairs_sold: "Total Pairs Sold",
    unit: "Unit",
    voucher_count: "Voucher Count",
    voucher_discount_details: "Voucher Discount Details",
    walk_in_customer: "Walk-in Customer",
    add_new_combinations: "Add Variants",
    variants_sent_approval: "Variants will be added once approved.",
  },
  ur: {},
};

const MOJIBAKE_MARKERS =
  /[\u00C3\u00D8\u00D9\u00DB\u00E2\u00DA\u00A2\u20AC\u017E]/;
const ARABIC_SCRIPT = /[\u0600-\u06FF]/;
const REPLACEMENT_MARKER = /�/;
const CONTROL_GARBAGE = /[\u0080-\u009f]/;

const tryDecodeMojibake = (value) => {
  if (typeof value !== "string") return value;
  if (!MOJIBAKE_MARKERS.test(value)) return value;

  const score = (text) => {
    const mojibakeCount = (String(text || "").match(MOJIBAKE_MARKERS) || [])
      .length;
    const arabicCount = (String(text || "").match(ARABIC_SCRIPT) || []).length;
    const replacementCount = (String(text || "").match(/�/g) || []).length;
    return arabicCount * 12 - replacementCount * 30 - mojibakeCount * 8;
  };

  const decodeOnce = (text) => {
    try {
      return Buffer.from(String(text || ""), "latin1").toString("utf8");
    } catch (err) {
      return String(text || "");
    }
  };

  const candidates = [value];
  let current = value;
  for (let i = 0; i < 4; i += 1) {
    current = decodeOnce(current);
    if (!candidates.includes(current)) candidates.push(current);
  }

  let best = value;
  let bestScore = score(value);
  for (const candidate of candidates) {
    const candidateScore = score(candidate);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best;
};

const normalizeTranslationMap = (map) => {
  const normalized = {};
  Object.entries(map || {}).forEach(([key, val]) => {
    normalized[key] = typeof val === "string" ? tryDecodeMojibake(val) : val;
  });
  return normalized;
};

const isCorruptedTranslation = (value) => {
  if (typeof value !== "string") return false;
  const text = String(value || "");
  return (
    MOJIBAKE_MARKERS.test(text) ||
    REPLACEMENT_MARKER.test(text) ||
    CONTROL_GARBAGE.test(text)
  );
};

const sanitizeUrduTranslations = (urMap, enMap) => {
  const next = { ...(urMap || {}) };
  Object.keys(enMap || {}).forEach((key) => {
    const current = next[key];
    if (typeof current !== "string") {
      next[key] = enMap[key];
      return;
    }

    const decoded = tryDecodeMojibake(current);
    if (!isCorruptedTranslation(decoded)) {
      next[key] = decoded;
      return;
    }

    next[key] = enMap[key] || decoded || current;
  });
  return next;
};

translations.ur = normalizeTranslationMap(translations.ur);

translations.ur = {
  ...translations.ur,
  add_user: "نیا صارف شامل کریں",
  edit_user: "صارف میں ترمیم کریں",
  manage_system_access: "سسٹم تک رسائی کا انتظام کریں",
  back_to_users: "صارفین پر واپس",
  leave_blank_keep:
    "(نیا پاس ورڈ دیں (موجودہ برقرار رکھنے کے لیے خالی چھوڑیں))",
  select_role: "رول منتخب کریں",
  assigned_branches: "تفویض شدہ برانچز",
  branch_access_hint: "صارف صرف تفویض شدہ برانچز کا ڈیٹا دیکھ سکتا ہے۔",
  role: "رول",
  add_role: "نیا رول شامل کریں",
  manage_user_roles: "صارف رولز کا انتظام کریں",
  back_to_roles: "رولز پر واپس",
  role_name: "رول کا نام",
  configure_access_rights: "رسائی کے حقوق ترتیب دیں",
  user_overrides: "صارف اووررائیڈز",
  select_user: "صارف منتخب کریں",
  module: "ماڈیول",
  screen: "اسکرین",
  navigate: "نیویگیٹ",
  navigation: "نیویگیشن",
  voucher: "واؤچر",
  report: "رپورٹ",
  view: "دیکھیں",
  create: "بنائیں",
  approve: "منظور کریں",
  approval_settings: "منظوری کی ترتیبات",
  approval_rules: "منظوری کے قواعد",
  requires_approval: "منظوری درکار",
  approval_submitted:
    "منظوری کی درخواست جمع ہو گئی ہے۔ منظوری کے بعد تبدیلی لاگو ہوگی۔",
  approval_sent:
    "تبدیلی کی درخواست منظوری کے لیے بھیج دی گئی ہے۔ منظوری کے بعد لاگو ہوگی۔",
  notice: "اطلاع",
  approval_approved: "منظوری کی درخواست منظور ہو گئی ہے۔",
  approval_rejected: "منظوری کی درخواست مسترد کر دی گئی ہے۔",
  permission_denied: "اجازت نہیں ہے۔",
  error_invalid_id: "غلط شناخت۔",
  error_not_found: "ریکارڈ موجود نہیں۔",
  save_permissions: "اجازتیں محفوظ کریں",
  search_permissions: "اجازتیں تلاش کریں...",
  expand_all: "سب کھولیں",
  collapse_all: "سب بند کریں",
  branch_name: "برانچ نام",
  city: "شہر",
  is_active: "فعال ہے",
  save_changes: "تبدیلیاں محفوظ کریں",
  add_new_branch: "برانچ شامل کریں",
  brand: "چاند ایوا",
  signed_in_as: "بطور داخل",
  branch: "برانچ",
  branch_changed_reload_confirm:
    "دوسرے ٹیب میں برانچ تبدیل ہو گئی ہے۔ کیا نئے برانچ کانٹیکسٹ کے ساتھ یہ صفحہ دوبارہ لوڈ کیا جائے؟ غیر محفوظ تبدیلیاں ضائع ہو جائیں گی۔",
  logout: "لاگ آؤٹ",
  language: "زبان",
  english: "انگریزی",
  urdu: "اردو",
  administration: "انتظامیہ",
  permissions: "اجازتیں",
  approvals: "منظوری",
  pending_approvals: "زیر التواء منظوری",
  master_data: "ماسٹر ڈیٹا",
  master_data_import: "ماسٹر ڈیٹا امپورٹ",
  master_data_import_description:
    "ایکسل شیٹ اپ لوڈ کریں، پہلے ڈرائی رن سے غلطیاں دیکھیں، پھر محفوظ ٹرانزیکشن کے ساتھ امپورٹ لاگو کریں۔",
  import_admin_mode: "ایڈمن اپلائی موڈ",
  import_non_admin_mode: "منظوری جمع کروانے کا موڈ",
  import_upload_file: "ایکسل ورک بک اپ لوڈ کریں",
  import_excel_file: "ایکسل فائل",
  import_last_file: "آخری منتخب فائل",
  import_targets: "امپورٹ ٹارگٹس",
  import_target_basic_master_data: "بیسک ماسٹر ڈیٹا",
  import_target_basic_master_data_desc:
    "یونٹس، سائز، کلرز، گریڈز، گروپس، شہر، محکمے، اور UOM کنورژنز۔",
  import_target_account_groups_desc:
    "اکاؤنٹ گروپس امپورٹ بمع اکاؤنٹ ٹائپ، اختیاری کوڈ، اور فعال حیثیت۔",
  import_target_accounts_desc:
    "اکاؤنٹس چارٹ امپورٹ بمع برانچ میپنگ اور پوسٹنگ کلاس ریزولوشن۔",
  import_target_parties_desc:
    "پارٹیز (کسٹمر/سپلائر) امپورٹ بمع شہر، گروپ، اور برانچ میپنگ۔",
  import_target_products_desc:
    "RM/SFG/FG آئٹمز امپورٹ بمع پروڈکٹ گروپ، سب گروپ، اور بیس یونٹ میپنگ۔",
  import_target_skus_desc:
    "FG/SFG ویریئنٹس کے لیے SKU امپورٹ، ڈائمنشن میچنگ اور سیل ریٹ اپڈیٹس کے ساتھ۔",
  import_dry_run: "ڈرائی رن چلائیں",
  import_apply_changes: "امپورٹ لاگو کریں",
  import_submit_for_approval: "منظوری کے لیے جمع کریں",
  import_non_admin_submit_notice:
    "نان ایڈمن صارف براہ راست اپلائی نہیں کر سکتا۔ یہ منظوری کے لیے بھیجا جائے گا۔",
  import_preview_summary: "ڈرائی رن خلاصہ",
  import_rows_read: "پڑھی گئی قطاریں",
  import_rows_planned: "منصوبہ بند قطاریں",
  import_create_update: "تخلیق + اپڈیٹ",
  import_errors: "غلطیاں",
  import_target: "ٹارگٹ",
  import_create: "تخلیق",
  import_update: "اپڈیٹ",
  import_skip: "اسکپ",
  import_skip_reasons: "اسکپ کی وجوہات",
  import_required_columns: "ضروری کالمز",
  import_optional_columns: "اختیاری کالمز",
  import_validation_errors: "تصدیقی غلطیاں",
  import_entity_units: "یونٹس",
  import_entity_sizes: "سائز",
  import_entity_colors: "رنگ",
  import_entity_grades: "گریڈز",
  import_entity_packing_types: "پیکنگ ٹائپس",
  import_entity_cities: "شہر",
  import_entity_product_groups: "پروڈکٹ گروپس",
  import_entity_product_subgroups: "پروڈکٹ سب گروپس",
  import_entity_product_types: "پروڈکٹ ٹائپس",
  import_entity_sales_discount_policies: "سیلز ڈسکاؤنٹ پالیسیاں",
  import_entity_party_groups: "پارٹی گروپس",
  import_entity_departments: "محکمے",
  import_entity_uom_conversions: "UOM کنورژنز",
  import_entity_account_groups: "اکاؤنٹ گروپس",
  import_entity_accounts: "اکاؤنٹس",
  import_entity_parties: "پارٹیز",
  import_entity_products: "پروڈکٹس",
  import_entity_skus: "ایس کے یوز",
  import_file_too_large: "منتخب فائل بہت بڑی ہے۔ زیادہ سے زیادہ حد 20MB ہے۔",
  import_file_required: "براہ کرم ایک ایکسل فائل منتخب کریں۔",
  import_fix_errors_first:
    "امپورٹ لاگو کرنے سے پہلے ڈرائی رن کی تمام غلطیاں درست کریں۔",
  import_apply_success: "ماسٹر ڈیٹا امپورٹ کامیابی سے مکمل ہو گیا۔",
  sheet: "شیٹ",
  error: "خرابی",
  hr_payroll: "ایچ آر اور پے رول",
  financial: "مالیاتی",
  purchase: "خریداری",
  production: "پروڈکشن",
  inventory: "انوینٹری",
  outward_returnable: "آؤٹ ورڈ اور ریٹرنیبل",
  sales: "سیلز",
  purchase_return: "خریداری ریٹرن",
  purchase_return_voucher: "خریداری ریٹرن واؤچر",
  stock_transfer_out: "اسٹاک ٹرانسفر آؤٹ",
  stock_transfer_in: "اسٹاک ٹرانسفر اِن",
  stock_transfer_out_voucher: "اسٹاک ٹرانسفر آؤٹ واؤچر",
  stock_transfer_in_voucher: "اسٹاک ٹرانسفر اِن واؤچر",
  voucher_no: "واؤچر نمبر",
  prev: "پچھلا",
  next: "اگلا",
  load: "لوڈ",
  labour: "لیبر",
  from_date: "شروع تاریخ",
  to_date: "اختتامی تاریخ",
  select: "منتخب کریں",
  select_date_range: "تاریخ کی حد منتخب کریں",
  invalid_date_range: "غلط تاریخ کی حد۔",
  open_date_range_picker: "تاریخ کی حد منتخب کرنے کا پینل کھولیں",
  delete: "حذف کریں",
  download: "ڈاؤن لوڈ",
  print: "پرنٹ",
  date: "تاریخ",
  supplier: "سپلائر",
  select_supplier: "سپلائر منتخب کریں",
  bill_book_no: "بل بک نمبر",
  bill_book_no_required: "بل بک نمبر لازمی ہے۔",
  reference_no: "ریفرنس نمبر",
  description: "تفصیل",
  reason: "وجہ",
  return_reason: "واپسی کی وجہ",
  select_reason: "وجہ منتخب کریں",
  raw_material: "خام مال",
  color: "رنگ",
  unit: "یونٹ",
  qty: "مقدار",
  deliver_qty: "ڈیلیور مقدار",
  advance_received_amount: "ایڈوانس وصول شدہ رقم",
  receive_into_account_if_any: "وصولی اکاؤنٹ (اگر کوئی ہو)",
  payment_received_amount: "وصول شدہ رقم",
  payment_received_amount_if_any: "وصول شدہ رقم (اگر کوئی ہو)",
  current_payment_received: "موجودہ وصول شدہ رقم",
  sales_order_report: "سیلز آرڈر رپورٹ",
  sales_voucher: "سیلز ووچر",
  select_sales_order: "سیلز آرڈر منتخب کریں",
  sales_order_link: "سیلز آرڈر لنک",
  payment_type: "ادائیگی کی قسم",
  bank_voucher: "بینک ووچر",
  sales_report: "سیلز رپورٹ",
  sale_return_report: "سیل ریٹرن رپورٹ",
  sales_discount_report: "سیلز ڈسکاؤنٹ رپورٹ",
  closed: "بند",
  complete: "مکمل",
  close_date: "بند ہونے کی تاریخ",
  ordered_qty: "آرڈر مقدار",
  delivered_qty: "ڈیلیور مقدار",
  remaining_qty: "بقایا مقدار",
  sales_order_advance_received: "سیلز آرڈر کی ایڈوانس وصول شدہ رقم",
  sales_order_previous_payments_received:
    "اس آرڈر کے لیے پہلے سے وصول شدہ ادائیگیاں",
  sales_order_total_amount: "کل آرڈر رقم",
  sales_order_total_received_with_current: "کل وصول شدہ (سیلز آرڈر + موجودہ)",
  sales_order_total_received_for_order: "اس آرڈر کے لیے کل وصول شدہ",
  current_voucher_amount: "موجودہ واؤچر رقم",
  remaining_receivable: "باقی قابل وصول رقم",
  current_delivery_amount: "موجودہ ڈیلیوری رقم",
  outstanding_for_current_delivery: "موجودہ ڈیلیوری کے لیے بقایا",
  vendor_capabilities: "Vendor Capabilities",
  vendor_capabilities_help:
    "Choose what this supplier can handle (Material, Repair, Service).",
  material_capability: "Material",
  repair_capability: "Repair",
  service_capability: "Service",
  error_select_vendor_capabilities:
    "Please select at least one vendor capability for supplier.",
  bill_book_no: "بل بک نمبر",
  reference_no: "ریفرنس نمبر",
  description: "تفصیل",
  reason: "وجہ",
  return_reason: "واپسی کی وجہ",
  select_reason: "وجہ منتخب کریں",
  raw_material: "خام مال",
  color: "رنگ",
  unit: "یونٹ",
  qty: "مقدار",
  received_quantity: "Received Quantity",
  delivery_qty: "ڈیلیوری مقدار",
  error_due_date_must_be_after_voucher:
    "ادائیگی کی آخری تاریخ واؤچر تاریخ کے بعد ہونی چاہیے۔",
  error_advance_amount_exceeds_final:
    "ایڈوانس وصول شدہ رقم حتمی رقم سے زیادہ نہیں ہو سکتی۔",
  error_current_payment_exceeds_receivable:
    "موجودہ وصولی اس سیلز آرڈر کی باقی قابل وصول رقم سے زیادہ نہیں ہو سکتی۔",
  error_sales_order_requires_credit_sale:
    "سیلز آرڈر ریفرنس کے ساتھ صرف کریڈٹ سیل کی اجازت ہے۔",
  error_single_sales_order_only:
    "براہ کرم صرف ایک سیلز آرڈر کی لائنیں منتخب کریں۔",
  error_sales_order_not_found: "منتخب سیلز آرڈر نہیں ملا۔",
  error_no_open_sales_order_lines:
    "منتخب کسٹمر کے لیے کوئی اوپن سیلز آرڈر لائن دستیاب نہیں ہے۔",
  error_line_sale_and_return_conflict:
    "ایک ہی لائن میں سیل اور ریٹرن مقدار ساتھ نہیں ہو سکتی۔",
  error_line_sale_or_return_required:
    "ہر لائن میں سیل مقدار یا ریٹرن مقدار میں سے ایک لازمی ہے۔",
  error_line_pair_rate_required: "پیئر ریٹ صفر سے زیادہ ہونا لازمی ہے۔",
  error_line_discount_must_be_less_than_rate:
    "پیئر ڈسکاؤنٹ پیئر ریٹ سے کم ہونا لازمی ہے۔",
  error_line_sales_order_line_required:
    "اس لائن کے لیے سیلز آرڈر لائن منتخب کرنا لازمی ہے۔",
  error_line_return_not_allowed_from_so:
    "سیلز آرڈر سے منسلک لائن میں ریٹرن مقدار کی اجازت نہیں ہے۔",
  error_line_sales_order_source_invalid: "منتخب سیلز آرڈر لائن درست نہیں ہے۔",
  error_line_sales_order_qty_exceeds_open:
    "درج کردہ ڈلیور مقدار منتخب سیلز آرڈر کی اوپن مقدار سے زیادہ ہے۔",
  rate: "ریٹ",
  amount: "رقم",
  action: "عمل",
  line: "لائن",
  status: "حالت",
  serial_no: "سیریل نمبر",
  none: "کوئی نہیں",
  total: "کل",
  add_row: "قطار شامل کریں",
  confirm: "تصدیق",
  erp_system_copyright: "ای آر پی سسٹم © 2026",
};

translations.ur = sanitizeUrduTranslations(translations.ur, translations.en);
// AUTO-URDU-TRANSLATIONS-START
translations.ur = {
  ...translations.ur,
  abnormal_loss: "غیر معمولی نقصان",
  account_activity_ledger: "اکاؤنٹ ایکٹیویٹی لیجر",
  account_code: "اکاؤنٹ کوڈ",
  account_group: "اکاؤنٹ گروپ",
  account_groups: "اکاؤنٹ گروپس",
  account_groups_description: "معیاری COA عنوانات کے تحت ذیلی گروپس۔",
  account_name: "اکاؤنٹ کا نام",
  account_type: "اکاؤنٹ کی قسم",
  contra_account: "کنٹرا اکاؤنٹ",
  accounts: "اکاؤنٹس",
  accounts_parties: "اکاؤنٹس اور پارٹیز",
  accrued_expenses: "جمع شدہ اخراجات کی رپورٹ",
  actions: "اعمال",
  activate: "چالو کریں۔",
  active: "فعال",
  active_branch_hint:
    "غیر فعال شاخیں انتخاب سے پوشیدہ ہیں اور نئے لین دین کے لیے استعمال نہیں کی جا سکتیں۔",
  add: "شامل کریں۔",
  add_branch: "برانچ شامل کریں۔",
  add_conversion: "تبدیلی شامل کریں۔",
  add_new_combinations: "متغیرات شامل کریں۔",
  advance_receive: "پیشگی ادائیگی موصول ہو گئی۔",
  affected_skus: "متاثرہ SKUs",
  after: "کے بعد",
  all_branches: "تمام شاخیں۔",
  all_cashiers: "تمام کیشیئرز",
  all_modules: "تمام ماڈیولز",
  all_sizes: "تمام سائز",
  all_voucher_types: "تمام واؤچر کی اقسام",
  allowance_type: "الاؤنس کی قسم",
  allowances: "الاؤنسز",
  allowances_description: "ملازم الاؤنس کے قواعد یہاں ترتیب دیے جائیں گے۔",
  amount_type: "رقم کی قسم",
  amount_type_fixed: "فکسڈ",
  amount_type_percent_basic: "بنیادی کا %",
  any_cashier: "کوئی بھی کیشئیر",
  applied: "لاگو",
  applied_entity: "اطلاق شدہ ادارہ",
  applies_to_all_labours: "تمام لیبرز پر اپلائی کریں۔",
  applies_to_labours: "لیبرز پر لاگو ہوتا ہے۔",
  apply: "لگائیں",
  apply_on: "اپلائی آن کریں۔",
  apply_on_all: "تمام مصنوعات (فلیٹ)",
  apply_on_flat: "فلیٹ",
  apply_on_group: "پروڈکٹ گروپ",
  apply_on_sku: "آرٹیکل (SKU)",
  apply_on_subgroup: "پروڈکٹ ذیلی گروپ",
  apply_rate_to_selected: "منتخب کردہ پر اپلائی کریں۔",
  approval_apply_failed:
    "منظوری لاگو ہو گئی، لیکن تبدیلی عمل میں نہیں لائی جا سکی۔",
  approval_approved_detail:
    "آپ کی منظوری کی درخواست منظور کر لی گئی: {summary}",
  approval_edit_delete_not_allowed:
    "ڈیلیٹ کی درخواستوں میں ترمیم نہیں کی جا سکتی۔",
  approval_edit_failed: "منظوری کی درخواست کو اپ ڈیٹ کرنے سے قاصر۔",
  approval_edit_invalid_payload: "غلط منظوری ترمیم پے لوڈ۔",
  approval_edit_no_fields: "اس درخواست میں کوئی قابل تدوین فیلڈ نہیں ملا۔",
  approval_no_changes: "منظوری کی درخواست میں کوئی تبدیلی نہیں ملی۔",
  approval_pending_details: "آپ کی درخواست جمع ہے اور منظوری زیر التواء ہے۔",
  approval_pending_subject: "زیر التواء منظوری",
  approval_rejected_detail:
    "آپ کی منظوری کی درخواست مسترد کر دی گئی: {summary}",
  approval_request_id: "منظوری کی درخواست ID",
  approval_request_not_found:
    "منظوری کی درخواست نہیں ملی یا پہلے ہی فیصلہ کیا گیا ہے۔",
  approval_request_updated: "منظوری کی درخواست کو اپ ڈیٹ کر دیا گیا۔",
  approval_request_updated_detail:
    "آپ کی زیر التواء منظوری کی درخواست کو اپ ڈیٹ کر دیا گیا: {summary}",
  approval_updates:
    "آپ کے آخری لاگ ان کے بعد سے: {approved} منظور، {rejected} مسترد۔",
  approved: "منظور شدہ",
  approved_values: "منظور شدہ اقدار",
  are_you_sure: "کیا آپ کو یقین ہے؟",
  article: "مضمون",
  article_name: "مضمون کا نام",
  article_sku: "آرٹیکل SKU",
  article_type: "مضمون کی قسم",
  article_type_fg: "تیار سامان (FG)",
  article_type_sfg: "نیم تیار سامان (SFG)",
  as_on: "جیسا آن",
  asset: "اثاثہ",
  asset_code: "اثاثہ کوڈ",
  asset_master: "اثاثہ ماسٹر",
  asset_master_description:
    "ٹولز، مولڈز، فکسچر اور لوازمات کے لیے اثاثہ ماسٹر کو برقرار رکھیں۔",
  asset_name: "اثاثہ کا نام",
  asset_type: "اثاثہ کی قسم",
  asset_types: "اثاثوں کی اقسام",
  asset_types_description:
    "اثاثوں اور قابل واپسی واؤچرز کے ذریعے استعمال ہونے والے اثاثوں کے زمرے کی وضاحت کریں۔",
  assets: "اثاثے",
  assets_description:
    "ظاہری اور قابل واپسی واؤچرز میں استعمال ہونے والے غیر اسٹاک اثاثوں کا نظم کریں۔",
  audit: "آڈٹ",
  audit_context_details: "آڈٹ سیاق و سباق کی تفصیلات",
  audit_logs: "سرگرمی لاگ",
  audit_logs_description: "سسٹم کی سرگرمیوں اور تبدیلیوں کو ٹریک کریں۔",
  auto_select_open_grn: "کھلی GRN مقداروں سے خودکار طور پر منتخب کریں۔",
  auto_translate: "خودکار ترجمہ",
  average_per_bucket: "فی بالٹی اوسط",
  average_per_bucket_help: "صرف غیر صفر بالٹیوں میں اوسط خالص خرچ؛",
  avg_purchase_rate: "اوسط خریداری کی شرح",
  current_purchase_rate: "موجودہ شرح",
  fixed_purchase_rate: "معیاری شرح",
  weighted_average_rate: "وزنی اوسط شرح",
  rate_difference: "شرح میں فرق",
  variance_amount: "فرق (رقم)",
  variance_percent: "فرق (%)",
  high_variance: "زیادہ فرق",
  high_variance_threshold: "زیادہ فرق کی حد",
  rate_alert_legend: "لیجنڈ",
  purchase_report_header_group_tooltip:
    "موجودہ آرڈر بائی انتخاب کے مطابق گروپ لیبل۔",
  purchase_report_header_voucher_no_tooltip:
    "خریداری ٹرانزیکشن کا سسٹم ووچر نمبر۔",
  purchase_report_header_date_tooltip:
    "منتخب فلٹر رینج میں ووچر کی پوسٹنگ تاریخ۔",
  purchase_report_header_bill_number_tooltip:
    "ووچر میں درج سپلائر بل/حوالہ نمبر۔",
  purchase_report_header_party_name_tooltip:
    "اس خریداری اندراج سے منسلک سپلائر۔",
  purchase_report_header_raw_material_tooltip: "خریداری لائن میں خام مال آئٹم۔",
  purchase_report_header_quantity_tooltip: "اس لائن/گروپ کی خریدی گئی مقدار۔",
  purchase_report_header_standard_rate_tooltip:
    "آر ایم ریٹ ماسٹر میں محفوظ معیاری (فکسڈ) شرح۔",
  purchase_report_header_weighted_avg_rate_tooltip:
    "آر ایم ریٹ ماسٹر کی وزنی اوسط تاریخی شرح۔",
  purchase_report_header_current_rate_tooltip:
    "اس ووچر لائن میں استعمال ہونے والی شرح۔",
  purchase_report_header_variance_amount_tooltip:
    "فرق کی رقم: موجودہ شرح - معیاری شرح۔",
  purchase_report_header_variance_percent_tooltip:
    "معیاری شرح کے مقابلے میں فرق کا فیصد۔",
  purchase_report_header_amount_tooltip: "لائن/گروپ رقم = مقدار x موجودہ شرح۔",
  purchase_report_header_branch_tooltip: "وہ برانچ جہاں ووچر پوسٹ کیا گیا۔",
  back: "پیچھے",
  back_to_branches: "شاخوں پر واپس جائیں۔",
  back_to_list: "فہرست پر واپس جائیں۔",
  balance: "توازن",
  balance_pending: "بیلنس زیر التوا ہے۔",
  bank_account: "بینک اکاؤنٹ",
  bank_payment: "بینک ادائیگی",
  bank_receipt: "بینک کی رسید",
  bank_transactions: "بینک ٹرانزیکشن رپورٹ",
  bank_voucher_description:
    "زیر التواء/کلیئرڈ/ناکام حوالوں کے ساتھ بینک واؤچرز بنائیں اور جمع کرائیں۔",
  barcode: "بارکوڈ",
  base_unit: "بیس یونٹ",
  basic_info: "بنیادی معلومات",
  basic_information: "بنیادی معلومات",
  basic_salary: "بنیادی تنخواہ",
  batch_dozen_rates: "بیچ درجن کے نرخ",
  before: "اس سے پہلے",
  biggest_increase_vs_previous: "سب سے بڑا اضافہ بمقابلہ پچھلی مدت",
  bill_count: "بل شمار",
  bill_number: "بل نمبر",
  bom: "BOM",
  bom_approval: "منظوری",
  bom_create_new_version: "نیا ورژن بنائیں",
  bom_description: "عالمی BOM ڈرافٹس، منظوریوں اور ورژنز کا نظم کریں۔",
  submit_bom_request: "BOM درخواست جمع کریں",
  bom_edit_title: "BOM میں ترمیم کریں۔",
  bom_error_already_pending:
    "اس BOM کے لیے ایک زیر التواء منظوری پہلے سے موجود ہے۔",
  bom_error_approve_requires_draft: "صرف BOM کا مسودہ منظور کیا جا سکتا ہے۔",
  bom_error_color_required_for_specific_scope:
    "مخصوص دائرہ کار کے لیے رنگ درکار ہے۔",
  bom_error_color_scope_not_allowed_no_sku_colors:
    "اس آرٹیکل میں SKU رنگی ویریئنٹس موجود نہیں۔ Color Scope میں 'All SKUs' منتخب کریں۔",
  bom_error_department_must_be_production:
    "Selected department must be an active Production department.",
  bom_error_draft_exists: "اس آئٹم اور سطح کے لیے ایک مسودہ پہلے سے موجود ہے۔",
  bom_error_existing_bom:
    "A BOM already exists for this article. Use BOM Register/Revise instead of Add BOM.",
  bom_error_item_not_found: "منتخب کردہ آئٹم موجود نہیں ہے۔",
  bom_error_item_required: "براہ کرم ایک آئٹم منتخب کریں۔",
  bom_error_labour_department_invalid:
    "منتخب لیبر اس شعبہ کے لیے درست نہیں ہے۔",
  bom_error_labour_line_invalid: "غلط لیبر لائن۔",
  bom_error_labour_department_duplicate:
    "وہی لیبر اسی شعبہ کے لیے دوبارہ شامل نہیں کیا جا سکتا۔",
  bom_error_labour_rate_type_invalid: "لیبر کی شرح کی غلط قسم۔",
  bom_error_level_item_mismatch: "منتخب کردہ سطح آئٹم کی قسم سے مماثل نہیں ہے۔",
  bom_error_level_required: "براہ کرم ایک درست BOM لیول منتخب کریں۔",
  bom_error_loss_pct_invalid: "عام نقصان % 0 اور 100 کے درمیان ہونا چاہیے۔",
  bom_error_material_required_for_specific_scope:
    "مخصوص دائرہ کار کے لیے ہدف کا مواد درکار ہے۔",
  bom_error_missing_material_rates: "مطلوبہ مواد کے نرخ غائب ہیں۔",
  bom_error_missing_material_rates_detail:
    "کے لیے فعال خریداری کی شرحیں غائب ہیں۔",
  bom_error_new_version_requires_approved:
    "نیا ورژن صرف منظور شدہ BOM سے بنایا جا سکتا ہے۔",
  bom_error_only_draft_editable: "صرف BOM کے مسودے میں ترمیم کی جا سکتی ہے۔",
  bom_error_output_qty_required: "آؤٹ پٹ کی مقدار صفر سے زیادہ ہونی چاہیے۔",
  bom_error_output_uom_required: "آؤٹ پٹ UOM درکار ہے۔",
  bom_error_item_base_uom_missing:
    "Selected article has no base unit. Please set Base Unit in product master first.",
  bom_error_output_uom_conversion_missing:
    "Output Unit must have an active conversion to the article Base Unit in UOM Conversions.",
  bom_error_packing_required_for_specific_scope:
    "پیکنگ کی قسم مخصوص دائرہ کار کے لیے درکار ہے۔",
  bom_error_rm_item_invalid: "خام مال کی لائن کو RM آئٹم کا حوالہ دینا چاہیے۔",
  bom_error_rm_line_invalid:
    "Complete this raw material row: select material, department, and quantity.",
  bom_error_rm_department_duplicate:
    "وہی میٹیریل اسی استعمال کرنے والے شعبہ کے ساتھ دوبارہ شامل نہیں کیا جا سکتا۔",
  bom_error_rm_uom_required: "خام مال UOM کی ضرورت ہے۔",
  bom_error_rm_color_required:
    "اس خام مال کے لیے رنگ منتخب کریں کیونکہ رنگ کے لحاظ سے ریٹس موجود ہیں۔",
  bom_error_rm_size_required:
    "اس خام مال کے لیے سائز منتخب کریں کیونکہ سائز کے لحاظ سے ریٹس موجود ہیں۔",
  bom_error_rm_color_invalid:
    "منتخب رنگ اس خام مال کے فعال ریٹس میں موجود نہیں ہے۔",
  bom_error_rm_size_invalid:
    "منتخب سائز اس خام مال کے فعال ریٹس میں موجود نہیں ہے۔",
  bom_error_sfg_item_invalid:
    "منتخب کردہ SKU کا تعلق نیم تیار شدہ شے سے ہونا چاہیے۔",
  bom_error_sfg_line_invalid: "غلط نیم تیار شدہ لائن۔",
  bom_error_sfg_section_incomplete:
    "Semi-Finished سیکشن کے تمام لازمی فیلڈز مکمل کریں (Article SKU، Step/Upper SKU، Step Quantity)۔",
  bom_error_sfg_not_allowed_for_sfg_level:
    "نیم تیار شدہ BOM میں SFG سیکشن لائنیں شامل نہیں ہو سکتیں۔",
  bom_error_sfg_requires_approved_bom:
    "منتخب کردہ SFG آئٹم میں کوئی منظور شدہ BOM نہیں ہے۔",
  bom_error_sfg_uom_required: "SFG UOM درکار ہے۔",
  bom_error_size_required_for_specific_scope:
    "مخصوص دائرہ کار کے لیے سائز درکار ہے۔",
  bom_error_snapshot_mismatch: "ڈرافٹ سنیپ شاٹ مماثل نہیں ہے۔",
  bom_error_fix_fields: "BOM بھیجنے سے پہلے تمام لازمی فیلڈز مکمل کریں۔",
  bom_error_variant_action_invalid: "مختلف قسم کی کارروائی کی غلط قسم۔",
  bom_error_color_rules_required_no_sku_colors:
    "اس آرٹیکل میں SKU رنگی ویریئنٹس موجود نہیں۔ ہر ایسے خام مال کے لیے Color Rules شامل کریں جس کے اندر متعدد رنگی ریٹس ہیں۔",
  bom_error_color_rule_missing_for_material_prefix:
    "اس میٹیریل کے لیے Color Rule موجود نہیں",
  bom_error_variant_value_invalid_json: "غلط ویرینٹ ویلیو پے لوڈ۔",
  bom_header: "BOM سیٹ اپ",
  bom_header_required_message:
    "پہلے BOM سیٹ اپ مکمل کریں۔ اس کے بعد میٹیریل، SFG اور لیبر سیکشن کھلیں گے۔",
  bom_list: "BOM رجسٹر",
  bom_new_title: "BOM شامل کریں۔",
  bom_normal_loss_pct: "عام نقصان %",
  bom_output_qty: "آؤٹ پٹ کی مقدار",
  bom_output_batch_size: "منصوبہ شدہ آؤٹ پٹ مقدار",
  bom_output_uom: "آؤٹ پٹ یونٹ (UOM)",
  bom_rm_rules_size_wise: "سائز کے مطابق خام مال کے قواعد",
  bom_rm_section_hint:
    "Material Lines: enter quantity only when all SKUs use the same raw material quantity for BOM Header Planned Output Qty. Otherwise use SKU Rules.",
  bom_rm_view_material_lines: "میٹیریل لائنز",
  bom_rm_view_variant_rules: "سائز رولز",
  bom_sku_rules: "SKU Rules",
  bom_advanced_rules: "Advanced Rules",
  bom_sku_rules_hint:
    "SKU Rules: enter per-SKU quantity for BOM Header Planned Output Qty when usage differs by SKU/size. Leave blank to fallback to Material Lines.",
  bom_select_sku: "Select SKU",
  bom_no_sku_available: "No SKU available for selected article.",
  bom_no_material_lines_for_sku_rules:
    "Add material lines first to edit SKU rules.",
  bom_labour_selection_title: "لیبر انتخاب",
  bom_labour_selection_hint:
    "Rows are auto-loaded from active Labour Rates for the selected article. Review and adjust only if needed.",
  bom_labour_size_rules_title: "سائز رولز",
  bom_labour_size_rules_hint: "یہ ریٹس اسی سائز والے تمام SKU پر لاگو ہوں گے۔",
  bom_labour_sku_rules_hint:
    "SKU منتخب کریں اور لیبر ریٹس سیٹ کریں۔ یہ ریٹس منتخب SKU کے سائز اسکوپ کے مطابق لاگو ہوں گے۔",
  bom_no_labour_selected:
    "سائز کے مطابق ریٹس سیٹ کرنے کے لیے پہلے لیبر لائنز شامل کریں۔",
  bom_color_scope_hint:
    "میٹیریل کلر میپنگ میں ترمیم کے لیے SKU ویریئنٹ اسکوپ منتخب کریں۔",
  bom_rm_col_material: "میٹیریل",
  bom_rm_col_color: "رنگ کی قسم",
  bom_rm_col_size: "سائز کی قسم",
  bom_rm_col_department: "استعمال کرنے والا ڈیپارٹمنٹ",
  bom_rm_col_actions: "اعمال",
  bom_sku_variant_scope: "SKU ویریئنٹ اسکوپ",
  bom_hint_material: "?? BOM ??? ??????? ???? ???? ??? ??? ????? ?????",
  bom_hint_base_unit:
    "??? ???? ????? ??????? ?? ??? ?? ???? ?? ??? ??? ????? ???? ??? ?? ?????",
  bom_hint_consumption_department:
    "??????? ????????? ?? ?? ??????? ?? ??????? ???? ???",
  bom_hint_actions: "???/????? ?? ??? ???? ?? ??? ?????",
  bom_hint_size_rule_material: "?? ??????? ?? ?? ???? ??? ???? ?????",
  bom_hint_size_rule_uom: "???? ??? ????? ?? ??? ?????",
  bom_hint_size_rule_qty: "????? ???? ?? ??? ????? ??????",
  bom_hint_color_rule_material:
    "?? ??????? ?? ?? ??? ????? ?? ?????? ???? ????? ????",
  bom_hint_rm_color: "????? SKU ????? ?? ??? ??????? ???? ???? ??? ??? ?? ????",
  bom_hint_packing_rule_material: "?????? ??????? ??? ?????? ??? ???? ???",
  bom_hint_packing: "?? ????????? ?? ??? ????? ?? ????",
  bom_hint_size_optional:
    "??????? ???? ????? ???? ????? ?? ???? ???? ?? ??? ???? ???????",
  bom_hint_replace_with: "?????? ??????? ?? ??? ??????? ???? ???? ????????",
  bom_hint_sku: "?? ?????? ??? ?? ??? ????? SKU?",
  bom_hint_target_rm: "?? SKU ?? ??? ????????? ???? ???? ???? ??? ????",
  bom_hint_override_qty: "?? SKU ??? ??????? ?? ??? ??????? ????? ??????????",
  bom_hint_exclude: "????? SKU ?? ??? ?? ??????? ?? ???? ?????",
  bom_hint_size: "?? ???? ?? ??? ???? ??????",
  bom_hint_article_sku: "?? ???? ?? ???? SKU ?? ???? ???? ???",
  bom_hint_semi_finished: "?? BOM ??? ??????? ???? ???? ??? ???? SKU?",
  bom_hint_step_upper_sku:
    "?? ???? SKU ?? ??? ??????? ???? ???? ??? ???? SKU ????? ?????",
  bom_hint_step_sku: "?? ???? SKU ?? ??? Step SKU ????? ?????",
  bom_hint_upper_sku: "?? ???? SKU ?? ??? Upper SKU ????? ?????",
  bom_hint_required_qty: "?? ???? ?? ??? ????? ??????",
  bom_hint_step_quantity: "????? Step/Upper SKU ?? ????? ????? ??? ?????",
  bom_hint_labour: "???? ???? ???? ?? ??? ???? ????? ????? ?????",
  bom_hint_department: "?? ???? ?? ??? ??????? ??????????",
  bom_hint_rate_type: "???? ?? ???? (?? ???? ?? ?? ????)?",
  bom_hint_rate_value: "????? ???? ?? ????? ??? ??????",
  bom_source_base: "Base",
  bom_source_size_rule: "Size Rule",
  bom_source_color_rule: "Color Rule",
  bom_source_packing_rule: "Packing Rule",
  bom_source_sku_override: "SKU Override",
  bom_source_excluded: "Excluded",
  bom_rules_size_picker_hint:
    "جس سائز کے لیے قواعد تبدیل کرنے ہیں، وہ سائز منتخب کریں۔",
  bom_rules_active_size_label: "اس سائز کے قواعد میں ترمیم",
  bom_rules_count_label: "رولز",
  bom_rules_col_qty: "درکار مقدار",
  bom_rules_col_uom: "یونٹ",
  bom_sfg_col_step_upper_sku: "Step/Upper SKU",
  bom_sfg_col_step_qty: "Step Quantity",
  bom_sfg_col_consumed_stage: "Consumed In Stage",
  bom_all_skus: "تمام SKU",
  bom_all_skus_no_color: "تمام SKU (رنگی ویریئنٹ موجود نہیں)",
  bom_rule_add_rm: "RM شامل کریں۔",
  bom_rule_adjust_qty: "مقدار کو ایڈجسٹ کریں۔",
  bom_rule_change_loss: "نقصان کو تبدیل کریں۔",
  bom_rule_remove_rm: "RM کو ہٹا دیں۔",
  bom_rule_replace_rm: "RM کو تبدیل کریں۔",
  bom_specific: "مخصوص",
  bom_tab_labour: "سائز اور ڈیپارٹمنٹ کے مطابق لیبر ریٹس",
  bom_tab_rm:
    "List Raw Material Used for This Article (Based on BOM Header Planned Output Qty)",
  bom_tab_sfg: "استعمال ہونے والی نیم تیار مصنوعات (اگر ہوں)",
  bom_tab_sfg_per_sku: "ہر SKU کے لیے استعمال ہونے والی نیم تیار مصنوعات",
  bom_tab_variant_rules: "متغیر قواعد",
  bom_version_created: "نیا ورژن بنایا گیا۔",
  bom_versions: "ورژنز",
  bom_versions_description:
    "آئٹم اور سطح کے لحاظ سے ورژن کی تاریخ اور حیثیت کو ٹریک کریں۔",
  book_number: "کتاب کا نمبر",
  branch_code: "برانچ کوڈ",
  branch_name_ur: "برانچ کا نام (اردو)",
  branch_not_found: "برانچ نہیں ملی۔",
  branches: "شاخیں",
  cancel: "منسوخ کریں۔",
  cash_account: "کیش اکاؤنٹ",
  cash_account_required: "نقد خریداری کے لیے کیش اکاؤنٹ درکار ہے۔",
  cash_book: "کیش بک",
  cash_paid_account: "کیش پیڈ اکاؤنٹ",
  cash_payment: "نقد ادائیگی",
  cash_purchase: "نقد خریداری",
  cash_receipt: "نقد رسید",
  cash_sale: "کیش سیل",
  cash_voucher: "کیش واؤچر",
  cash_voucher_description:
    "منظوری کے لیے تیار ورک فلو کے ساتھ نقد ادائیگی/رسید واؤچر بنائیں اور جمع کروائیں۔",
  cash_voucher_register: "کیش واؤچر رجسٹر",
  cashier: "کیشئیر",
  cashiers: "کیشیئرز",
  category: "زمرہ",
  change_percentage: "تبدیلی %",
  change_summary: "تبدیلی کا خلاصہ",
  change_vs_previous: "تبدیلی بمقابلہ پچھلا",
  change_vs_previous_help:
    "مثبت کا مطلب ہے گزشتہ مدت کے مقابلے اخراجات میں اضافہ۔",
  changed_fields: "تبدیل شدہ فیلڈز",
  check_availability: "دستیابی چیک کریں۔",
  choose_option_top_right: "اوپری دائیں سے آپشن کا انتخاب کریں۔",
  choose_role_above:
    "اجازتوں کو دیکھنے اور اپ ڈیٹ کرنے کے لیے اوپر ایک کردار کا انتخاب کریں۔",
  choose_role_or_user_above:
    "اجازتوں کو ترتیب دینے کے لیے اوپر ایک کردار یا صارف کا انتخاب کریں۔",
  clear: "صاف",
  closing_balance: "اختتامی بیلنس",
  cnic: "CNIC",
  code: "کوڈ",
  collapse: "سمٹنا",
  color_rates: "رنگ کے نرخ",
  colors: "رنگ",
  commission_basis: "کمیشن کی بنیاد",
  commission_basis_fixed_per_invoice: "فی انوائس فکسڈ",
  commission_basis_fixed_per_unit: "فکسڈ فی بنیادی یونٹ",
  commission_basis_gross_margin_percent: "مجموعی مارجن کا %",
  commission_basis_net_sales_percent: "خالص فروخت کا %",
  condition_at_dispatch: "ڈسپیچ کے وقت حالت",
  condition_on_return: "واپسی کی حالت",
  config: "ترتیب",
  context: "سیاق و سباق",
  continue: "جاری رکھیں",
  contribution_to_delta: "ڈیلٹا کا %",
  contribution_to_delta_tooltip:
    "دکھائے گئے ڈرائیوروں میں ہر قطار کا حصہ مطلق تبدیلی۔",
  contribution_to_driver_movement: "ڈرائیور کی نقل و حرکت کا %",
  conversion_exists: "تبدیلی پہلے سے موجود ہے۔",
  conversion_factor: "تبادلوں کا عنصر صفر سے زیادہ ہونا چاہیے۔",
  conversion_same_units: "سے اور تک یونٹس ایک جیسے نہیں ہو سکتے۔",
  coverage_scope_both: "دونوں",
  coverage_scope_fg: "ختم",
  coverage_scope_sfg: "نیم تیار",
  created: "بنایا",
  created_at: "پر تخلیق کیا گیا۔",
  created_by: "کے ذریعہ تخلیق کیا گیا۔",
  credit: "کریڈٹ",
  credit_allowed: "کریڈٹ کی اجازت ہے۔",
  credit_purchase: "کریڈٹ پرچیز",
  credit_sale: "کریڈٹ سیل",
  credits_adjustments: "کریڈٹ / ایڈجسٹمنٹ",
  current_dozen_rate: "موجودہ درجن کی شرح",
  current_period: "موجودہ دور",
  current_period_total: "موجودہ مدت کا کل",
  customer: "گاہک",
  customer_balance_information: "کسٹمر بیلنس کی معلومات",
  customer_balances_report: "کسٹمر بیلنس کی رپورٹ",
  customer_contact_analysis: "کسٹمر رابطہ تجزیہ",
  customer_ledger_report: "کسٹمر لیجر رپورٹ",
  customer_listings: "گاہک کی فہرستیں",
  customer_name: "گاہک کا نام",
  customer_pickup: "کسٹمر پک اپ",
  customer_reports: "کسٹمر رپورٹس",
  daily: "روزانہ",
  dashboard: "ڈیش بورڈ",
  date_filters_auto_corrected:
    "تاریخ کے کچھ فلٹرز غلط تھے اور انہیں دوبارہ ترتیب دیا گیا ہے۔",
  date_range: "تاریخ کی حد",
  deactivate: "غیر فعال کریں۔",
  debit: "ڈیبٹ",
  decision: "فیصلہ",
  deleted_successfully: "کامیابی سے حذف کر دیا گیا۔",
  deletion_requested: "حذف کرنے کی درخواست کی گئی۔",
  delivery_method: "ترسیل کا طریقہ",
  delta: "ڈیلٹا",
  delta_tooltip: "موجودہ مدت کا کل مائنس پچھلی مدت کا کل۔",
  department: "محکمہ",
  department_breakdown: "محکمہ کی خرابی۔",
  departments: "محکمے",
  production_stages: "Production Stages",
  departments_description: "پیداوار بمقابلہ غیر پیداواری لاگت کے مراکز۔",
  designation_role: "عہدہ/ کردار",
  details: "تفصیلات",
  dismiss: "برطرف کرنا",
  dozen_rate: "درجن ریٹ",
  drilldown_starts_at: "ڈرل ڈاؤن شروع ہوتا ہے۔",
  dropped_to_zero: "صفر پر گر گیا۔",
  edit: "ترمیم کریں۔",
  edit_branch: "برانچ میں ترمیم کریں۔",
  edit_rates: "شرحوں میں ترمیم کریں۔",
  edit_role: "کردار میں ترمیم کریں۔",
  effective_from: "سے موثر",
  effective_to: "کے لیے موثر",
  employees: "ملازمین",
  employees_description:
    "HR اور پے رول کے لیے ملازم کے ماسٹر ریکارڈ کا نظم کریں۔",
  enter: "داخل کریں۔",
  enter_code: "کوڈ درج کریں۔",
  enter_details_save: "تفصیلات درج کریں اور محفوظ کریں۔",
  enter_note: "ایک نوٹ درج کریں۔",
  entity: "ہستی",
  entity_id: "ہستی کی شناخت",
  entity_type: "ہستی کی قسم",
  entries: "اندراجات",
  error_action_not_allowed: "اس عمل کی اجازت نہیں ہے۔",
  error_add_valid_purchase_rate:
    "براہ کرم کم از کم ایک درست خریداری کی شرح شامل کریں۔",
  error_advance_receive_enabled_no_amount:
    "ایڈوانس وصولی فعال ہے لیکن کوئی ایڈوانس ادائیگی کی رقم درج نہیں کی گئی۔",
  error_branch_code_exists: "برانچ کوڈ پہلے سے موجود ہے۔",
  error_branch_out_of_scope:
    "ایک یا زیادہ منتخب شاخیں آپ کی برانچ کی رسائی سے باہر ہیں۔",
  error_cash_received_must_equal_final:
    "وصول شدہ رقم نقد فروخت کے لیے حتمی رقم کے برابر ہونی چاہیے۔",
  error_cash_sale_no_advanced_amount:
    "نقد فروخت کے لیے ایڈوانسڈ وصول شدہ رقم درکار ہے۔",
  error_cash_voucher_single_direction:
    "کیش واؤچر ایک طرف ہونا چاہیے: رسید یا ادائیگی کا استعمال کریں۔",
  error_delete: "حذف کرنے سے قاصر۔",
  error_duplicate_allowance_rule:
    "اس ملازم کے لیے الاؤنس کی قسم پہلے سے موجود ہے۔",
  error_duplicate_cnic: "CNIC پہلے سے موجود ہے۔",
  error_duplicate_code: "کوڈ پہلے سے موجود ہے۔",
  error_duplicate_commission_rule: "اسی طرح کا کمیشن کا اصول پہلے سے موجود ہے۔",
  error_duplicate_labour_rate_rule:
    "اسی طرح کی مزدوری کی شرح کا اصول پہلے سے موجود ہے۔",
  error_duplicate_name:
    "درخواست منظور نہیں ہو سکی کیونکہ نام پہلے سے موجود ہے۔",
  error_duplicate_phone_number: "فون نمبر پہلے سے موجود ہے۔",
  error_duplicate_record: "اسی تفصیلات کے ساتھ ایک ریکارڈ پہلے سے موجود ہے۔",
  error_generic: "خرابی",
  error_group_subgroup_only_for_bulk_commission:
    "اس اسکرین کے لیے، گروپ/سب گروپ کمیشن کی تبدیلیوں کی اجازت صرف بلک سیو کے ذریعے ہے۔",
  error_immutable_field: "طبعی مختلف خصوصیات میں ترمیم نہیں کی جا سکتی۔",
  error_invalid_account_group: "اکاؤنٹ کا غلط گروپ منتخب کیا گیا۔",
  error_invalid_amount_type: "رقم کی غلط قسم منتخب کی گئی۔",
  error_invalid_apply_on: "درخواست پر غلط انتخاب۔",
  error_invalid_article_type: "غلط مضمون کی قسم منتخب کی گئی۔",
  error_invalid_bulk_commission_payload: "غلط بلک کمیشن پے لوڈ۔",
  error_invalid_bulk_labour_rate_payload: "غلط لیبر ریٹ پے لوڈ۔",
  error_invalid_cnic: "غلط CNIC فارمیٹ۔",
  error_invalid_commission_basis: "کمیشن کی بنیاد پر غلط انتخاب کیا گیا۔",
  error_invalid_frequency: "غلط فریکوئنسی منتخب کی گئی۔",
  error_invalid_payroll_type: "پے رول کی غلط قسم منتخب کی گئی۔",
  error_invalid_phone_number: "فون نمبر کی غلط شکل۔",
  error_invalid_posting_class: "غلط پوسٹنگ کلاس منتخب کی گئی۔",
  error_invalid_production_category: "غلط پروڈکشن زمرہ منتخب کیا گیا۔",
  error_invalid_rate_type: "غلط شرح کی قسم منتخب کی گئی۔",
  error_invalid_rate_value: "غلط قدر",
  error_invalid_salary: "بنیادی تنخواہ ایک غیر منفی نمبر ہونی چاہیے۔",
  error_invalid_salary_precision:
    "بنیادی تنخواہ صرف 2 اعشاریہ 2 مقامات اور درست حد تک سپورٹ کرتی ہے۔",
  error_invalid_status: "غلط حیثیت کا انتخاب کیا گیا۔",
  error_invalid_value: "ایک یا زیادہ قدریں غلط ہیں۔",
  error_invalid_value_type: "غلط قدر کی قسم منتخب کی گئی۔",
  error_no_target_skus_found: "منتخب فلٹرز کے لیے کوئی ہدف SKUs نہیں ملے۔",
  error_party_group_type: "پارٹی کی قسم منتخب گروپ سے مماثل نہیں ہے۔",
  error_record_in_use:
    "یہ ریکارڈ ERP کے دیگر حصوں میں استعمال ہو رہا ہے، اس لئے اسے حذف نہیں کیا جا سکتا۔",
  error_required_fields: "براہ کرم تمام مطلوبہ فیلڈز کو پُر کریں۔",
  error_saving: "محفوظ کرنے میں خرابی۔",
  error_select_article_type: "براہ کرم مضمون کی قسم منتخب کریں۔",
  error_select_branch: "براہ کرم ایک برانچ منتخب کریں۔",
  error_select_city: "براہ کرم شہر کا انتخاب کریں۔",
  error_select_commission_basis: "براہ کرم کمیشن کی بنیاد پر انتخاب کریں۔",
  error_select_department: "براہ کرم ایک شعبہ منتخب کریں۔",
  error_labour_department_in_use:
    "Department cannot be removed from labour because existing vouchers/rates/BOM already reference it.",
  error_select_group: "براہ کرم ایک پروڈکٹ گروپ منتخب کریں۔",
  error_select_labour: "براہ کرم ایک لیبر منتخب کریں۔",
  error_select_party_group: "براہ کرم پارٹی گروپ منتخب کریں۔",
  error_select_phone: "براہ کرم کم از کم ایک فون نمبر درج کریں۔",
  error_select_rate_type: "براہ کرم شرح کی قسم منتخب کریں۔",
  error_dcv_missing_labour_rate_for_sku:
    "Line {line}: {sku} ke liye labour rate missing hai. Labour + Department + SKU combination Labour Rates mein add karein.",
  error_select_sku: "براہ کرم ایک مضمون (SKU) منتخب کریں۔",
  error_select_subgroup: "براہ کرم ایک پروڈکٹ ذیلی گروپ منتخب کریں۔",
  error_select_vendor_capabilities:
    "براہ کرم سپلائر کے لیے کم از کم ایک وینڈر کی اہلیت کا انتخاب کریں۔",
  error_unable_save: "محفوظ کرنے سے قاصر۔",
  error_unit_code_locked: "یونٹ کوڈ کو تبدیل نہیں کیا جا سکتا۔",
  error_update_status: "اسٹیٹس کو اپ ڈیٹ کرنے سے قاصر۔",
  exclude: "خارج کرنا",
  expand: "پھیلائیں۔",
  expanded: "توسیع شدہ",
  expected_return_date: "متوقع واپسی کی تاریخ",
  expense_analysis: "اخراجات کے تجزیہ کی رپورٹ",
  expense_breakdown: "اخراجات کی خرابی۔",
  expense_credit_dominant_warning:
    "کچھ ادوار خالص الٹ پلٹ ہوتے ہیں (کریڈٹ ڈیبٹ سے زیادہ ہوتے ہیں)۔",
  expense_trends: "اخراجات کے رجحانات کی رپورٹ",
  extra_discount: "اضافی رعایت",
  factor: "عامل",
  field_required: "یہ فیلڈ درکار ہے۔",
  filter_primary: "پرائمری فلٹر",
  filter_secondary: "ثانوی فلٹر",
  filters: "فلٹرز",
  final_amount: "حتمی رقم",
  financial_reports: "مالیاتی رپورٹس",
  finished: "ختم",
  finished_description:
    "تیار سامان کی اشیاء اور ان کی مختلف حالتوں کا نظم کریں۔",
  finished_goods: "تیار سامان",
  finished_setup_note: "تیار اشیاء کے لیے سائز اور مختلف سیٹ اپ ترتیب دیں۔",
  frequency: "تعدد",
  frequency_daily: "روزانہ",
  frequency_monthly: "ماہانہ",
  from_unit: "یونٹ سے",
  gate_pass: "گیٹ پاس",
  general_purchase: "عام خریداری",
  general_purchase_description:
    "کیش یا کریڈٹ کے لیے سپلائر انوائس ریکارڈ کریں اور خودکار حوالہ اوپن GRNs۔",
  general_purchase_voucher: "عام خریداری واؤچر",
  generated_combinations: "پیدا کردہ امتزاج",
  generic_error: "خرابی",
  goods_receipt_note: "سامان کی رسید کا نوٹ",
  goods_receipt_note_description:
    "جب ریٹس ابھی طے نہیں ہوئے ہیں تو ریکارڈ خام مال کی مقدار موصول ہوئی ہے۔",
  goods_receipt_note_voucher: "سامان کی رسید نوٹ واؤچر",
  grade: "گریڈ",
  grade_rank: "گریڈ رینک",
  grades: "درجات",
  grand_total: "گرینڈ ٹوٹل",
  grn_reference: "GRN حوالہ",
  gross_expense: "مجموعی اخراجات",
  group: "گروپ",
  group_header: "گروپ ہیڈر",
  groups: "گروپس",
  groups_description:
    "پروڈکٹس، پارٹیوں، اکاؤنٹس اور محکموں میں استعمال ہونے والے گروپس کا نظم کریں۔",
  help_posting_class:
    "پوسٹنگ رویے کے لیے اختیاری درجہ بندی کا استعمال کیا جاتا ہے (مثال کے طور پر، بینک)۔",
  help_unit_code:
    "سسٹم کے ذریعے استعمال ہونے والی مختصر منفرد کلید (جیسے، PCS، KG)۔",
  help_unit_name: "وضاحتی نام رپورٹوں اور دستاویزات پر دکھایا گیا ہے۔",
  highest_bill: "سب سے زیادہ بل",
  highest_bucket: "چوٹی کے اخراجات کی مدت",
  home_branch: "ہوم برانچ",
  hr_screen_description:
    "اسی یونیورسل ورک فلو اور منظوریوں کا استعمال کرتے ہوئے HR اور پے رول سیٹ اپ کا نظم کریں۔",
  hr_screen_planned_note: "یہ اسکرین کا راستہ فعال ہے اور اجازتوں سے منسلک ہے۔",
  id: "ID",
  impact: "اثر",
  inactive: "غیر فعال",
  include: "شامل کریں۔",
  include_na: "N/A شامل کریں۔",
  include_non_department_postings: "غیر محکمانہ پوسٹنگ شامل کریں (N/A)",
  include_non_department_postings_hint:
    "ان لائنوں پر مشتمل ہے جہاں محکمہ لاگو نہیں ہے (نقد/بینک/ ایڈوانسز/ ٹرانسفرز)۔",
  incorrect_credentials: "غلط صارف نام یا پاس ورڈ۔",
  inventory_reports: "انوینٹری رپورٹس",
  stock_amount_report: "اسٹاک اماؤنٹ رپورٹ",
  stock_balances_report: "اسٹاک بیلنسز رپورٹ",
  stock_ledger_report: "اسٹاک لیجر رپورٹ",
  stock_movement_report: "اسٹاک موومنٹ رپورٹ",
  stock_transfer_report: "اسٹاک ٹرانسفر رپورٹ",
  transfer_out: "ٹرانسفر آؤٹ",
  transfer_in: "ٹرانسفر اِن",
  pair_quantity: "جوڑا مقدار",
  qty_out: "آؤٹ مقدار",
  transfer_status: "ٹرانسفر اسٹیٹس",
  partially_approved: "جزوی منظور شدہ",
  ref_bill_no: "ریفرنس/بل نمبر",
  voucher_count: "واؤچر گنتی",
  mixed: "مخلوط",
  dispatch_date: "ڈسپیچ تاریخ",
  received_date: "موصول تاریخ",
  stock_ledger_error_select_date_range:
    "اسٹاک لیجر رپورٹ لوڈ کرنے کے لئے درست تاریخ کی حد منتخب کریں۔",
  stock_ledger_error_select_stock_item:
    "اسٹاک لیجر رپورٹ لوڈ کرنے کے لئے SKU یا خام مال منتخب کریں۔",
  sale_rate_basis: "سیل بنیاد",
  cost_rate_basis: "کاسٹ بنیاد",
  inventory_voucher: "انوینٹری واؤچر",
  opening_stock_voucher: "اوپننگ اسٹاک واؤچر",
  item_name: "آئٹم کا نام",
  item_selector: "آئٹم سلیکٹر",
  item_type: "آئٹم کی قسم",
  items_label: "اشیاء",
  journal_type: "جرنل کی قسم",
  journal_voucher: "جرنل واؤچر",
  journal_voucher_description:
    "جمع، ایڈجسٹمنٹ، اور بند اندراجات کے لیے متوازن جرنل واؤچرز بنائیں۔",
  journal_voucher_register: "جرنل واؤچر رجسٹر",
  labours: "لیبرز",
  labours_description:
    "پیداوار اور اجرت کی کارروائی کے لیے لیبر ماسٹر ریکارڈز کا نظم کریں۔",
  last_30_days: "آخری 30 دن",
  last_3_months: "پچھلے 3 مہینے",
  last_7_days: "آخری 7 دن",
  last_month: "پچھلے مہینے",
  last_purchase_date: "آخری خریداری کی تاریخ",
  level: "سطح",
  bom_stage: "مرحلہ",
  bom_workflow_stage: "مرحلہ",
  bom_stage_mandatory_in_flow: "فلو میں لازمی",
  bom_stage_strict_sequence: "ترتیب لازمی",
  level_account: "اکاؤنٹ لیول",
  level_department: "ڈیپارٹمنٹ لیول",
  level_group: "گروپ لیول",
  line_count: "لائن شمار",
  line_item: "لائن آئٹم",
  load_failed: "مواد لوڈ کرنے میں ناکام۔",
  load_report_to_view:
    "فلٹرز کو منتخب کریں اور رپورٹ دیکھنے کے لیے لوڈ پر کلک کریں۔",
  load_skus: "SKUs لوڈ کریں۔",
  loading: "لوڈ ہو رہا ہے۔",
  lock_posting: "لاک پوسٹنگ",
  login: "لاگ ان",
  login_failed: "لاگ ان ناکام ہو گیا۔",
  loose: "ڈھیلا",
  manage_company_locations: "برانچ کے مقامات اور دستیابی کا نظم کریں۔",
  manage_permissions: "اجازتوں کا نظم کریں۔",
  account_access: "اکاؤنٹ رسائی",
  account_access_subtitle:
    "طے کریں کہ یہ صارف اکاؤنٹ ایکٹیویٹی میں کون سے اکاؤنٹس نہیں دیکھ سکتا۔",
  account_access_financial_reports_context:
    "فنانشل -> رپورٹس: اکاؤنٹ ایکٹیویٹی پابندیاں",
  block_summary: "خلاصہ بلاک کریں",
  block_view_details: "تفصیلی ویو بلاک کریں",
  account_details_access_limited:
    "منتخب اکاؤنٹ کے لیے تفصیلی ویو دستیاب نہیں۔ خلاصہ دستیاب ہے۔",
  account_access_saved: "اکاؤنٹ رسائی محفوظ ہو گئی۔",
  account_access_save_failed: "اکاؤنٹ رسائی محفوظ نہیں ہو سکی۔",
  user_not_found: "صارف نہیں ملا۔",
  material_capability: "مواد",
  min_stock: "کم از کم اسٹاک",
  modules: "ماڈیولز",
  monthly: "ماہانہ",
  monthly_short_range_daily_hint: "ٹائم گرانورٹی: ماہانہ۔",
  name: "نام",
  name_ur: "نام (اردو)",
  net_expense: "خالص اخراجات",
  net_expense_previous_period: "خالص خرچ (پچھلی مدت)",
  net_expense_this_period: "خالص خرچ (اس مدت)",
  network_error: "نیٹ ورک کی خرابی۔",
  new: "نیا",
  new_combinations_found: "نئے امتزاج ملے۔",
  new_dozen_rate: "نیا درجن ریٹ",
  new_expense: "نیا خرچہ",
  new_rate: "نیا ریٹ",
  new_value: "نئی قدر",
  no: "نہیں",
  no_data: "کوئی ڈیٹا نہیں ملا۔",
  no_data_for_selected_period: "منتخب مدت کے لیے اخراجات کے اندراجات نہیں ملے۔",
  no_entries: "ابھی تک کوئی اندراج نہیں ہے۔",
  no_labours_found_for_department:
    "منتخب محکمہ کے لیے کوئی فعال مزدور نہیں ملا۔",
  no_navigate_access_message:
    "ریکارڈز پوشیدہ ہیں کیونکہ آپ کو نیویگیشن تک رسائی نہیں ہے۔",
  no_new_combinations: "تمام منتخب کردہ امتزاج پہلے سے موجود ہیں۔",
  no_records_found: "کوئی ریکارڈ نہیں ملا",
  non_production_expense: "غیر پیداواری اخراجات کا تجزیہ",
  note: "نوٹ",
  of: "کی",
  ok: "ٹھیک ہے",
  old_rate: "پرانا ریٹ",
  old_value: "پرانی قدر",
  one_color: "ایک رنگ",
  one_size: "ایک سائز",
  open: "کھولیں۔",
  open_qty: "کھولیں مقدار",
  opening_balance: "اوپننگ بیلنس",
  order_by: "آرڈر بذریعہ",
  others: "دوسرے",
  our_delivery: "ہماری ڈیلیوری",
  overridden: "اوور رائڈ",
  override_mode_active: "اوور رائیڈ موڈ فعال ہے۔",
  packed: "پیک",
  packing: "پیکنگ",
  packing_type: "پیکنگ کی قسم",
  packing_types: "پیکنگ کی اقسام",
  pair_discount: "جوڑی ڈسکاؤنٹ",
  pair_rate: "جوڑی کی شرح",
  pairs: "جوڑے",
  unit_pair: "جوڑا",
  unit_dozen: "درجن",
  parties: "پارٹیاں",
  parties_label: "پارٹیاں",
  party_code: "پارٹی کوڈ",
  party_group: "پارٹی گروپ",
  party_groups: "پارٹی گروپس",
  party_groups_description: "صارفین اور سپلائرز کو تقسیم کریں۔",
  party_name: "پارٹی کا نام",
  party_type: "پارٹی کی قسم",
  password: "پاس ورڈ",
  payee: "ادا کرنے والا",
  payment_due_date: "ادائیگی کی آخری تاریخ",
  payroll_daily: "روزانہ",
  payroll_monthly: "ماہانہ",
  payroll_multiple: "متعدد",
  payroll_piece_rate: "پیس ریٹ",
  payroll_type: "پے رول کی قسم",
  payroll_wage_balance: "پے رول اور اجرت کے توازن کی رپورٹ",
  pending: "زیر التواء",
  pending_delivery_qty: "زیر التواء ترسیل کی مقدار",
  percent_of_department: "محکمہ کا %",
  percent_of_total: "کل کا %",
  period: "مدت",
  permanent_delete: "مستقل حذف کریں۔",
  permanent_delete_message: "یہ عمل مستقل طور پر ریکارڈ کو حذف کر دیتا ہے۔",
  permissions_read_only_hint:
    "آپ کو دیکھنے کی اجازت تک رسائی حاصل ہے، لیکن آپ ان میں ترمیم نہیں کر سکتے۔",
  permissions_subtitle: "صارف اور کردار تک رسائی کی سطحوں کا نظم کریں۔",
  permissions_tip_approve:
    "ریکارڈ کی حیثیت کو حتمی شکل دینے کا اختیار دیتا ہے۔",
  permissions_tip_create:
    "نئی اندراجات کو محفوظ کرنے کے لیے نیا فارم شامل کریں کو فعال کرتا ہے۔",
  permissions_tip_deactivate:
    "ریکارڈز کو غیر فعال کرنے کے اختیار کو فعال کرتا ہے۔",
  permissions_tip_delete: "مستقل طور پر ریکارڈ کو ہٹاتا ہے۔",
  permissions_tip_download: "ڈاؤن لوڈ اور ایکسپورٹ بٹن کو فعال کرتا ہے۔",
  permissions_tip_edit:
    "موجودہ ریکارڈز میں ڈیٹا کو تبدیل کرنے کی صلاحیت کو غیر مقفل کرتا ہے۔",
  permissions_tip_navigate: "موجودہ ریکارڈز میں نیویگیٹ کرنے کی اجازت دیتا ہے۔",
  permissions_tip_view: "اس ماڈیول کو کھولنے کی اجازت دیتا ہے۔",
  permissions_tip_load: "فلٹرز کے ساتھ رپورٹ ڈیٹا لوڈ کرنے کی اجازت دیتا ہے۔",
  permissions_tip_view_details:
    "رپورٹ سے ووچر/انوائس تفصیل لنکس کھولنے کی اجازت دیتا ہے۔",
  permissions_tip_print: "رپورٹ پرنٹ آؤٹ کی اجازت دیتا ہے۔",
  permissions_tip_export_excel_csv:
    "رپورٹ کو ایکسل/CSV میں ایکسپورٹ کرنے کی اجازت دیتا ہے۔",
  permissions_tip_filter_all_branches:
    "اپنی برانچ کے بجائے تمام برانچز پر فلٹر لگانے کی اجازت دیتا ہے۔",
  permissions_tip_view_cost_fields:
    "رپورٹس میں لاگت/ریٹ والے حساس کالم دیکھنے کی اجازت دیتا ہے۔",
  view_details: "تفصیلی دیکھیں",
  export_excel_csv: "ایکسپورٹ Excel/CSV",
  filter_all_branches: "تمام برانچ فلٹر",
  view_cost_fields: "لاگت کے فیلڈز دیکھیں",
  phone_1: "فون 1",
  phone_2: "فون 2",
  phone_number: "فون نمبر",
  phone_primary: "فون (بنیادی)",
  phone_secondary: "فون (ثانوی)",
  placeholder_allowance_type: "گھر، نقل و حمل، موبائل",
  placeholder_designation_role: "سیلز آفیسر",
  placeholder_employee_code: "EMP-001",
  placeholder_employee_name: "علی رضا",
  placeholder_labour_code: "LAB-001",
  placeholder_labour_name: "رفیق",
  placeholder_raw_material_name: "جیسے",
  placeholder_raw_material_name_ur: "جیسے",
  popup_blocked_new_tab: "پاپ اپ مسدود ہے۔",
  post: "پوسٹ",
  posting_class: "پوسٹنگ کلاس",
  previous_balance: "پچھلا بیلنس",
  previous_dozen_rate: "پچھلا درجن ریٹ",
  previous_period: "پچھلا دور",
  previous_period_total: "پچھلی مدت کا کل",
  previous_rate: "پچھلا ریٹ",
  primary_customer_name: "بنیادی گاہک کا نام",
  print_gate_pass: "گیٹ پاس پرنٹ کریں۔",
  thank_you_for_your_visit: "آپ کی آمد کا شکریہ",
  prepared_by: "تیار کرنے والا",
  checked_by: "جانچنے والا",
  approved_by: "منظور کرنے والا",
  proceed_change: "تبدیلی کے ساتھ آگے بڑھیں۔",
  product_group: "پروڈکٹ گروپ",
  product_groups: "پروڈکٹ گروپس",
  product_groups_bought: "پروڈکٹ گروپس خریدے گئے۔",
  product_groups_description: "RM/SFG/FG مرئیت گروپس کی وضاحت کریں۔",
  product_scope: "پروڈکٹ کا دائرہ کار",
  product_subgroups: "پروڈکٹ کے ذیلی گروپس",
  product_types: "مصنوعات کی اقسام",
  production_category: "پیداوار کا زمرہ",
  production_category_finished: "ختم",
  production_category_semi_finished: "نیم تیار",
  production_overhead: "پروڈکشن اوور ہیڈ لاگت کا تجزیہ",
  production_reports: "پیداواری رپورٹس",
  production_control_report: "پیداواری کنٹرول رپورٹ",
  consumption_report: "کنزمپشن رپورٹ",
  planned_consumption: "منصوبہ بند کھپت",
  consumption_report_purpose_tooltip:
    "منظور شدہ کنزمپشن ووچرز کی نقل و حرکت کو شعبہ اور آئٹم کے لحاظ سے دکھاتی ہے۔",
  department_wip_report: "ڈیپارٹمنٹ وائز زیر التوا پیداوار رپورٹ",
  department_wip_report_purpose_tooltip:
    "پچھلے اسٹیج کے نیٹ WIP بیلنس کی بنیاد پر اسٹیج وائز زیر التوا پیداوار دکھاتی ہے۔",
  report_usage_help: "اس رپورٹ کو استعمال کرنے کا طریقہ",
  department_wip_report_usage_point_1:
    "زیر التوا حساب کے لیے As Of Date کو snapshot cutoff تاریخ کے طور پر استعمال کریں۔",
  department_wip_report_usage_point_2:
    "کسی بھی شعبے کا زیر التوا حجم پچھلے اسٹیج کے net balance (IN - OUT) سے لیا جاتا ہے۔",
  department_wip_report_usage_point_3:
    "loss، consumption، اور conversion کی OUT movements زیر التوا میں خودکار منفی کر دی جاتی ہیں۔",
  department_wip_balances_report: "ڈیپارٹمنٹ WIP بیلنس رپورٹ",
  department_wip_balances_report_purpose_tooltip:
    "منتخب تاریخ تک SKU اور برانچ کے لحاظ سے موجودہ ڈیپارٹمنٹ WIP بیلنس دکھاتی ہے۔",
  department_wip_ledger_report: "ڈیپارٹمنٹ WIP لیجر رپورٹ",
  as_of_date: "بتاریخ",
  aging_bucket: "عمر بکٹ",
  pending_articles: "زیر التوا آرٹیکلز",
  avg_aging_days: "اوسط عمر (دن)",
  max_aging_days: "زیادہ سے زیادہ عمر (دن)",
  pending_pairs: "زیر التوا جوڑے",
  pending_dozen: "زیر التوا درجن",
  opening_pairs: "اوپننگ جوڑے",
  in_pairs: "اندر آنے والے جوڑے",
  out_pairs: "باہر جانے والے جوڑے",
  closing_pairs: "اختتامی جوڑے",
  closing_dozen: "اختتامی درجن",
  sku_count: "SKU گنتی",
  open_ledger: "لیجر کھولیں",
  movement: "حرکت",
  in_movement: "IN",
  out_movement: "OUT",
  production_type: "پیداواری قسم",
  select_department: "شعبہ منتخب کریں",
  select_labour: "لیبر منتخب کریں",
  select_sku: "SKU منتخب کریں",
  abnormal_loss_voucher: "غیر معمولی نقصان ووچر",
  finished_production_voucher: "فنشڈ پروڈکشن ووچر",
  semi_finished_production_voucher: "سیمی فنشڈ پروڈکشن ووچر",
  department_completion_voucher: "ڈیپارٹمنٹ کمپلیشن ووچر",
  consumption_voucher: "کنزمپشن ووچر",
  labour_production_voucher: "لیبر پروڈکشن ووچر",
  production_planning_voucher: "پروڈکشن پلاننگ ووچر",
  finished_production_voucher_description:
    "فنشڈ پروڈکشن ریکارڈ کریں اور متعلقہ کنزمپشن اور لیبر ووچرز خودکار بنائیں۔",
  semi_finished_production_voucher_description:
    "سیمی فنشڈ پروڈکشن ریکارڈ کریں اور متعلقہ کنزمپشن اور لیبر ووچرز خودکار بنائیں۔",
  department_completion_voucher_description:
    "ڈیپارٹمنٹ کی مکمل شدہ مقدار ریکارڈ کریں اور WIP پول میں شامل کریں۔",
  consumption_voucher_description:
    "منظور شدہ پروڈکشن ووچرز سے منسلک خودکار کنزمپشن ووچر۔",
  labour_production_voucher_description:
    "منظور شدہ پروڈکشن ووچرز سے منسلک خودکار لیبر ووچر۔",
  production_planning_voucher_description:
    "مستقبل کی پروڈکشن مقدار کی منصوبہ بندی کریں، کنزمپشن یا لیبر پوسٹنگ کے بغیر۔",
  loss_type: "نقصان کی قسم",
  plan_kind: "پلان کی قسم",
  voucher_lines_required: "ووچر لائنز لازمی ہیں۔",
  is_required: "لازمی ہے",
  must_be_positive: "صفر سے بڑا ہونا ضروری ہے",
  products: "مصنوعات",
  profit_and_loss: "منافع اور نقصان کا بیان",
  profit_derivation: "منافع کی تشریح",
  profit_derivation_note: "منتخب فلٹرز کے مطابق فارمولا اور حسابی اقدار۔",
  pl_gross_sales: "مجموعی فروخت",
  pl_sales_returns: "سیلز واپسی",
  pl_discounts: "ڈسکاؤنٹس",
  pl_net_sales: "خالص فروخت",
  pl_opening_inventory: "ابتدائی انوینٹری",
  pl_purchases: "خریداریاں",
  pl_direct_costs: "براہِ راست لاگت",
  pl_closing_inventory: "اختتامی انوینٹری",
  pl_cogs: "فروخت شدہ مال کی لاگت (COGS)",
  pl_gross_profit: "مجموعی منافع",
  pl_operating_expenses: "آپریٹنگ اخراجات",
  pl_operating_profit_ebit: "آپریٹنگ منافع (EBIT)",
  pl_other_income: "دیگر آمدن",
  pl_other_expenses: "دیگر اخراجات",
  pl_finance_cost: "مالی لاگت",
  pl_net_profit_before_tax: "ٹیکس سے پہلے خالص منافع",
  profitability_analysis: "منافع بخش تجزیہ رپورٹ",
  purchase_invoice: "عام خریداری",
  purchase_order: "خریداری کا آرڈر",
  purchase_rate: "خریداری کی شرح",
  purchase_reports: "خریداری کی رپورٹ",
  purchase_return_description: "ریکارڈ سپلائر اور وجہ کے خلاف خام مال واپس.",
  purchase_type: "خریداری کی قسم",
  quantity: "مقدار",
  quick_ranges: "فوری حدود",
  rate_change_submitted: "شرح کی تبدیلی منظوری کے لیے جمع کرائی گئی۔",
  rate_type: "شرح کی قسم",
  view_rate_in: "ریٹ دیکھیں بطور",
  rate_type_per_dozen: "فی درجن",
  rate_type_per_pair: "فی جوڑا",
  rate_value: "ریٹ ویلیو",
  rates: "نرخ",
  raw_materials: "خام مال",
  raw_materials_description:
    "فی رنگ خریداری کی شرح کے ساتھ خام مال کو برقرار رکھیں.",
  raw_request_data: "خام درخواست کا ڈیٹا",
  read_only: "صرف پڑھنے کے لیے",
  receive_into_account: "ادائیگی موصول ہوئی اکاؤنٹ",
  received_quantity: "موصول شدہ مقدار",
  recent_vouchers: "حالیہ واؤچرز",
  ref_line: "ریف لائن",
  reject: "رد کرنا",
  rejected: "مسترد",
  remaining_amount: "باقی رقم",
  remarks: "ریمارکس",
  repair_capability: "مرمت",
  report_not_configured_yet: "یہ رپورٹ ابھی تک کنفیگر نہیں ہوئی ہے۔",
  report_type: "رپورٹ کی قسم",
  reports: "رپورٹس",
  request_approved: "درخواست منظور کر لی گئی۔",
  request_rejected: "درخواست مسترد کر دی گئی۔",
  request_type: "درخواست کی قسم",
  requested_by: "کی طرف سے درخواست کی",
  requested_entity: "درخواست کردہ ہستی",
  requester: "مانگنے والا",
  requirement_ref: "ضرورت Ref",
  resolved_from: "سے حل ہوا۔",
  return_qty: "واپسی کی مقدار",
  return_reason_damaged: "نقصان پہنچا",
  return_reason_excess_qty: "زیادہ مقدار",
  return_reason_late_delivery: "دیر سے ڈیلیوری",
  return_reason_other: "دیگر",
  return_reason_quality_issue: "معیار کا مسئلہ",
  return_reason_rate_dispute: "شرح تنازعہ",
  return_reason_wrong_item: "غلط آئٹم",
  returnable_assets: "قابل واپسی اثاثے۔",
  returnable_assets_description:
    "ظاہری/ رسید واؤچرز کے لیے واپسی کے قابل ٹولز، مولڈز، فکسچر اور لوازمات کو برقرار رکھیں۔",
  returnable_dispatch_voucher: "ڈسپیچ (باہر کی طرف)",
  returnable_receipt_voucher: "رسید (اندر کی طرف واپسی)",
  returnable_reports: "قابل واپسی رپورٹس",
  returnable_status: "قابل واپسی کی حیثیت",
  returnables: "قابل واپسی",
  pending_returnables: "زیر التوا قابل واپسی",
  overdue_returnables: "مدت سے تجاوز شدہ قابل واپسی",
  reverse_on_returns: "واپسی پر ریورس",
  rgp_outward_reference: "آر جی پی - ظاہری حوالہ",
  role_changes_global_hint:
    "کردار کی اجازت اس کردار کے لیے تفویض کردہ تمام صارفین پر لاگو ہوتی ہے۔",
  role_name_ur: "کردار کا نام (اردو)",
  roles: "کردار",
  row_notes: "قطار کے نوٹس",
  rows: "قطاریں",
  sale_mode: "سیل موڈ",
  sale_mode_direct: "براہ راست فروخت",
  sale_mode_from_so: "سیلز آرڈر سے",
  sale_qty: "فروخت کی مقدار",
  sale_rate: "فروخت کی شرح",
  sales_commission: "سیلز کمیشن",
  sales_commission_description:
    "سیلز کمیشن کے قوانین یہاں فی ملازم اور پروڈکٹ کے دائرہ کار کے مطابق ترتیب دیئے جائیں گے۔",
  sales_discount_policies: "سیلز ڈسکاؤنٹ پالیسیاں",
  sales_order: "سیلز آرڈر",
  sales_order_description:
    "زیر التواء ترسیل کی مقدار کے ساتھ کسٹمر سیلز آرڈر ریکارڈ کریں۔",
  sales_order_line: "سیلز آرڈر لائن",
  sales_reports: "سیلز رپورٹس",
  sales_voucher_description:
    "کیش/کریڈٹ ہینڈلنگ کے ساتھ سیلز آرڈرز کے خلاف براہ راست فروخت یا ترسیل ریکارڈ کریں۔",
  salesman: "سیلز مین",
  save: "محفوظ کریں۔",
  save_draft: "ڈرافٹ محفوظ کریں۔",
  saved: "محفوظ کیا گیا۔",
  saved_successfully: "کامیابی سے محفوظ ہو گیا۔",
  saving: "محفوظ کر رہا ہے...",
  scope: "دائرہ کار",
  scope_missing: "رجسٹری میں اسکوپ غائب ہے۔",
  search: "تلاش کریں۔",
  select_account_name: "اکاؤنٹ کا نام منتخب کریں۔",
  select_all: "سبھی کو منتخب کریں۔",
  select_article: "آرٹیکل منتخب کریں۔",
  select_asset_type: "اثاثہ کی قسم منتخب کریں۔",
  select_condition: "حالت منتخب کریں۔",
  select_customer: "کسٹمر منتخب کریں۔",
  select_grn_lines: "کم از کم ایک GRN لائن منتخب کریں۔",
  select_item: "آئٹم کو منتخب کریں۔",
  select_item_type: "آئٹم کی قسم منتخب کریں۔",
  select_module: "ایک ماڈیول منتخب کریں۔",
  select_module_approval_rules:
    "منظوری کے اصول دیکھنے کے لیے سائڈبار سے ایک ماڈیول منتخب کریں۔",
  select_module_permissions:
    "اس کی اجازتوں کو دیکھنے اور اس میں ترمیم کرنے کے لیے سائڈبار سے ایک ماڈیول منتخب کریں۔",
  select_option: "آپشن منتخب کریں۔",
  select_options_to_generate: "پیدا کرنے کے لیے اختیارات منتخب کریں۔",
  select_outward_reference: "ظاہری حوالہ منتخب کریں۔",
  select_raw_material: "خام مال کو منتخب کریں۔",
  select_role_to_configure:
    "اجازتوں کو ترتیب دینے کے لیے ایک کردار منتخب کریں۔",
  select_salesman: "سیلز مین کو منتخب کریں۔",
  select_target_to_configure: "ترتیب دینے کے لیے ایک ہدف منتخب کریں۔",
  select_target_to_preview_impact:
    "اثر کا جائزہ لینے کے لیے ایک ہدف منتخب کریں۔",
  select_unit: "یونٹ منتخب کریں۔",
  select_user_to_configure: "اجازتوں کو ترتیب دینے کے لیے صارف کو منتخب کریں۔",
  select_vendor: "وینڈر کو منتخب کریں۔",
  semi_finished: "نیم تیار",
  semi_finished_description:
    "نیم تیار اشیاء اور ان کے قابل اطلاق سائز کو برقرار رکھیں۔",
  semi_finished_goods: "نیم تیار شدہ سامان",
  send_for_approval: "منظوری کے لیے بھیجیں۔",
  sent_qty: "مقدار بھیجی گئی۔",
  service_capability: "سروس",
  security: "سیکیورٹی",
  setup: "سیٹ اپ",
  sfg_part_type: "SFG حصہ کی قسم",
  show: "دکھائیں۔",
  show_raw_data: "خام ڈیٹا دکھائیں۔",
  showing: "دکھا رہا ہے۔",
  shown_rows_totals: "دکھائی گئی قطاروں کے لیے ٹوٹل",
  sign_in: "سائن ان کریں۔",
  single_grn_voucher_only: "ایک واحد واؤچر سے GRN لائنیں منتخب کریں۔",
  single_outward_voucher_only: "ایک واؤچر سے ظاہری حوالہ کی لکیریں منتخب کریں۔",
  sizes_help:
    "اس نیم تیار شدہ شے کے ذریعے استعمال ہونے والے ایک یا زیادہ سائز منتخب کریں۔",
  sku: "SKU",
  sku_code: "SKU کوڈ",
  skus: "SKUs",
  skus_description: "SKU مختلف حالتوں اور قیمتوں کو برقرار رکھیں۔",
  source: "ماخذ",
  sr_no: "Sr.No",
  start_account: "اکاؤنٹ",
  start_at: "پر شروع کریں۔",
  start_department: "محکمہ",
  start_group: "گروپ",
  step: "قدم",
  stock_count: "اسٹاک شمار",
  stock_count_adjustment_voucher: "اسٹاک کاؤنٹ واؤچر",
  stock_transfer: "اسٹاک کی منتقلی",
  reason_notes: "وجہ کی تفصیل",
  system_stock_qty: "سسٹم اسٹاک مقدار",
  physical_stock_qty: "فزیکل اسٹاک مقدار",
  difference_qty: "فرق مقدار",
  amount_difference: "فرق رقم",
  sub_group: "ذیلی گروپ",
  submitted_for_approval: "منظوری کے لیے پیش کیا گیا۔",
  subtotal: "ذیلی کل",
  success_bulk_commission_saved: "بلک کمیشن کامیابی سے محفوظ ہو گیا۔",
  success_bulk_commission_saved_counts:
    "تخلیق کیا گیا: {created}، اپ ڈیٹ کیا گیا: {updated}۔",
  success_bulk_labour_rate_saved:
    "بڑی تعداد میں لیبر کی شرح کامیابی کے ساتھ بچ گئی۔",
  success_bulk_labour_rate_saved_counts:
    "تخلیق کیا گیا: {created}، اپ ڈیٹ کیا گیا: {updated}۔",
  summary: "خلاصہ",
  summary_row: "خلاصہ قطار",
  supplier_balance_information: "سپلائر بیلنس کی معلومات",
  supplier_balances_report: "سپلائر بیلنس کی رپورٹ",
  supplier_ledger_report: "سپلائر لیجر رپورٹ",
  labour_ledger_report: "لیبر لیجر رپورٹ",
  labour_balances_report: "لیبر بیلنس رپورٹ",
  employee_ledger_report: "ملازم لیجر رپورٹ",
  employee_balances_report: "ملازم بیلنس رپورٹ",
  supplier_listings: "سپلائر کی فہرستیں",
  supplier_reports: "فراہم کنندہ کی رپورٹس",
  target: "ہدف",
  target_type: "ہدف کی قسم",
  taxable: "قابل ٹیکس",
  this_month: "اس مہینے",
  time_granularity: "ٹائم گرانورٹی",
  to_unit: "یونٹ کو",
  tooltip_account_type:
    "مرکزی اکاؤنٹنگ کی درجہ بندی (اثاثہ، ذمہ داری، ایکویٹی، محصول، اخراجات)۔",
  tooltip_code: "رپورٹس اور فلٹرنگ میں استعمال ہونے والا مختصر کوڈ۔",
  tooltip_contra: "اس کے پیرنٹ گروپ کے توازن کو آفسیٹ کرتا ہے۔",
  top_account_groups: "سرفہرست اکاؤنٹ گروپس",
  top_accounts: "ٹاپ اکاؤنٹس",
  top_departments: "اعلیٰ محکمے",
  top_groups: "سرفہرست گروپس",
  total_amount: "کل رقم",
  total_bill_amount: "بل کی کل رقم",
  total_credit: "کل کریڈٹ",
  total_debit: "کل ڈیبٹ",
  total_discount: "کل ڈسکاؤنٹ",
  total_returns_amount: "کل واپسی کی رقم",
  total_sales_amount: "کل فروخت کی رقم",
  transactions_count: "لین دین",
  translate_to_urdu: "اردو میں ترجمہ کریں۔",
  translation_failed: "ترجمہ دستیاب نہیں ہے۔",
  translation_fetching: "ترجمہ لا رہا ہے...",
  translation_idle: "اردو نام بھرنے کے لیے آٹو ٹرانسلیٹ پر کلک کریں۔",
  translation_ready: "ترجمہ شدہ",
  trend_chart: "رجحان چارٹ",
  trend_chart_click_hint:
    "اس مدت کو کھولنے کے لیے کسی بھی چارٹ پوائنٹ پر کلک کریں۔",
  trend_vs_previous_period: "رجحان بمقابلہ پچھلا دور",
  trial_balance: "ٹرائل بیلنس کا خلاصہ",
  unexpected_response: "غیر متوقع جواب",
  unique_identifier_hint: "اس برانچ کے لیے مختصر منفرد کوڈ (جیسے LHR01)",
  unit_code_exists: "یونٹ کوڈ پہلے سے موجود ہے۔",
  units: "یونٹس",
  unknown: "نامعلوم",
  uom_conversion_help:
    "وضاحت کریں کہ ایک یونٹ دوسرے میں کیسے تبدیل ہوتا ہے (جیسے، 1 BOX = 10 PCS)۔",
  uom_conversions: "UOM تبادلے۔",
  updated: "تازہ کاری",
  usage: "استعمال میں",
  usage_help: "استعمال میں مدد",
  use_credentials: "جاری رکھنے کے لیے اپنے ERP اسناد کا استعمال کریں۔",
  user_inactive: "صارف غیر فعال ہے۔",
  user_overrides_hint:
    "صرف صارف کی تبدیلیاں صرف اس صارف پر لاگو ہوتی ہیں (رول کی اجازتیں تب تک لاگو ہوتی ہیں جب تک کہ اوور رائڈ نہ ہو جائیں)۔",
  username: "صارف نام",
  users: "صارفین",
  uses_sfg: "SFG استعمال کرتا ہے۔",
  value: "قدر",
  value_type: "قدر کی قسم",
  value_type_fixed: "فکسڈ",
  value_type_percent: "فیصد",
  variance_drivers: "ویریئنس ڈرائیورز",
  variance_drivers_help:
    "پیریڈ اوور پیریڈ موومنٹ کے پیچھے اکاؤنٹ کے سب سے بڑے گروپ دکھاتا ہے۔",
  variant_id: "متغیر ID",
  variants: "متغیرات",
  variants_sent_approval: "منظوری کے بعد مختلف قسمیں شامل کی جائیں گی۔",
  vendor_capabilities: "وینڈر کی صلاحیتیں۔",
  vendor_capabilities_help:
    "منتخب کریں کہ یہ سپلائر کیا سنبھال سکتا ہے (مواد، مرمت، سروس)۔",
  vendor_party: "فروش",
  version: "ورژن",
  view_pending_approval: "زیر التواء منظوری دیکھیں",
  view_voucher: "واؤچر کھولیں۔",
  voucher_deleted_read_only: "حذف شدہ واؤچر صرف پڑھنے کے لیے ہے۔",
  voucher_lines: "واؤچر لائنز",
  voucher_register: "واؤچر رجسٹر",
  voucher_summary: "واؤچر کا خلاصہ",
  voucher_type: "واؤچر کی قسم",
  stock_type: "اسٹاک کی قسم",
  vouchers: "واؤچرز",
  vouchers_label: "واؤچرز",
  vr_no: "VR نمبر",
  weekday_fri_short: "Fr",
  weekday_mon_short: "مو",
  weekday_sat_short: "ص",
  weekday_sun_short: "ایس یو",
  weekday_thu_short: "و",
  weekday_tue_short: "ٹو",
  weekday_wed_short: "ہم",
  weekly: "ہفتہ وار",
  weekly_short_range_daily_hint: "ٹائم گرانورٹی: ہفتہ وار۔",
  welcome: "دوبارہ خوش آمدید۔",
  year_to_date: "سال تا تاریخ",
};
// AUTO-URDU-TRANSLATIONS-END

translations.ur = {
  ...translations.ur,
  sr_no: "سری نمبر",
  weekday_fri_short: "ج",
  skus: "ایس کے یوز",
  bom: "بی او ایم",
  id: "شناخت",
  cnic: "شناختی کارڈ نمبر",
  placeholder_employee_code: "ملازم-001",
  placeholder_labour_code: "لیبر-001",
  sku: "ایس کے یو",
  voucher_register_purpose_tooltip:
    "Voucher entries ko audit aur reconciliation ke liye list karta hai.",
  cash_book_purpose_tooltip:
    "Cash movement ko opening se closing balance tak dikhata hai.",
  cash_voucher_register_purpose_tooltip:
    "Sirf cash vouchers ki activity aur control view deta hai.",
  bank_transactions_purpose_tooltip:
    "Bank voucher transactions aur clearance status track karta hai.",
  expense_analysis_purpose_tooltip:
    "Kharchon ka period-wise analysis department/group/account level par deta hai.",
  expense_trends_purpose_tooltip:
    "Time ke sath expense trends aur spikes dikhata hai.",
  journal_voucher_register_purpose_tooltip:
    "Journal vouchers ka audit register dikhata hai.",
  account_activity_ledger_purpose_tooltip:
    "Selected account ki transaction-wise movement aur running balance dikhata hai.",
  trial_balance_purpose_tooltip:
    "Accounts ka debit/credit summary validation ke liye deta hai.",
  payroll_wage_balance_purpose_tooltip:
    "Payroll aur wage related balances ka control view deta hai.",
  production_overhead_purpose_tooltip:
    "Production overhead cost breakdown dikhata hai.",
  non_production_expense_purpose_tooltip:
    "Non-production expenses ka control analysis dikhata hai.",
  accrued_expenses_purpose_tooltip:
    "Accrued expenses entries ko review ke liye list karta hai.",
  profitability_analysis_purpose_tooltip:
    "Financial movement se profitability indicators analyze karta hai.",
  profit_and_loss_purpose_tooltip:
    "Period ka income vs expense summary aur net profit/loss dikhata hai.",
  supplier_listings_purpose_tooltip:
    "Suppliers ki directory aur grouping details dikhata hai.",
  supplier_ledger_report_purpose_tooltip:
    "Supplier-wise ledger movement aur running balance dikhata hai.",
  supplier_balances_report_purpose_tooltip:
    "Selected date par supplier payable balance dikhata hai.",
  labour_ledger_report_purpose_tooltip:
    "Labour-wise ledger movement aur running balance dikhata hai.",
  labour_balances_report_purpose_tooltip:
    "Labour-wise current payable/receivable balance dikhata hai.",
  employee_ledger_report_purpose_tooltip:
    "Employee-wise ledger movement aur running balance dikhata hai.",
  employee_balances_report_purpose_tooltip:
    "Employee-wise current payable/receivable balance dikhata hai.",
  purchase_reports_purpose_tooltip:
    "Purchases ko party, material, quantity aur amount ke sath analyze karta hai.",
  production_reports_purpose_tooltip:
    "Production control, planning, aur pending flow reports ka main section.",
  production_control_report_purpose_tooltip:
    "Approved production output ko voucher, SKU aur department ke hisab se track karta hai.",
  consumption_report_purpose_tooltip:
    "Approved consumption vouchers ki movement ko department aur stock item ke hisab se dikhata hai.",
  planned_consumption_purpose_tooltip:
    "Planned production ko BOM expected consumption ke sath compare karta hai.",
  department_wip_balances_report_purpose_tooltip:
    "As Of date par department, SKU aur branch wise current WIP balance snapshot dikhata hai.",
  department_wip_ledger_report_purpose_tooltip:
    "Selected department aur SKU ka movement ledger aur closing balance dikhata hai.",
  inventory_reports_purpose_tooltip:
    "Stock valuation aur stock balance reports ka main section.",
  stock_amount_report_purpose_tooltip:
    "Stock quantity, rate aur amount ko filters ke mutabiq dikhata hai.",
  stock_balances_report_purpose_tooltip:
    "Stock quantities-only view dikhata hai, amount ke baghair.",
  stock_ledger_report_purpose_tooltip:
    "Selected stock type, item aur date range ke mutabiq opening, inward, outward aur closing movement ledger dikhata hai.",
  stock_movement_report_purpose_tooltip:
    "Selected filters ke mutabiq opening, production, purchase, sale, adjustment aur closing stock movement dikhata hai.",
  stock_transfer_report_purpose_tooltip:
    "Approved stock transfer in/out movement ko branch, voucher aur SKU filters ke sath dikhata hai.",
  pending_returnables_purpose_tooltip:
    "Pending returnable cases jo abhi wapas nahi aaye unko dikhata hai.",
  overdue_returnables_purpose_tooltip:
    "Overdue returnables aur vendor performance indicators dikhata hai.",
  customer_listings_purpose_tooltip:
    "Customers ki directory aur grouping details dikhata hai.",
  customer_ledger_report_purpose_tooltip:
    "Customer-wise ledger movement aur running balance dikhata hai.",
  customer_balances_report_purpose_tooltip:
    "Selected date par customer receivable/payable balance dikhata hai.",
  customer_contact_analysis_purpose_tooltip:
    "Customer contact aur billing behavior ka summary analysis deta hai.",
  sales_order_report_purpose_tooltip:
    "Sales order, delivered quantity aur remaining pending quantity track karta hai.",
  sales_report_purpose_tooltip:
    "Sales performance ko voucher, party/account aur article ke mutabiq analyze karta hai.",
  sale_return_report_purpose_tooltip:
    "Sale return quantity aur value analysis dikhata hai.",
  sales_discount_report_purpose_tooltip:
    "Discount impact ko voucher/customer level par monitor karta hai.",
};

Object.assign(translations.en, {
  active_users: "Active Users",
  active_users_dashboard_tooltip:
    "Branch specific: distinct active users with non-expired sessions seen in the last {minutes} minutes.",
  active_users_window: "Seen in last {minutes}m",
  aging_days: "Aging Days",
  articles: "Articles",
  availability: "Availability",
  availability_check: "Check Availability",
  availability_ok: "Availability OK",
  availability_short: "Availability Short",
  available: "Available",
  bom_error_lifecycle_requires_approved:
    "Only approved BOM can be activated or deactivated.",
  bom_error_sfg_consumed_stage_not_mapped:
    "Selected consumed stage is not mapped in BOM routing.",
  bom_error_sfg_consumed_stage_required:
    "Consumed stage is required for SFG consumption.",
  bom_error_stage_required_for_sfg: "Stage selection is required for SFG.",
  bom_header_change_apply_clear_quantities:
    "Apply header changes and clear dependent quantities?",
  bom_hint_sfg_consumed_stage:
    "Select the stage where this SFG will be consumed.",
  check: "Check",
  checking: "Checking",
  close: "Close",
  confirm_delete: "Confirm Delete",
  convertible_from_better_grade: "Convertible From Better Grade",
  deficit: "Deficit",
  department_count: "Department Count",
  effective_available: "Effective Available",
  fill_required_fields_then_check_availability:
    "Fill required fields and then check availability.",
  final_stage_only: "Final Stage Only",
  item: "Item",
  lines: "Lines",
  na: "N/A",
  no_data_found: "No data found.",
  no_previous_stage_requirement: "No previous-stage requirement for this row.",
  no_sfg_required_for_this_stage: "No SFG required for this stage.",
  opening_stock: "Opening Stock",
  pending_departments: "Pending Departments",
  planned: "Planned",
  previous_stage: "Previous Stage",
  product_subgroup: "Product Subgroup",
  production_unit: "Production Unit",
  recent_activity: "Recent Activity",
  required: "Required",
  select_color: "Select Color",
  select_size: "Select Size",
  short: "Short",
  source_production_voucher: "Source Production Voucher",
  stage_scope: "Stage Scope",
  system: "System",
  total_logs_today: "Total Logs Today",
  total_logs_today_dashboard_tooltip:
    "Branch specific: total activity logs created today for the selected branch.",
  total_deficit: "Total Deficit",
  type: "Type",
  return_reason_wrong_size: "Wrong Size",
  return_reason_missing_items: "Missing Items",
  return_reason_customer_changed_mind: "Customer Changed Mind",
  return_reason_quality_defect: "Quality Defect",
  vouchers_today: "Vouchers Today",
  vouchers_today_dashboard_tooltip:
    "Branch specific: vouchers posted today in the selected branch.",
  md_changes_today: "MD Changes Today",
  master_data_changes_dashboard_tooltip:
    "Global: master data changes today across all branches.",
  pending_approvals_dashboard_tooltip:
    "Branch specific: pending approvals for the selected branch.",
  view_all: "View All",
});

Object.assign(translations.ur, {
  active_users: "فعال صارفین",
  active_users_dashboard_tooltip:
    "برانچ کے لحاظ سے: گزشتہ {minutes} منٹ میں غیر میعاد ختم سیشن والے منفرد فعال صارفین۔",
  active_users_window: "گزشتہ {minutes} منٹ میں فعال",
  aging_days: "دنوں کی عمر",
  articles: "آرٹیکلز",
  availability: "دستیابی",
  availability_check: "دستیابی چیک کریں",
  availability_ok: "دستیابی درست",
  availability_short: "دستیابی کم",
  available: "دستیاب",
  bom_error_lifecycle_requires_approved:
    "صرف منظور شدہ بی او ایم کو فعال یا غیر فعال کیا جا سکتا ہے۔",
  bom_error_sfg_consumed_stage_not_mapped:
    "منتخب شدہ خرچ مرحلہ بی او ایم روٹنگ میں میپ نہیں ہے۔",
  bom_error_sfg_consumed_stage_required:
    "ایس ایف جی خرچ کے لئے consumed stage لازمی ہے۔",
  bom_error_stage_required_for_sfg:
    "ایس ایف جی کے لئے مرحلہ منتخب کرنا لازمی ہے۔",
  bom_header_change_apply_clear_quantities:
    "ہیڈر تبدیلیاں لاگو کر کے متعلقہ مقداریں صاف کی جائیں؟",
  bom_hint_sfg_consumed_stage:
    "وہ مرحلہ منتخب کریں جہاں یہ ایس ایف جی خرچ ہوگا۔",
  check: "چیک",
  checking: "چیک ہو رہا ہے",
  close: "بند کریں",
  confirm_delete: "حذف کی تصدیق",
  convertible_from_better_grade: "بہتر گریڈ سے قابل تبدیل",
  deficit: "کمی",
  department_count: "شعبہ تعداد",
  effective_available: "موثر دستیاب",
  fill_required_fields_then_check_availability:
    "ضروری فیلڈز پُر کریں پھر دستیابی چیک کریں۔",
  final_stage_only: "صرف آخری مرحلہ",
  item: "آئٹم",
  lines: "لائنیں",
  na: "لاگو نہیں",
  no_data_found: "کوئی ڈیٹا نہیں ملا۔",
  no_previous_stage_requirement: "اس لائن کے لئے پچھلے مرحلے کی ضرورت نہیں ہے۔",
  no_sfg_required_for_this_stage:
    "اس مرحلے کے لئے کوئی ایس ایف جی درکار نہیں ہے۔",
  opening_stock: "ابتدائی اسٹاک",
  pending_departments: "زیر التوا شعبے",
  planned: "منصوبہ بند",
  previous_stage: "پچھلا مرحلہ",
  product_subgroup: "مصنوعہ ذیلی گروپ",
  production_unit: "پیداواری یونٹ",
  recent_activity: "حالیہ سرگرمی",
  required: "درکار",
  select_color: "رنگ منتخب کریں",
  select_size: "سائز منتخب کریں",
  short: "کم",
  source_production_voucher: "سورس پروڈکشن واؤچر",
  stage_scope: "مرحلہ دائرہ",
  system: "سسٹم",
  total_logs_today: "آج کے کل لاگز",
  total_logs_today_dashboard_tooltip:
    "برانچ کے لحاظ سے: منتخب برانچ میں آج بننے والے سرگرمی لاگز کی کل تعداد۔",
  total_deficit: "کل کمی",
  type: "قسم",
  return_reason_wrong_size: "غلط سائز",
  return_reason_missing_items: "اشیاء نامکمل",
  return_reason_customer_changed_mind: "کسٹمر نے فیصلہ تبدیل کیا",
  return_reason_quality_defect: "معیار میں خرابی",
  vouchers_today: "آج کے واؤچرز",
  vouchers_today_dashboard_tooltip:
    "برانچ کے لحاظ سے: منتخب برانچ میں آج پوسٹ ہونے والے واؤچرز۔",
  md_changes_today: "آج کی ماسٹر ڈیٹا تبدیلیاں",
  master_data_changes_dashboard_tooltip:
    "عالمی: تمام برانچز میں آج کی ماسٹر ڈیٹا تبدیلیاں۔",
  pending_approvals_dashboard_tooltip:
    "برانچ کے لحاظ سے: منتخب برانچ کی زیر التواء منظوریاں۔",
  view_all: "سب دیکھیں",
});

const formatDateDisplay = (value, fallback = "-") => {
  if (value === null || value === undefined || value === "") return fallback;
  const text = String(value).trim();
  const ymdMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymdMatch) return `${ymdMatch[3]}-${ymdMatch[2]}-${ymdMatch[1]}`;
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})[T\s].*$/);
  if (isoMatch) return `${isoMatch[3]}-${isoMatch[2]}-${isoMatch[1]}`;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return text || fallback;
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = String(dt.getFullYear());
  return `${dd}-${mm}-${yyyy}`;
};

const trimTrailingZeros = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!text.includes(".")) return text === "-0" ? "0" : text;
  const normalized = text
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "")
    .replace(/\.$/, "");
  return normalized === "-0" ? "0" : normalized;
};

const formatNumberDisplay = (value, options = {}) => {
  const fallback = Object.prototype.hasOwnProperty.call(options, "fallback")
    ? options.fallback
    : "-";
  if (value === null || value === undefined || value === "") return fallback;
  const decimals =
    Number.isInteger(options.decimals) && options.decimals >= 0
      ? options.decimals
      : null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    const raw = String(value).trim();
    return raw || fallback;
  }
  const rounded =
    decimals === null ? numeric : Number(numeric.toFixed(decimals));
  return trimTrailingZeros(String(rounded));
};

const STRICT_URDU_UI = String(process.env.STRICT_URDU_UI || "1").trim() !== "0";
const URDU_MISSING_FALLBACK = "ترجمہ درکار";

const hasOwn = (obj, key) =>
  Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);

const normalizeDynamicToken = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const RETURN_REASON_DYNAMIC_MAP = {
  wrong_size: "return_reason_wrong_size",
  wrong_item: "return_reason_wrong_item",
  quality_defect: "return_reason_quality_defect",
  quality_issue: "return_reason_quality_issue",
  missing_items: "return_reason_missing_items",
  customer_changed_mind: "return_reason_customer_changed_mind",
  late_delivery: "return_reason_late_delivery",
  other: "return_reason_other",
  damaged: "return_reason_damaged",
  excess_qty: "return_reason_excess_qty",
  rate_dispute: "return_reason_rate_dispute",
};

const PRODUCTION_CATEGORY_DYNAMIC_MAP = {
  fg: "production_category_finished",
  finished: "production_category_finished",
  finished_goods: "production_category_finished",
  sfg: "production_category_semi_finished",
  semi_finished: "production_category_semi_finished",
  semifinished: "production_category_semi_finished",
  semi_finished_goods: "production_category_semi_finished",
  rm: "raw_material",
  raw_material: "raw_material",
  rawmaterial: "raw_material",
  raw_materials: "raw_materials",
};

const resolveDynamicTranslationKey = (key) => {
  const normalizedKey = String(key || "").trim();
  if (normalizedKey.startsWith("return_reason_")) {
    const suffix = normalizeDynamicToken(
      normalizedKey.slice("return_reason_".length),
    );
    return RETURN_REASON_DYNAMIC_MAP[suffix] || `return_reason_${suffix}`;
  }
  if (normalizedKey.startsWith("production_category_")) {
    const suffix = normalizeDynamicToken(
      normalizedKey.slice("production_category_".length),
    );
    return PRODUCTION_CATEGORY_DYNAMIC_MAP[suffix] || normalizedKey;
  }
  return null;
};

const resolveKnownTranslation = (
  locale,
  key,
  { strictUrdu = STRICT_URDU_UI } = {},
) => {
  const ur = translations.ur || {};
  const en = translations.en || {};
  if (locale === "ur") {
    if (hasOwn(ur, key) && ur[key]) return ur[key];
    if (!strictUrdu && hasOwn(en, key) && en[key]) return en[key];
    return null;
  }
  if (hasOwn(en, key) && en[key]) return en[key];
  return null;
};

const resolveTranslation = (locale, key) => {
  const normalizedKey = String(key || "").trim();
  const direct = resolveKnownTranslation(locale, normalizedKey);
  if (direct) return direct;

  const dynamicKey = resolveDynamicTranslationKey(normalizedKey);
  if (dynamicKey) {
    const dynamicValue = resolveKnownTranslation(locale, dynamicKey);
    if (dynamicValue) return dynamicValue;
  }

  if (locale === "ur") return URDU_MISSING_FALLBACK;
  return normalizedKey || key;
};

module.exports = (req, res, next) => {
  const cookies = parseCookies(req);
  const requested =
    (req.query && req.query.lang) ||
    cookies.lang ||
    (req.headers["accept-language"] || "").split(",")[0];
  const normalized = (requested || "en").toLowerCase();
  const locale = normalized.startsWith("ur") ? "ur" : "en";

  if (req.query && req.query.lang) {
    setCookie(res, "lang", locale, {
      path: "/",
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  req.locale = locale;
  res.locals.locale = locale;
  res.locals.t = (key) => resolveTranslation(locale, key);
  res.locals.formatDateDisplay = formatDateDisplay;
  res.locals.formatNumberDisplay = formatNumberDisplay;
  next();
};

module.exports.translations = translations;
module.exports.resolveTranslation = resolveTranslation;
