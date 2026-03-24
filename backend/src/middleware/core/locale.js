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
    dashboard: "Dashboard",
    welcome: "Welcome back. Select a module from the navigation to begin.",
    branch: "Branch",
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
    branches: "Branches",
    users: "Users",
    roles: "Roles",
    permissions: "Permissions",
    approvals: "Approvals", // Renamed from "Pending Approvals" to be generic
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
    error_record_in_use:
      "This record is linked to other data and cannot be deleted.",
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
    semi_finished_description:
      "Maintain semi-finished items and their applicable sizes.",
    raw_materials_description:
      "Maintain raw materials with per-color purchase rates.",
    bom: "BOM",
    bom_list: "BOM Register",
    bom_versions: "Versions",
    bom_approval: "Approval",
    bom_description: "Manage global BOM drafts, approvals, and versions.",
    submit_bom_request: "Submit BOM Request",
    bom_new_title: "Add BOM",
    bom_edit_title: "Edit BOM",
    bom_header: "BOM Setup",
    bom_output_qty: "Output Quantity",
    bom_output_batch_size: "Planned Output Qty",
    bom_output_uom: "Output Unit (UOM)",
    bom_tab_rm: "List Raw Material Used for This Article",
    bom_tab_sfg: "List Semi-Finished Products Used (If Any)",
    bom_tab_sfg_per_sku: "List Semi-Finished Products Used For Each SKU",
    bom_tab_labour: "List Labour Rates For This Article",
    bom_tab_variant_rules: "Variant Rules",
    bom_rm_rules_size_wise: "Size-Wise Raw Material Rules",
    bom_rm_section_hint:
      "Add raw materials and departments here. Enter quantities in SKU Rules.",
    bom_rm_view_material_lines: "Material Lines",
    bom_rm_view_variant_rules: "Size Rules",
    bom_sku_rules: "SKU Rules",
    bom_advanced_rules: "Advanced Rules",
    bom_color_rules: "Color Rules",
    bom_color_scope_hint:
      "Choose a SKU variant scope to edit material color mapping.",
    bom_sku_rules_hint:
      "Select a SKU to edit final raw material requirements. Only differences are saved as SKU overrides.",
    bom_select_sku: "Select SKU",
    bom_no_sku_available: "No SKU available for selected article.",
    bom_no_material_lines_for_sku_rules:
      "Add material lines first to edit SKU rules.",
    bom_labour_selection_title: "Labours Selection",
    bom_labour_selection_hint:
      "Select labour, department, and rate type. Size-wise rates are set below.",
    bom_labour_size_rules_title: "SKU Rules",
    bom_labour_size_rules_hint:
      "Select a SKU to add labour rates based on rate type.",
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
    bom_header_change_identity_message:
      "This starts a different BOM context. RM, SFG, Labour, and SKU overrides will be cleared.",
    bom_header_change_identity_hint:
      "Save Draft & Switch saves current draft and opens selected BOM context. Apply (Start Fresh) clears current sections and switches without saving.",
    bom_header_change_apply_clear_quantities: "Apply (Clear Quantities)",
    bom_header_change_apply_start_fresh: "Apply (Start Fresh)",
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
    placeholder_raw_material_name_ur:
      "e.g. Ã™â€¦Ã˜ÂµÃ™â€ Ã™Ë†Ã˜Â¹Ã›Å’ Ãšâ€ Ã™â€¦Ãšâ€˜Ã˜Â§",
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
    voucher_register: "Voucher Register",
    cash_book: "Cash Book",
    cash_voucher_register: "Cash Voucher Register",
    bank_transactions: "Bank Transactions Report",
    expense_analysis: "Expense Analysis Report",
    expense_trends: "Expense Trends Report",
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
    non_production_expense: "Non-Production Expense Analysis",
    accrued_expenses: "Accrued Expenses Report",
    profitability_analysis: "Profitability Analysis Report",
    profit_and_loss: "Profit and Loss Statement",
    journal_voucher_register: "Journal Voucher Register",
    account_activity_ledger: "Account Activity Ledger",
    trial_balance: "Trial Balance Summary",
    payroll_wage_balance: "Payroll & Wage Balance Report",
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
    supplier_listings: "Supplier Listings",
    supplier_ledger_report: "Supplier Ledger Report",
    supplier_balances_report: "Supplier Balances Report",
    report_not_configured_yet: "This report is not configured yet.",
    purchase_reports: "Purchase Report",
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
    loss_type: "Loss Type",
    plan_kind: "Plan Kind",
    voucher_lines_required: "Voucher lines are required.",
    is_required: "is required",
    must_be_positive: "must be greater than zero",
    inventory_voucher: "Inventory Voucher",
    stock_count: "Stock Count",
    stock_transfer: "Stock Transfer",
    inventory_reports: "Inventory Reports",
    returnables: "Returnables",
    returnable_reports: "Returnable Reports",
    pending_returnables: "Pending Returnables",
    overdue_returnables: "Overdue Returnables",
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
    customer_balances_report: "Customer Balances Report",
    customer_ledger_report: "Customer Ledger Report",
    customer_listings: "Customer Listings",
    sales_order_report: "Sales Order Report",
    sales_report: "Sales Report",
    sale_return_report: "Sale Return Report",
    customer_contact_analysis: "Customer Contact Analysis",
    sales_order_report: "Sales Order Report",
    sales_report: "Sales Report",
    sale_return_report: "Sale Return Report",
    sales_discount_report: "Sales Discount Report",
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
    permissions_tip_navigate:
      "Allows listing existing records in this screen. Required to find a record for edit/deactivate actions.",
    permissions_tip_create: "Enables the Add New form to save new entries.",
    permissions_tip_edit:
      "Unlocks the ability to change data in existing records.",
    permissions_tip_deactivate: "Enables the option to deactivate records.",
    permissions_tip_delete: "Permanently removes records.",
    permissions_tip_approve: "Grants authority to finalize a record status.",
    permissions_tip_download: "Enables the Download and Export buttons.",
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
    add_new_combinations: "Add Variants",
    variants_sent_approval: "Variants will be added once approved.",
  },
  ur: {},
};

const MOJIBAKE_MARKERS = /[Ã˜Ã™Ã›ÃƒÃ¢ÃšÂ¢â‚¬Å¾]/;
const ARABIC_SCRIPT = /[\u0600-\u06FF]/;
const REPLACEMENT_MARKER = /ï¿½/;
const CONTROL_GARBAGE = /[\u0080-\u009f]/;

const tryDecodeMojibake = (value) => {
  if (typeof value !== "string") return value;
  if (!MOJIBAKE_MARKERS.test(value)) return value;

  const score = (text) => {
    const mojibakeCount = (String(text || "").match(MOJIBAKE_MARKERS) || [])
      .length;
    const arabicCount = (String(text || "").match(ARABIC_SCRIPT) || []).length;
    const replacementCount = (String(text || "").match(/ï¿½/g) || []).length;
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
  add_user: "Ù†ÛŒØ§ ØµØ§Ø±Ù Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚº",
  edit_user: "ØµØ§Ø±Ù Ù…ÛŒÚº ØªØ±Ù…ÛŒÙ… Ú©Ø±ÛŒÚº",
  manage_system_access: "Ø³Ø³Ù¹Ù… ØªÚ© Ø±Ø³Ø§Ø¦ÛŒ Ú©Ø§ Ø§Ù†ØªØ¸Ø§Ù… Ú©Ø±ÛŒÚº",
  back_to_users: "ØµØ§Ø±ÙÛŒÙ† Ù¾Ø± ÙˆØ§Ù¾Ø³",
  leave_blank_keep:
    "(Ù†ÛŒØ§ Ù¾Ø§Ø³ ÙˆØ±Úˆ Ø¯ÛŒÚº (Ù…ÙˆØ¬ÙˆØ¯Û Ø¨Ø±Ù‚Ø±Ø§Ø± Ø±Ú©Ú¾Ù†Û’ Ú©Û’ Ù„ÛŒÛ’ Ø®Ø§Ù„ÛŒ Ú†Ú¾ÙˆÚ‘ÛŒÚº))",
  select_role: "Ø±ÙˆÙ„ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº",
  assigned_branches: "ØªÙÙˆÛŒØ¶ Ø´Ø¯Û Ø¨Ø±Ø§Ù†Ú†Ø²",
  branch_access_hint:
    "ØµØ§Ø±Ù ØµØ±Ù ØªÙÙˆÛŒØ¶ Ø´Ø¯Û Ø¨Ø±Ø§Ù†Ú†Ø² Ú©Ø§ ÚˆÛŒÙ¹Ø§ Ø¯ÛŒÚ©Ú¾ Ø³Ú©ØªØ§ ÛÛ’Û”",
  role: "Ø±ÙˆÙ„",
  add_role: "Ù†ÛŒØ§ Ø±ÙˆÙ„ Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚº",
  manage_user_roles: "ØµØ§Ø±Ù Ø±ÙˆÙ„Ø² Ú©Ø§ Ø§Ù†ØªØ¸Ø§Ù… Ú©Ø±ÛŒÚº",
  back_to_roles: "Ø±ÙˆÙ„Ø² Ù¾Ø± ÙˆØ§Ù¾Ø³",
  role_name: "Ø±ÙˆÙ„ Ú©Ø§ Ù†Ø§Ù…",
  configure_access_rights: "Ø±Ø³Ø§Ø¦ÛŒ Ú©Û’ Ø­Ù‚ÙˆÙ‚ ØªØ±ØªÛŒØ¨ Ø¯ÛŒÚº",
  user_overrides: "ØµØ§Ø±Ù Ø§ÙˆÙˆØ±Ø±Ø§Ø¦ÛŒÚˆØ²",
  select_user: "ØµØ§Ø±Ù Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº",
  module: "Ù…Ø§ÚˆÛŒÙˆÙ„",
  screen: "Ø§Ø³Ú©Ø±ÛŒÙ†",
  navigate: "Ù†ÛŒÙˆÛŒÚ¯ÛŒÙ¹",
  voucher: "ÙˆØ§Ø¤Ú†Ø±",
  report: "Ø±Ù¾ÙˆØ±Ù¹",
  view: "Ø¯ÛŒÚ©Ú¾ÛŒÚº",
  create: "Ø¨Ù†Ø§Ø¦ÛŒÚº",
  approve: "Ù…Ù†Ø¸ÙˆØ± Ú©Ø±ÛŒÚº",
  approval_settings: "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©ÛŒ ØªØ±ØªÛŒØ¨Ø§Øª",
  approval_rules: "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©Û’ Ù‚ÙˆØ§Ø¹Ø¯",
  requires_approval: "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ø¯Ø±Ú©Ø§Ø±",
  approval_submitted:
    "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø¬Ù…Ø¹ ÛÙˆ Ú¯Ø¦ÛŒ ÛÛ’Û” Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©Û’ Ø¨Ø¹Ø¯ ØªØ¨Ø¯ÛŒÙ„ÛŒ Ù„Ø§Ú¯Ùˆ ÛÙˆÚ¯ÛŒÛ”",
  approval_sent:
    "ØªØ¨Ø¯ÛŒÙ„ÛŒ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©Û’ Ù„ÛŒÛ’ Ø¨Ú¾ÛŒØ¬ Ø¯ÛŒ Ú¯Ø¦ÛŒ ÛÛ’Û” Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©Û’ Ø¨Ø¹Ø¯ Ù„Ø§Ú¯Ùˆ ÛÙˆÚ¯ÛŒÛ”",
  notice: "Ø§Ø·Ù„Ø§Ø¹",
  approval_approved:
    "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ù†Ø¸ÙˆØ± ÛÙˆ Ú¯Ø¦ÛŒ ÛÛ’Û”",
  approval_rejected:
    "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ø³ØªØ±Ø¯ Ú©Ø± Ø¯ÛŒ Ú¯Ø¦ÛŒ ÛÛ’Û”",
  permission_denied: "Ø§Ø¬Ø§Ø²Øª Ù†ÛÛŒÚº ÛÛ’Û”",
  error_invalid_id: "ØºÙ„Ø· Ø´Ù†Ø§Ø®ØªÛ”",
  error_not_found: "Ø±ÛŒÚ©Ø§Ø±Úˆ Ù…ÙˆØ¬ÙˆØ¯ Ù†ÛÛŒÚºÛ”",
  save_permissions: "Ø§Ø¬Ø§Ø²ØªÛŒÚº Ù…Ø­ÙÙˆØ¸ Ú©Ø±ÛŒÚº",
  search_permissions: "Ø§Ø¬Ø§Ø²ØªÛŒÚº ØªÙ„Ø§Ø´ Ú©Ø±ÛŒÚº...",
  expand_all: "Ø³Ø¨ Ú©Ú¾ÙˆÙ„ÛŒÚº",
  collapse_all: "Ø³Ø¨ Ø¨Ù†Ø¯ Ú©Ø±ÛŒÚº",
  branch_name: "Ø¨Ø±Ø§Ù†Ú† Ù†Ø§Ù…",
  city: "Ø´ÛØ±",
  is_active: "ÙØ¹Ø§Ù„ ÛÛ’",
  save_changes: "ØªØ¨Ø¯ÛŒÙ„ÛŒØ§Úº Ù…Ø­ÙÙˆØ¸ Ú©Ø±ÛŒÚº",
  add_new_branch: "Ø¨Ø±Ø§Ù†Ú† Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚº",
  brand: "Ú†Ø§Ù†Ø¯ Ø§ÛŒÙˆØ§",
  signed_in_as: "Ø¨Ø·ÙˆØ± Ø¯Ø§Ø®Ù„",
  branch: "Ø¨Ø±Ø§Ù†Ú†",
  logout: "Ù„Ø§Ú¯ Ø¢Ø¤Ù¹",
  language: "Ø²Ø¨Ø§Ù†",
  english: "Ø§Ù†Ú¯Ø±ÛŒØ²ÛŒ",
  urdu: "Ø§Ø±Ø¯Ùˆ",
  administration: "Ø§Ù†ØªØ¸Ø§Ù…ÛŒÛ",
  permissions: "Ø§Ø¬Ø§Ø²ØªÛŒÚº",
  approvals: "Ù…Ù†Ø¸ÙˆØ±ÛŒ",
  master_data: "Ù…Ø§Ø³Ù¹Ø± ÚˆÛŒÙ¹Ø§",
  hr_payroll: "Ø§ÛŒÚ† Ø¢Ø± Ø§ÙˆØ± Ù¾Û’ Ø±ÙˆÙ„",
  financial: "Ù…Ø§Ù„ÛŒØ§ØªÛŒ",
  purchase: "Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ",
  production: "Ù¾Ø±ÙˆÚˆÚ©Ø´Ù†",
  inventory: "Ø§Ù†ÙˆÛŒÙ†Ù¹Ø±ÛŒ",
  outward_returnable: "Ø¢Ø¤Ù¹ ÙˆØ±Úˆ Ø§ÙˆØ± Ø±ÛŒÙ¹Ø±Ù†ÛŒØ¨Ù„",
  sales: "Ø³ÛŒÙ„Ø²",
  purchase_return: "Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ Ø±ÛŒÙ¹Ø±Ù†",
  voucher_no: "ÙˆØ§Ø¤Ú†Ø± Ù†Ù…Ø¨Ø±",
  prev: "Ù¾Ú†Ú¾Ù„Ø§",
  next: "Ø§Ú¯Ù„Ø§",
  load: "Ù„ÙˆÚˆ",
  labour: "Ù„ÛŒØ¨Ø±",
  from_date: "Ø´Ø±ÙˆØ¹ ØªØ§Ø±ÛŒØ®",
  to_date: "Ø§Ø®ØªØªØ§Ù…ÛŒ ØªØ§Ø±ÛŒØ®",
  select: "Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº",
  select_date_range: "ØªØ§Ø±ÛŒØ® Ú©ÛŒ Ø­Ø¯ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº",
  invalid_date_range: "ØºÙ„Ø· ØªØ§Ø±ÛŒØ® Ú©ÛŒ Ø­Ø¯Û”",
  open_date_range_picker:
    "ØªØ§Ø±ÛŒØ® Ú©ÛŒ Ø­Ø¯ Ù…Ù†ØªØ®Ø¨ Ú©Ø±Ù†Û’ Ú©Ø§ Ù¾ÛŒÙ†Ù„ Ú©Ú¾ÙˆÙ„ÛŒÚº",
  delete: "Ø­Ø°Ù Ú©Ø±ÛŒÚº",
  download: "ÚˆØ§Ø¤Ù† Ù„ÙˆÚˆ",
  print: "Ù¾Ø±Ù†Ù¹",
  date: "ØªØ§Ø±ÛŒØ®",
  supplier: "Ø³Ù¾Ù„Ø§Ø¦Ø±",
  select_supplier: "Ø³Ù¾Ù„Ø§Ø¦Ø± Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº",
  reference_no: "Ø±ÛŒÙØ±Ù†Ø³ Ù†Ù…Ø¨Ø±",
  description: "ØªÙØµÛŒÙ„",
  reason: "ÙˆØ¬Û",
  return_reason: "ÙˆØ§Ù¾Ø³ÛŒ Ú©ÛŒ ÙˆØ¬Û",
  select_reason: "ÙˆØ¬Û Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº",
  raw_material: "Ø®Ø§Ù… Ù…Ø§Ù„",
  color: "Ø±Ù†Ú¯",
  unit: "ÛŒÙˆÙ†Ù¹",
  qty: "Ù…Ù‚Ø¯Ø§Ø±",
  deliver_qty: "ÚˆÛŒÙ„ÛŒÙˆØ± Ù…Ù‚Ø¯Ø§Ø±",
  advance_received_amount: "Ø§ÛŒÚˆÙˆØ§Ù†Ø³ ÙˆØµÙˆÙ„ Ø´Ø¯Û Ø±Ù‚Ù…",
  receive_into_account_if_any: "ÙˆØµÙˆÙ„ÛŒ Ø§Ú©Ø§Ø¤Ù†Ù¹ (Ø§Ú¯Ø± Ú©ÙˆØ¦ÛŒ ÛÙˆ)",
  payment_received_amount: "ÙˆØµÙˆÙ„ Ø´Ø¯Û Ø±Ù‚Ù…",
  payment_received_amount_if_any: "ÙˆØµÙˆÙ„ Ø´Ø¯Û Ø±Ù‚Ù… (Ø§Ú¯Ø± Ú©ÙˆØ¦ÛŒ ÛÙˆ)",
  current_payment_received: "Ù…ÙˆØ¬ÙˆØ¯Û ÙˆØµÙˆÙ„ Ø´Ø¯Û Ø±Ù‚Ù…",
  sales_order_report: "Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ø±Ù¾ÙˆØ±Ù¹",
  sales_voucher: "Ø³ÛŒÙ„Ø² ÙˆÙˆÚ†Ø±",
  select_sales_order: "Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº",
  sales_order_link: "Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ù„Ù†Ú©",
  payment_type: "Ø§Ø¯Ø§Ø¦ÛŒÚ¯ÛŒ Ú©ÛŒ Ù‚Ø³Ù…",
  bank_voucher: "Ø¨ÛŒÙ†Ú© ÙˆÙˆÚ†Ø±",
  sales_report: "Ø³ÛŒÙ„Ø² Ø±Ù¾ÙˆØ±Ù¹",
  sale_return_report: "Ø³ÛŒÙ„ Ø±ÛŒÙ¹Ø±Ù† Ø±Ù¾ÙˆØ±Ù¹",
  sales_discount_report: "Ø³ÛŒÙ„Ø² ÚˆØ³Ú©Ø§Ø¤Ù†Ù¹ Ø±Ù¾ÙˆØ±Ù¹",
  closed: "Ø¨Ù†Ø¯",
  complete: "Ù…Ú©Ù…Ù„",
  close_date: "Ø¨Ù†Ø¯ ÛÙˆÙ†Û’ Ú©ÛŒ ØªØ§Ø±ÛŒØ®",
  ordered_qty: "Ø¢Ø±ÚˆØ± Ù…Ù‚Ø¯Ø§Ø±",
  delivered_qty: "ÚˆÛŒÙ„ÛŒÙˆØ± Ù…Ù‚Ø¯Ø§Ø±",
  remaining_qty: "Ø¨Ù‚Ø§ÛŒØ§ Ù…Ù‚Ø¯Ø§Ø±",
  sales_order_advance_received:
    "Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ú©ÛŒ Ø§ÛŒÚˆÙˆØ§Ù†Ø³ ÙˆØµÙˆÙ„ Ø´Ø¯Û Ø±Ù‚Ù…",
  sales_order_previous_payments_received:
    "Ø§Ø³ Ø¢Ø±ÚˆØ± Ú©Û’ Ù„ÛŒÛ’ Ù¾ÛÙ„Û’ Ø³Û’ ÙˆØµÙˆÙ„ Ø´Ø¯Û Ø§Ø¯Ø§Ø¦ÛŒÚ¯ÛŒØ§Úº",
  sales_order_total_amount: "Ú©Ù„ Ø¢Ø±ÚˆØ± Ø±Ù‚Ù…",
  sales_order_total_received_with_current:
    "Ú©Ù„ ÙˆØµÙˆÙ„ Ø´Ø¯Û (Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± + Ù…ÙˆØ¬ÙˆØ¯Û)",
  sales_order_total_received_for_order:
    "Ø§Ø³ Ø¢Ø±ÚˆØ± Ú©Û’ Ù„ÛŒÛ’ Ú©Ù„ ÙˆØµÙˆÙ„ Ø´Ø¯Û",
  current_voucher_amount: "Ù…ÙˆØ¬ÙˆØ¯Û ÙˆØ§Ø¤Ú†Ø± Ø±Ù‚Ù…",
  remaining_receivable: "Ø¨Ø§Ù‚ÛŒ Ù‚Ø§Ø¨Ù„ ÙˆØµÙˆÙ„ Ø±Ù‚Ù…",
  current_delivery_amount: "Ù…ÙˆØ¬ÙˆØ¯Û ÚˆÛŒÙ„ÛŒÙˆØ±ÛŒ Ø±Ù‚Ù…",
  outstanding_for_current_delivery:
    "Ù…ÙˆØ¬ÙˆØ¯Û ÚˆÛŒÙ„ÛŒÙˆØ±ÛŒ Ú©Û’ Ù„ÛŒÛ’ Ø¨Ù‚Ø§ÛŒØ§",
  vendor_capabilities: "Vendor Capabilities",
  vendor_capabilities_help:
    "Choose what this supplier can handle (Material, Repair, Service).",
  material_capability: "Material",
  repair_capability: "Repair",
  service_capability: "Service",
  error_select_vendor_capabilities:
    "Please select at least one vendor capability for supplier.",
  reference_no: "Ø±ÛŒÙØ±Ù†Ø³ Ù†Ù…Ø¨Ø±",
  description: "ØªÙØµÛŒÙ„",
  reason: "ÙˆØ¬Û",
  return_reason: "ÙˆØ§Ù¾Ø³ÛŒ Ú©ÛŒ ÙˆØ¬Û",
  select_reason: "ÙˆØ¬Û Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº",
  raw_material: "Ø®Ø§Ù… Ù…Ø§Ù„",
  color: "Ø±Ù†Ú¯",
  unit: "ÛŒÙˆÙ†Ù¹",
  qty: "Ù…Ù‚Ø¯Ø§Ø±",
  received_quantity: "Received Quantity",
  delivery_qty: "ÚˆÛŒÙ„ÛŒÙˆØ±ÛŒ Ù…Ù‚Ø¯Ø§Ø±",
  error_due_date_must_be_after_voucher:
    "Ø§Ø¯Ø§Ø¦ÛŒÚ¯ÛŒ Ú©ÛŒ Ø¢Ø®Ø±ÛŒ ØªØ§Ø±ÛŒØ® ÙˆØ§Ø¤Ú†Ø± ØªØ§Ø±ÛŒØ® Ú©Û’ Ø¨Ø¹Ø¯ ÛÙˆÙ†ÛŒ Ú†Ø§ÛÛŒÛ’Û”",
  error_advance_amount_exceeds_final:
    "Ø§ÛŒÚˆÙˆØ§Ù†Ø³ ÙˆØµÙˆÙ„ Ø´Ø¯Û Ø±Ù‚Ù… Ø­ØªÙ…ÛŒ Ø±Ù‚Ù… Ø³Û’ Ø²ÛŒØ§Ø¯Û Ù†ÛÛŒÚº ÛÙˆ Ø³Ú©ØªÛŒÛ”",
  error_current_payment_exceeds_receivable:
    "Ù…ÙˆØ¬ÙˆØ¯Û ÙˆØµÙˆÙ„ÛŒ Ø§Ø³ Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ú©ÛŒ Ø¨Ø§Ù‚ÛŒ Ù‚Ø§Ø¨Ù„ ÙˆØµÙˆÙ„ Ø±Ù‚Ù… Ø³Û’ Ø²ÛŒØ§Ø¯Û Ù†ÛÛŒÚº ÛÙˆ Ø³Ú©ØªÛŒÛ”",
  error_sales_order_requires_credit_sale:
    "Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ø±ÛŒÙØ±Ù†Ø³ Ú©Û’ Ø³Ø§ØªÚ¾ ØµØ±Ù Ú©Ø±ÛŒÚˆÙ¹ Ø³ÛŒÙ„ Ú©ÛŒ Ø§Ø¬Ø§Ø²Øª ÛÛ’Û”",
  error_single_sales_order_only:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… ØµØ±Ù Ø§ÛŒÚ© Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ú©ÛŒ Ù„Ø§Ø¦Ù†ÛŒÚº Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_sales_order_not_found: "Ù…Ù†ØªØ®Ø¨ Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ù†ÛÛŒÚº Ù…Ù„Ø§Û”",
  error_no_open_sales_order_lines:
    "Ù…Ù†ØªØ®Ø¨ Ú©Ø³Ù¹Ù…Ø± Ú©Û’ Ù„ÛŒÛ’ Ú©ÙˆØ¦ÛŒ Ø§ÙˆÙ¾Ù† Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ù„Ø§Ø¦Ù† Ø¯Ø³ØªÛŒØ§Ø¨ Ù†ÛÛŒÚº ÛÛ’Û”",
  error_line_sale_and_return_conflict:
    "Ø§ÛŒÚ© ÛÛŒ Ù„Ø§Ø¦Ù† Ù…ÛŒÚº Ø³ÛŒÙ„ Ø§ÙˆØ± Ø±ÛŒÙ¹Ø±Ù† Ù…Ù‚Ø¯Ø§Ø± Ø³Ø§ØªÚ¾ Ù†ÛÛŒÚº ÛÙˆ Ø³Ú©ØªÛŒÛ”",
  error_line_sale_or_return_required:
    "ÛØ± Ù„Ø§Ø¦Ù† Ù…ÛŒÚº Ø³ÛŒÙ„ Ù…Ù‚Ø¯Ø§Ø± ÛŒØ§ Ø±ÛŒÙ¹Ø±Ù† Ù…Ù‚Ø¯Ø§Ø± Ù…ÛŒÚº Ø³Û’ Ø§ÛŒÚ© Ù„Ø§Ø²Ù…ÛŒ ÛÛ’Û”",
  error_line_pair_rate_required:
    "Ù¾ÛŒØ¦Ø± Ø±ÛŒÙ¹ ØµÙØ± Ø³Û’ Ø²ÛŒØ§Ø¯Û ÛÙˆÙ†Ø§ Ù„Ø§Ø²Ù…ÛŒ ÛÛ’Û”",
  error_line_discount_must_be_less_than_rate:
    "Ù¾ÛŒØ¦Ø± ÚˆØ³Ú©Ø§Ø¤Ù†Ù¹ Ù¾ÛŒØ¦Ø± Ø±ÛŒÙ¹ Ø³Û’ Ú©Ù… ÛÙˆÙ†Ø§ Ù„Ø§Ø²Ù…ÛŒ ÛÛ’Û”",
  error_line_sales_order_line_required:
    "Ø§Ø³ Ù„Ø§Ø¦Ù† Ú©Û’ Ù„ÛŒÛ’ Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ù„Ø§Ø¦Ù† Ù…Ù†ØªØ®Ø¨ Ú©Ø±Ù†Ø§ Ù„Ø§Ø²Ù…ÛŒ ÛÛ’Û”",
  error_line_return_not_allowed_from_so:
    "Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ø³Û’ Ù…Ù†Ø³Ù„Ú© Ù„Ø§Ø¦Ù† Ù…ÛŒÚº Ø±ÛŒÙ¹Ø±Ù† Ù…Ù‚Ø¯Ø§Ø± Ú©ÛŒ Ø§Ø¬Ø§Ø²Øª Ù†ÛÛŒÚº ÛÛ’Û”",
  error_line_sales_order_source_invalid:
    "Ù…Ù†ØªØ®Ø¨ Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ù„Ø§Ø¦Ù† Ø¯Ø±Ø³Øª Ù†ÛÛŒÚº ÛÛ’Û”",
  error_line_sales_order_qty_exceeds_open:
    "Ø¯Ø±Ø¬ Ú©Ø±Ø¯Û ÚˆÙ„ÛŒÙˆØ± Ù…Ù‚Ø¯Ø§Ø± Ù…Ù†ØªØ®Ø¨ Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ú©ÛŒ Ø§ÙˆÙ¾Ù† Ù…Ù‚Ø¯Ø§Ø± Ø³Û’ Ø²ÛŒØ§Ø¯Û ÛÛ’Û”",
  rate: "Ø±ÛŒÙ¹",
  amount: "Ø±Ù‚Ù…",
  action: "Ø¹Ù…Ù„",
  line: "Ù„Ø§Ø¦Ù†",
  status: "Ø­Ø§Ù„Øª",
  serial_no: "Ø³ÛŒØ±ÛŒÙ„ Ù†Ù…Ø¨Ø±",
  none: "Ú©ÙˆØ¦ÛŒ Ù†ÛÛŒÚº",
  total: "Ú©Ù„",
  add_row: "Ù‚Ø·Ø§Ø± Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚº",
  confirm: "ØªØµØ¯ÛŒÙ‚",
  erp_system_copyright: "Ø§ÛŒ Ø¢Ø± Ù¾ÛŒ Ø³Ø³Ù¹Ù… Â© 2026",
};

translations.ur = sanitizeUrduTranslations(translations.ur, translations.en);
// AUTO-URDU-TRANSLATIONS-START
translations.ur = {
  ...translations.ur,
  abnormal_loss: "ØºÛŒØ± Ù…Ø¹Ù…ÙˆÙ„ÛŒ Ù†Ù‚ØµØ§Ù†",
  account_activity_ledger: "Ø§Ú©Ø§Ø¤Ù†Ù¹ Ø§ÛŒÚ©Ù¹ÛŒÙˆÛŒÙ¹ÛŒ Ù„ÛŒØ¬Ø±",
  account_code: "Ø§Ú©Ø§Ø¤Ù†Ù¹ Ú©ÙˆÚˆ",
  account_group: "Ø§Ú©Ø§Ø¤Ù†Ù¹ Ú¯Ø±ÙˆÙ¾",
  account_groups: "Ø§Ú©Ø§Ø¤Ù†Ù¹ Ú¯Ø±ÙˆÙ¾Ø³",
  account_groups_description:
    "Ù…Ø¹ÛŒØ§Ø±ÛŒ COA Ø¹Ù†ÙˆØ§Ù†Ø§Øª Ú©Û’ ØªØ­Øª Ø°ÛŒÙ„ÛŒ Ú¯Ø±ÙˆÙ¾Ø³Û”",
  account_name: "Ø§Ú©Ø§Ø¤Ù†Ù¹ Ú©Ø§ Ù†Ø§Ù…",
  account_type: "Ø§Ú©Ø§Ø¤Ù†Ù¹ Ú©ÛŒ Ù‚Ø³Ù…",
  accounts: "Ø§Ú©Ø§Ø¤Ù†Ù¹Ø³",
  accounts_parties: "Ø§Ú©Ø§Ø¤Ù†Ù¹Ø³ Ø§ÙˆØ± Ù¾Ø§Ø±Ù¹ÛŒØ²",
  accrued_expenses: "Ø¬Ù…Ø¹ Ø´Ø¯Û Ø§Ø®Ø±Ø§Ø¬Ø§Øª Ú©ÛŒ Ø±Ù¾ÙˆØ±Ù¹",
  actions: "Ø§Ø¹Ù…Ø§Ù„",
  activate: "Ú†Ø§Ù„Ùˆ Ú©Ø±ÛŒÚºÛ”",
  active: "ÙØ¹Ø§Ù„",
  active_branch_hint:
    "ØºÛŒØ± ÙØ¹Ø§Ù„ Ø´Ø§Ø®ÛŒÚº Ø§Ù†ØªØ®Ø§Ø¨ Ø³Û’ Ù¾ÙˆØ´ÛŒØ¯Û ÛÛŒÚº Ø§ÙˆØ± Ù†Ø¦Û’ Ù„ÛŒÙ† Ø¯ÛŒÙ† Ú©Û’ Ù„ÛŒÛ’ Ø§Ø³ØªØ¹Ù…Ø§Ù„ Ù†ÛÛŒÚº Ú©ÛŒ Ø¬Ø§ Ø³Ú©ØªÛŒÚºÛ”",
  add: "Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚºÛ”",
  add_branch: "Ø¨Ø±Ø§Ù†Ú† Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚºÛ”",
  add_conversion: "ØªØ¨Ø¯ÛŒÙ„ÛŒ Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚºÛ”",
  add_new_combinations: "Ù…ØªØºÛŒØ±Ø§Øª Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚºÛ”",
  advance_receive: "Ù¾ÛŒØ´Ú¯ÛŒ Ø§Ø¯Ø§Ø¦ÛŒÚ¯ÛŒ Ù…ÙˆØµÙˆÙ„ ÛÙˆ Ú¯Ø¦ÛŒÛ”",
  affected_skus: "Ù…ØªØ§Ø«Ø±Û SKUs",
  after: "Ú©Û’ Ø¨Ø¹Ø¯",
  all_branches: "ØªÙ…Ø§Ù… Ø´Ø§Ø®ÛŒÚºÛ”",
  all_cashiers: "ØªÙ…Ø§Ù… Ú©ÛŒØ´ÛŒØ¦Ø±Ø²",
  all_modules: "ØªÙ…Ø§Ù… Ù…Ø§ÚˆÛŒÙˆÙ„Ø²",
  all_sizes: "ØªÙ…Ø§Ù… Ø³Ø§Ø¦Ø²",
  all_voucher_types: "ØªÙ…Ø§Ù… ÙˆØ§Ø¤Ú†Ø± Ú©ÛŒ Ø§Ù‚Ø³Ø§Ù…",
  allowance_type: "Ø§Ù„Ø§Ø¤Ù†Ø³ Ú©ÛŒ Ù‚Ø³Ù…",
  allowances: "Ø§Ù„Ø§Ø¤Ù†Ø³Ø²",
  allowances_description:
    "Ù…Ù„Ø§Ø²Ù… Ø§Ù„Ø§Ø¤Ù†Ø³ Ú©Û’ Ù‚ÙˆØ§Ø¹Ø¯ ÛŒÛØ§Úº ØªØ±ØªÛŒØ¨ Ø¯ÛŒÛ’ Ø¬Ø§Ø¦ÛŒÚº Ú¯Û’Û”",
  amount_type: "Ø±Ù‚Ù… Ú©ÛŒ Ù‚Ø³Ù…",
  amount_type_fixed: "ÙÚ©Ø³Úˆ",
  amount_type_percent_basic: "Ø¨Ù†ÛŒØ§Ø¯ÛŒ Ú©Ø§ %",
  any_cashier: "Ú©ÙˆØ¦ÛŒ Ø¨Ú¾ÛŒ Ú©ÛŒØ´Ø¦ÛŒØ±",
  applied: "Ù„Ø§Ú¯Ùˆ",
  applied_entity: "Ø§Ø·Ù„Ø§Ù‚ Ø´Ø¯Û Ø§Ø¯Ø§Ø±Û",
  applies_to_all_labours: "ØªÙ…Ø§Ù… Ù„ÛŒØ¨Ø±Ø² Ù¾Ø± Ø§Ù¾Ù„Ø§Ø¦ÛŒ Ú©Ø±ÛŒÚºÛ”",
  applies_to_labours: "Ù„ÛŒØ¨Ø±Ø² Ù¾Ø± Ù„Ø§Ú¯Ùˆ ÛÙˆØªØ§ ÛÛ’Û”",
  apply: "Ù„Ú¯Ø§Ø¦ÛŒÚº",
  apply_on: "Ø§Ù¾Ù„Ø§Ø¦ÛŒ Ø¢Ù† Ú©Ø±ÛŒÚºÛ”",
  apply_on_all: "ØªÙ…Ø§Ù… Ù…ØµÙ†ÙˆØ¹Ø§Øª (ÙÙ„ÛŒÙ¹)",
  apply_on_flat: "ÙÙ„ÛŒÙ¹",
  apply_on_group: "Ù¾Ø±ÙˆÚˆÚ©Ù¹ Ú¯Ø±ÙˆÙ¾",
  apply_on_sku: "Ø¢Ø±Ù¹ÛŒÚ©Ù„ (SKU)",
  apply_on_subgroup: "Ù¾Ø±ÙˆÚˆÚ©Ù¹ Ø°ÛŒÙ„ÛŒ Ú¯Ø±ÙˆÙ¾",
  apply_rate_to_selected: "Ù…Ù†ØªØ®Ø¨ Ú©Ø±Ø¯Û Ù¾Ø± Ø§Ù¾Ù„Ø§Ø¦ÛŒ Ú©Ø±ÛŒÚºÛ”",
  approval_apply_failed:
    "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ù„Ø§Ú¯Ùˆ ÛÙˆ Ú¯Ø¦ÛŒØŒ Ù„ÛŒÚ©Ù† ØªØ¨Ø¯ÛŒÙ„ÛŒ Ø¹Ù…Ù„ Ù…ÛŒÚº Ù†ÛÛŒÚº Ù„Ø§Ø¦ÛŒ Ø¬Ø§ Ø³Ú©ÛŒÛ”",
  approval_approved_detail:
    "Ø¢Ù¾ Ú©ÛŒ Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ù†Ø¸ÙˆØ± Ú©Ø± Ù„ÛŒ Ú¯Ø¦ÛŒ: {summary}",
  approval_edit_delete_not_allowed:
    "ÚˆÛŒÙ„ÛŒÙ¹ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³ØªÙˆÚº Ù…ÛŒÚº ØªØ±Ù…ÛŒÙ… Ù†ÛÛŒÚº Ú©ÛŒ Ø¬Ø§ Ø³Ú©ØªÛŒÛ”",
  approval_edit_failed:
    "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ú©Ùˆ Ø§Ù¾ ÚˆÛŒÙ¹ Ú©Ø±Ù†Û’ Ø³Û’ Ù‚Ø§ØµØ±Û”",
  approval_edit_invalid_payload: "ØºÙ„Ø· Ù…Ù†Ø¸ÙˆØ±ÛŒ ØªØ±Ù…ÛŒÙ… Ù¾Û’ Ù„ÙˆÚˆÛ”",
  approval_edit_no_fields:
    "Ø§Ø³ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…ÛŒÚº Ú©ÙˆØ¦ÛŒ Ù‚Ø§Ø¨Ù„ ØªØ¯ÙˆÛŒÙ† ÙÛŒÙ„Úˆ Ù†ÛÛŒÚº Ù…Ù„Ø§Û”",
  approval_no_changes:
    "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…ÛŒÚº Ú©ÙˆØ¦ÛŒ ØªØ¨Ø¯ÛŒÙ„ÛŒ Ù†ÛÛŒÚº Ù…Ù„ÛŒÛ”",
  approval_pending_details:
    "Ø¢Ù¾ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø¬Ù…Ø¹ ÛÛ’ Ø§ÙˆØ± Ù…Ù†Ø¸ÙˆØ±ÛŒ Ø²ÛŒØ± Ø§Ù„ØªÙˆØ§Ø¡ ÛÛ’Û”",
  approval_pending_subject: "Ø²ÛŒØ± Ø§Ù„ØªÙˆØ§Ø¡ Ù…Ù†Ø¸ÙˆØ±ÛŒ",
  approval_rejected_detail:
    "Ø¢Ù¾ Ú©ÛŒ Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ø³ØªØ±Ø¯ Ú©Ø± Ø¯ÛŒ Ú¯Ø¦ÛŒ: {summary}",
  approval_request_id: "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª ID",
  approval_request_not_found:
    "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù†ÛÛŒÚº Ù…Ù„ÛŒ ÛŒØ§ Ù¾ÛÙ„Û’ ÛÛŒ ÙÛŒØµÙ„Û Ú©ÛŒØ§ Ú¯ÛŒØ§ ÛÛ’Û”",
  approval_request_updated:
    "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ú©Ùˆ Ø§Ù¾ ÚˆÛŒÙ¹ Ú©Ø± Ø¯ÛŒØ§ Ú¯ÛŒØ§Û”",
  approval_request_updated_detail:
    "Ø¢Ù¾ Ú©ÛŒ Ø²ÛŒØ± Ø§Ù„ØªÙˆØ§Ø¡ Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ú©Ùˆ Ø§Ù¾ ÚˆÛŒÙ¹ Ú©Ø± Ø¯ÛŒØ§ Ú¯ÛŒØ§: {summary}",
  approval_updates:
    "Ø¢Ù¾ Ú©Û’ Ø¢Ø®Ø±ÛŒ Ù„Ø§Ú¯ Ø§Ù† Ú©Û’ Ø¨Ø¹Ø¯ Ø³Û’: {approved} Ù…Ù†Ø¸ÙˆØ±ØŒ {rejected} Ù…Ø³ØªØ±Ø¯Û”",
  approved: "Ù…Ù†Ø¸ÙˆØ± Ø´Ø¯Û",
  approved_values: "Ù…Ù†Ø¸ÙˆØ± Ø´Ø¯Û Ø§Ù‚Ø¯Ø§Ø±",
  are_you_sure: "Ú©ÛŒØ§ Ø¢Ù¾ Ú©Ùˆ ÛŒÙ‚ÛŒÙ† ÛÛ’ØŸ",
  article: "Ù…Ø¶Ù…ÙˆÙ†",
  article_name: "Ù…Ø¶Ù…ÙˆÙ† Ú©Ø§ Ù†Ø§Ù…",
  article_sku: "آرٹیکل SKU",
  article_type: "Ù…Ø¶Ù…ÙˆÙ† Ú©ÛŒ Ù‚Ø³Ù…",
  article_type_fg: "ØªÛŒØ§Ø± Ø³Ø§Ù…Ø§Ù† (FG)",
  article_type_sfg: "Ù†ÛŒÙ… ØªÛŒØ§Ø± Ø³Ø§Ù…Ø§Ù† (SFG)",
  as_on: "Ø¬ÛŒØ³Ø§ Ø¢Ù†",
  asset: "Ø§Ø«Ø§Ø«Û",
  asset_code: "Ø§Ø«Ø§Ø«Û Ú©ÙˆÚˆ",
  asset_master: "Ø§Ø«Ø§Ø«Û Ù…Ø§Ø³Ù¹Ø±",
  asset_master_description:
    "Ù¹ÙˆÙ„Ø²ØŒ Ù…ÙˆÙ„ÚˆØ²ØŒ ÙÚ©Ø³Ú†Ø± Ø§ÙˆØ± Ù„ÙˆØ§Ø²Ù…Ø§Øª Ú©Û’ Ù„ÛŒÛ’ Ø§Ø«Ø§Ø«Û Ù…Ø§Ø³Ù¹Ø± Ú©Ùˆ Ø¨Ø±Ù‚Ø±Ø§Ø± Ø±Ú©Ú¾ÛŒÚºÛ”",
  asset_name: "Ø§Ø«Ø§Ø«Û Ú©Ø§ Ù†Ø§Ù…",
  asset_type: "Ø§Ø«Ø§Ø«Û Ú©ÛŒ Ù‚Ø³Ù…",
  asset_types: "Ø§Ø«Ø§Ø«ÙˆÚº Ú©ÛŒ Ø§Ù‚Ø³Ø§Ù…",
  asset_types_description:
    "Ø§Ø«Ø§Ø«ÙˆÚº Ø§ÙˆØ± Ù‚Ø§Ø¨Ù„ ÙˆØ§Ù¾Ø³ÛŒ ÙˆØ§Ø¤Ú†Ø±Ø² Ú©Û’ Ø°Ø±ÛŒØ¹Û’ Ø§Ø³ØªØ¹Ù…Ø§Ù„ ÛÙˆÙ†Û’ ÙˆØ§Ù„Û’ Ø§Ø«Ø§Ø«ÙˆÚº Ú©Û’ Ø²Ù…Ø±Û’ Ú©ÛŒ ÙˆØ¶Ø§Ø­Øª Ú©Ø±ÛŒÚºÛ”",
  assets: "Ø§Ø«Ø§Ø«Û’",
  assets_description:
    "Ø¸Ø§ÛØ±ÛŒ Ø§ÙˆØ± Ù‚Ø§Ø¨Ù„ ÙˆØ§Ù¾Ø³ÛŒ ÙˆØ§Ø¤Ú†Ø±Ø² Ù…ÛŒÚº Ø§Ø³ØªØ¹Ù…Ø§Ù„ ÛÙˆÙ†Û’ ÙˆØ§Ù„Û’ ØºÛŒØ± Ø§Ø³Ù¹Ø§Ú© Ø§Ø«Ø§Ø«ÙˆÚº Ú©Ø§ Ù†Ø¸Ù… Ú©Ø±ÛŒÚºÛ”",
  audit: "Ø¢ÚˆÙ¹",
  audit_context_details: "Ø¢ÚˆÙ¹ Ø³ÛŒØ§Ù‚ Ùˆ Ø³Ø¨Ø§Ù‚ Ú©ÛŒ ØªÙØµÛŒÙ„Ø§Øª",
  audit_logs: "Ø³Ø±Ú¯Ø±Ù…ÛŒ Ù„Ø§Ú¯",
  audit_logs_description:
    "Ø³Ø³Ù¹Ù… Ú©ÛŒ Ø³Ø±Ú¯Ø±Ù…ÛŒÙˆÚº Ø§ÙˆØ± ØªØ¨Ø¯ÛŒÙ„ÛŒÙˆÚº Ú©Ùˆ Ù¹Ø±ÛŒÚ© Ú©Ø±ÛŒÚºÛ”",
  auto_select_open_grn:
    "Ú©Ú¾Ù„ÛŒ GRN Ù…Ù‚Ø¯Ø§Ø±ÙˆÚº Ø³Û’ Ø®ÙˆØ¯Ú©Ø§Ø± Ø·ÙˆØ± Ù¾Ø± Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  auto_translate: "Ø®ÙˆØ¯Ú©Ø§Ø± ØªØ±Ø¬Ù…Û",
  average_per_bucket: "ÙÛŒ Ø¨Ø§Ù„Ù¹ÛŒ Ø§ÙˆØ³Ø·",
  average_per_bucket_help:
    "ØµØ±Ù ØºÛŒØ± ØµÙØ± Ø¨Ø§Ù„Ù¹ÛŒÙˆÚº Ù…ÛŒÚº Ø§ÙˆØ³Ø· Ø®Ø§Ù„Øµ Ø®Ø±Ú†Ø›",
  avg_purchase_rate: "Ø§ÙˆØ³Ø· Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ Ú©ÛŒ Ø´Ø±Ø­",
  back: "Ù¾ÛŒÚ†Ú¾Û’",
  back_to_branches: "Ø´Ø§Ø®ÙˆÚº Ù¾Ø± ÙˆØ§Ù¾Ø³ Ø¬Ø§Ø¦ÛŒÚºÛ”",
  back_to_list: "ÙÛØ±Ø³Øª Ù¾Ø± ÙˆØ§Ù¾Ø³ Ø¬Ø§Ø¦ÛŒÚºÛ”",
  balance: "ØªÙˆØ§Ø²Ù†",
  balance_pending: "Ø¨ÛŒÙ„Ù†Ø³ Ø²ÛŒØ± Ø§Ù„ØªÙˆØ§ ÛÛ’Û”",
  bank_account: "Ø¨ÛŒÙ†Ú© Ø§Ú©Ø§Ø¤Ù†Ù¹",
  bank_payment: "Ø¨ÛŒÙ†Ú© Ø§Ø¯Ø§Ø¦ÛŒÚ¯ÛŒ",
  bank_receipt: "Ø¨ÛŒÙ†Ú© Ú©ÛŒ Ø±Ø³ÛŒØ¯",
  bank_transactions: "Ø¨ÛŒÙ†Ú© Ù¹Ø±Ø§Ù†Ø²ÛŒÚ©Ø´Ù† Ø±Ù¾ÙˆØ±Ù¹",
  bank_voucher_description:
    "Ø²ÛŒØ± Ø§Ù„ØªÙˆØ§Ø¡/Ú©Ù„ÛŒØ¦Ø±Úˆ/Ù†Ø§Ú©Ø§Ù… Ø­ÙˆØ§Ù„ÙˆÚº Ú©Û’ Ø³Ø§ØªÚ¾ Ø¨ÛŒÙ†Ú© ÙˆØ§Ø¤Ú†Ø±Ø² Ø¨Ù†Ø§Ø¦ÛŒÚº Ø§ÙˆØ± Ø¬Ù…Ø¹ Ú©Ø±Ø§Ø¦ÛŒÚºÛ”",
  barcode: "Ø¨Ø§Ø±Ú©ÙˆÚˆ",
  base_unit: "Ø¨ÛŒØ³ ÛŒÙˆÙ†Ù¹",
  basic_info: "Ø¨Ù†ÛŒØ§Ø¯ÛŒ Ù…Ø¹Ù„ÙˆÙ…Ø§Øª",
  basic_information: "Ø¨Ù†ÛŒØ§Ø¯ÛŒ Ù…Ø¹Ù„ÙˆÙ…Ø§Øª",
  basic_salary: "Ø¨Ù†ÛŒØ§Ø¯ÛŒ ØªÙ†Ø®ÙˆØ§Û",
  batch_dozen_rates: "Ø¨ÛŒÚ† Ø¯Ø±Ø¬Ù† Ú©Û’ Ù†Ø±Ø®",
  before: "Ø§Ø³ Ø³Û’ Ù¾ÛÙ„Û’",
  biggest_increase_vs_previous:
    "Ø³Ø¨ Ø³Û’ Ø¨Ú‘Ø§ Ø§Ø¶Ø§ÙÛ Ø¨Ù…Ù‚Ø§Ø¨Ù„Û Ù¾Ú†Ú¾Ù„ÛŒ Ù…Ø¯Øª",
  bill_count: "Ø¨Ù„ Ø´Ù…Ø§Ø±",
  bill_number: "Ø¨Ù„ Ù†Ù…Ø¨Ø±",
  bom: "BOM",
  bom_approval: "Ù…Ù†Ø¸ÙˆØ±ÛŒ",
  bom_create_new_version: "Ù†ÛŒØ§ ÙˆØ±Ú˜Ù† Ø¨Ù†Ø§Ø¦ÛŒÚº",
  bom_description:
    "Ø¹Ø§Ù„Ù…ÛŒ BOM ÚˆØ±Ø§ÙÙ¹Ø³ØŒ Ù…Ù†Ø¸ÙˆØ±ÛŒÙˆÚº Ø§ÙˆØ± ÙˆØ±Ú˜Ù†Ø² Ú©Ø§ Ù†Ø¸Ù… Ú©Ø±ÛŒÚºÛ”",
  submit_bom_request: "BOM Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ø¬Ù…Ø¹ Ú©Ø±ÛŒÚº",
  bom_edit_title: "BOM Ù…ÛŒÚº ØªØ±Ù…ÛŒÙ… Ú©Ø±ÛŒÚºÛ”",
  bom_error_already_pending:
    "Ø§Ø³ BOM Ú©Û’ Ù„ÛŒÛ’ Ø§ÛŒÚ© Ø²ÛŒØ± Ø§Ù„ØªÙˆØ§Ø¡ Ù…Ù†Ø¸ÙˆØ±ÛŒ Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  bom_error_approve_requires_draft:
    "ØµØ±Ù BOM Ú©Ø§ Ù…Ø³ÙˆØ¯Û Ù…Ù†Ø¸ÙˆØ± Ú©ÛŒØ§ Ø¬Ø§ Ø³Ú©ØªØ§ ÛÛ’Û”",
  bom_error_color_required_for_specific_scope:
    "Ù…Ø®ØµÙˆØµ Ø¯Ø§Ø¦Ø±Û Ú©Ø§Ø± Ú©Û’ Ù„ÛŒÛ’ Ø±Ù†Ú¯ Ø¯Ø±Ú©Ø§Ø± ÛÛ’Û”",
  bom_error_color_scope_not_allowed_no_sku_colors:
    "Ø§Ø³ Ø¢Ø±Ù¹ÛŒÚ©Ù„ Ù…ÛŒÚº SKU Ø±Ù†Ú¯ÛŒ ÙˆÛŒØ±ÛŒØ¦Ù†Ù¹Ø³ Ù…ÙˆØ¬ÙˆØ¯ Ù†ÛÛŒÚºÛ” Color Scope Ù…ÛŒÚº 'All SKUs' Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  bom_error_department_must_be_production:
    "Selected department must be an active Production department.",
  bom_error_draft_exists:
    "Ø§Ø³ Ø¢Ø¦Ù¹Ù… Ø§ÙˆØ± Ø³Ø·Ø­ Ú©Û’ Ù„ÛŒÛ’ Ø§ÛŒÚ© Ù…Ø³ÙˆØ¯Û Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  bom_error_existing_bom:
    "A BOM already exists for this article. Use BOM Register/Revise instead of Add BOM.",
  bom_error_item_not_found:
    "Ù…Ù†ØªØ®Ø¨ Ú©Ø±Ø¯Û Ø¢Ø¦Ù¹Ù… Ù…ÙˆØ¬ÙˆØ¯ Ù†ÛÛŒÚº ÛÛ’Û”",
  bom_error_item_required:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ø§ÛŒÚ© Ø¢Ø¦Ù¹Ù… Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  bom_error_labour_department_invalid:
    "Ù…Ù†ØªØ®Ø¨ Ù„ÛŒØ¨Ø± Ø§Ø³ Ø´Ø¹Ø¨Û Ú©Û’ Ù„ÛŒÛ’ Ø¯Ø±Ø³Øª Ù†ÛÛŒÚº ÛÛ’Û”",
  bom_error_labour_line_invalid: "ØºÙ„Ø· Ù„ÛŒØ¨Ø± Ù„Ø§Ø¦Ù†Û”",
  bom_error_labour_department_duplicate:
    "ÙˆÛÛŒ Ù„ÛŒØ¨Ø± Ø§Ø³ÛŒ Ø´Ø¹Ø¨Û Ú©Û’ Ù„ÛŒÛ’ Ø¯ÙˆØ¨Ø§Ø±Û Ø´Ø§Ù…Ù„ Ù†ÛÛŒÚº Ú©ÛŒØ§ Ø¬Ø§ Ø³Ú©ØªØ§Û”",
  bom_error_labour_rate_type_invalid:
    "Ù„ÛŒØ¨Ø± Ú©ÛŒ Ø´Ø±Ø­ Ú©ÛŒ ØºÙ„Ø· Ù‚Ø³Ù…Û”",
  bom_error_level_item_mismatch:
    "Ù…Ù†ØªØ®Ø¨ Ú©Ø±Ø¯Û Ø³Ø·Ø­ Ø¢Ø¦Ù¹Ù… Ú©ÛŒ Ù‚Ø³Ù… Ø³Û’ Ù…Ù…Ø§Ø«Ù„ Ù†ÛÛŒÚº ÛÛ’Û”",
  bom_error_level_required:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ø§ÛŒÚ© Ø¯Ø±Ø³Øª BOM Ù„ÛŒÙˆÙ„ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  bom_error_loss_pct_invalid:
    "Ø¹Ø§Ù… Ù†Ù‚ØµØ§Ù† % 0 Ø§ÙˆØ± 100 Ú©Û’ Ø¯Ø±Ù…ÛŒØ§Ù† ÛÙˆÙ†Ø§ Ú†Ø§ÛÛŒÛ’Û”",
  bom_error_material_required_for_specific_scope:
    "Ù…Ø®ØµÙˆØµ Ø¯Ø§Ø¦Ø±Û Ú©Ø§Ø± Ú©Û’ Ù„ÛŒÛ’ ÛØ¯Ù Ú©Ø§ Ù…ÙˆØ§Ø¯ Ø¯Ø±Ú©Ø§Ø± ÛÛ’Û”",
  bom_error_missing_material_rates:
    "Ù…Ø·Ù„ÙˆØ¨Û Ù…ÙˆØ§Ø¯ Ú©Û’ Ù†Ø±Ø® ØºØ§Ø¦Ø¨ ÛÛŒÚºÛ”",
  bom_error_missing_material_rates_detail:
    "Ú©Û’ Ù„ÛŒÛ’ ÙØ¹Ø§Ù„ Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ Ú©ÛŒ Ø´Ø±Ø­ÛŒÚº ØºØ§Ø¦Ø¨ ÛÛŒÚºÛ”",
  bom_error_new_version_requires_approved:
    "Ù†ÛŒØ§ ÙˆØ±Ú˜Ù† ØµØ±Ù Ù…Ù†Ø¸ÙˆØ± Ø´Ø¯Û BOM Ø³Û’ Ø¨Ù†Ø§ÛŒØ§ Ø¬Ø§ Ø³Ú©ØªØ§ ÛÛ’Û”",
  bom_error_only_draft_editable:
    "ØµØ±Ù BOM Ú©Û’ Ù…Ø³ÙˆØ¯Û’ Ù…ÛŒÚº ØªØ±Ù…ÛŒÙ… Ú©ÛŒ Ø¬Ø§ Ø³Ú©ØªÛŒ ÛÛ’Û”",
  bom_error_output_qty_required:
    "Ø¢Ø¤Ù¹ Ù¾Ù¹ Ú©ÛŒ Ù…Ù‚Ø¯Ø§Ø± ØµÙØ± Ø³Û’ Ø²ÛŒØ§Ø¯Û ÛÙˆÙ†ÛŒ Ú†Ø§ÛÛŒÛ’Û”",
  bom_error_output_uom_required: "Ø¢Ø¤Ù¹ Ù¾Ù¹ UOM Ø¯Ø±Ú©Ø§Ø± ÛÛ’Û”",
  bom_error_item_base_uom_missing:
    "Selected article has no base unit. Please set Base Unit in product master first.",
  bom_error_output_uom_conversion_missing:
    "Output Unit must have an active conversion to the article Base Unit in UOM Conversions.",
  bom_error_packing_required_for_specific_scope:
    "Ù¾ÛŒÚ©Ù†Ú¯ Ú©ÛŒ Ù‚Ø³Ù… Ù…Ø®ØµÙˆØµ Ø¯Ø§Ø¦Ø±Û Ú©Ø§Ø± Ú©Û’ Ù„ÛŒÛ’ Ø¯Ø±Ú©Ø§Ø± ÛÛ’Û”",
  bom_error_rm_item_invalid:
    "Ø®Ø§Ù… Ù…Ø§Ù„ Ú©ÛŒ Ù„Ø§Ø¦Ù† Ú©Ùˆ RM Ø¢Ø¦Ù¹Ù… Ú©Ø§ Ø­ÙˆØ§Ù„Û Ø¯ÛŒÙ†Ø§ Ú†Ø§ÛÛŒÛ’Û”",
  bom_error_rm_line_invalid:
    "Complete this raw material row: select material, department, and quantity.",
  bom_error_rm_department_duplicate:
    "ÙˆÛÛŒ Ù…ÛŒÙ¹ÛŒØ±ÛŒÙ„ Ø§Ø³ÛŒ Ø§Ø³ØªØ¹Ù…Ø§Ù„ Ú©Ø±Ù†Û’ ÙˆØ§Ù„Û’ Ø´Ø¹Ø¨Û Ú©Û’ Ø³Ø§ØªÚ¾ Ø¯ÙˆØ¨Ø§Ø±Û Ø´Ø§Ù…Ù„ Ù†ÛÛŒÚº Ú©ÛŒØ§ Ø¬Ø§ Ø³Ú©ØªØ§Û”",
  bom_error_rm_uom_required: "Ø®Ø§Ù… Ù…Ø§Ù„ UOM Ú©ÛŒ Ø¶Ø±ÙˆØ±Øª ÛÛ’Û”",
  bom_error_sfg_item_invalid:
    "Ù…Ù†ØªØ®Ø¨ Ú©Ø±Ø¯Û SKU Ú©Ø§ ØªØ¹Ù„Ù‚ Ù†ÛŒÙ… ØªÛŒØ§Ø± Ø´Ø¯Û Ø´Û’ Ø³Û’ ÛÙˆÙ†Ø§ Ú†Ø§ÛÛŒÛ’Û”",
  bom_error_sfg_line_invalid: "ØºÙ„Ø· Ù†ÛŒÙ… ØªÛŒØ§Ø± Ø´Ø¯Û Ù„Ø§Ø¦Ù†Û”",
  bom_error_sfg_section_incomplete:
    "Semi-Finished Ø³ÛŒÚ©Ø´Ù† Ú©Û’ ØªÙ…Ø§Ù… Ù„Ø§Ø²Ù…ÛŒ ÙÛŒÙ„ÚˆØ² Ù…Ú©Ù…Ù„ Ú©Ø±ÛŒÚº (Article SKUØŒ Step/Upper SKUØŒ Step Quantity)Û”",
  bom_error_sfg_not_allowed_for_sfg_level:
    "Ù†ÛŒÙ… ØªÛŒØ§Ø± Ø´Ø¯Û BOM Ù…ÛŒÚº SFG Ø³ÛŒÚ©Ø´Ù† Ù„Ø§Ø¦Ù†ÛŒÚº Ø´Ø§Ù…Ù„ Ù†ÛÛŒÚº ÛÙˆ Ø³Ú©ØªÛŒÚºÛ”",
  bom_error_sfg_requires_approved_bom:
    "Ù…Ù†ØªØ®Ø¨ Ú©Ø±Ø¯Û SFG Ø¢Ø¦Ù¹Ù… Ù…ÛŒÚº Ú©ÙˆØ¦ÛŒ Ù…Ù†Ø¸ÙˆØ± Ø´Ø¯Û BOM Ù†ÛÛŒÚº ÛÛ’Û”",
  bom_error_sfg_uom_required: "SFG UOM Ø¯Ø±Ú©Ø§Ø± ÛÛ’Û”",
  bom_error_size_required_for_specific_scope:
    "Ù…Ø®ØµÙˆØµ Ø¯Ø§Ø¦Ø±Û Ú©Ø§Ø± Ú©Û’ Ù„ÛŒÛ’ Ø³Ø§Ø¦Ø² Ø¯Ø±Ú©Ø§Ø± ÛÛ’Û”",
  bom_error_snapshot_mismatch:
    "ÚˆØ±Ø§ÙÙ¹ Ø³Ù†ÛŒÙ¾ Ø´Ø§Ù¹ Ù…Ù…Ø§Ø«Ù„ Ù†ÛÛŒÚº ÛÛ’Û”",
  bom_error_fix_fields:
    "BOM Ø¨Ú¾ÛŒØ¬Ù†Û’ Ø³Û’ Ù¾ÛÙ„Û’ ØªÙ…Ø§Ù… Ù„Ø§Ø²Ù…ÛŒ ÙÛŒÙ„ÚˆØ² Ù…Ú©Ù…Ù„ Ú©Ø±ÛŒÚºÛ”",
  bom_error_variant_action_invalid:
    "Ù…Ø®ØªÙ„Ù Ù‚Ø³Ù… Ú©ÛŒ Ú©Ø§Ø±Ø±ÙˆØ§Ø¦ÛŒ Ú©ÛŒ ØºÙ„Ø· Ù‚Ø³Ù…Û”",
  bom_error_color_rules_required_no_sku_colors:
    "Ø§Ø³ Ø¢Ø±Ù¹ÛŒÚ©Ù„ Ù…ÛŒÚº SKU Ø±Ù†Ú¯ÛŒ ÙˆÛŒØ±ÛŒØ¦Ù†Ù¹Ø³ Ù…ÙˆØ¬ÙˆØ¯ Ù†ÛÛŒÚºÛ” ÛØ± Ø§ÛŒØ³Û’ Ø®Ø§Ù… Ù…Ø§Ù„ Ú©Û’ Ù„ÛŒÛ’ Color Rules Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚº Ø¬Ø³ Ú©Û’ Ø§Ù†Ø¯Ø± Ù…ØªØ¹Ø¯Ø¯ Ø±Ù†Ú¯ÛŒ Ø±ÛŒÙ¹Ø³ ÛÛŒÚºÛ”",
  bom_error_color_rule_missing_for_material_prefix:
    "Ø§Ø³ Ù…ÛŒÙ¹ÛŒØ±ÛŒÙ„ Ú©Û’ Ù„ÛŒÛ’ Color Rule Ù…ÙˆØ¬ÙˆØ¯ Ù†ÛÛŒÚº",
  bom_error_variant_value_invalid_json:
    "ØºÙ„Ø· ÙˆÛŒØ±ÛŒÙ†Ù¹ ÙˆÛŒÙ„ÛŒÙˆ Ù¾Û’ Ù„ÙˆÚˆÛ”",
  bom_header: "BOM Ø³ÛŒÙ¹ Ø§Ù¾",
  bom_header_required_message:
    "Ù¾ÛÙ„Û’ BOM Ø³ÛŒÙ¹ Ø§Ù¾ Ù…Ú©Ù…Ù„ Ú©Ø±ÛŒÚºÛ” Ø§Ø³ Ú©Û’ Ø¨Ø¹Ø¯ Ù…ÛŒÙ¹ÛŒØ±ÛŒÙ„ØŒ SFG Ø§ÙˆØ± Ù„ÛŒØ¨Ø± Ø³ÛŒÚ©Ø´Ù† Ú©Ú¾Ù„ÛŒÚº Ú¯Û’Û”",
  bom_list: "BOM Ø±Ø¬Ø³Ù¹Ø±",
  bom_new_title: "BOM Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚºÛ”",
  bom_normal_loss_pct: "Ø¹Ø§Ù… Ù†Ù‚ØµØ§Ù† %",
  bom_output_qty: "Ø¢Ø¤Ù¹ Ù¾Ù¹ Ú©ÛŒ Ù…Ù‚Ø¯Ø§Ø±",
  bom_output_batch_size: "Ù…Ù†ØµÙˆØ¨Û Ø´Ø¯Û Ø¢Ø¤Ù¹ Ù¾Ù¹ Ù…Ù‚Ø¯Ø§Ø±",
  bom_output_uom: "Ø¢Ø¤Ù¹ Ù¾Ù¹ ÛŒÙˆÙ†Ù¹ (UOM)",
  bom_rm_rules_size_wise:
    "Ø³Ø§Ø¦Ø² Ú©Û’ Ù…Ø·Ø§Ø¨Ù‚ Ø®Ø§Ù… Ù…Ø§Ù„ Ú©Û’ Ù‚ÙˆØ§Ø¹Ø¯",
  bom_rm_section_hint:
    "Ø§ÛŒÚ© Ù…Ù†ØµÙˆØ¨Û Ø´Ø¯Û Ø¢Ø¤Ù¹ Ù¾Ù¹ Ø¨ÛŒÚ† Ú©Û’ Ù„ÛŒÛ’ ØªÙ…Ø§Ù… Ø®Ø§Ù… Ù…Ø§Ù„ Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚºØŒ Ù¾Ú¾Ø± Ø¶Ø±ÙˆØ±Øª ÛÙˆ ØªÙˆ Ø³Ø§Ø¦Ø² Ú©Û’ Ø­Ø³Ø§Ø¨ Ø³Û’ Ù‚ÙˆØ§Ø¹Ø¯ Ø§ÛŒÚˆØ¬Ø³Ù¹ Ú©Ø±ÛŒÚºÛ”",
  bom_rm_view_material_lines: "Ù…ÛŒÙ¹ÛŒØ±ÛŒÙ„ Ù„Ø§Ø¦Ù†Ø²",
  bom_rm_view_variant_rules: "Ø³Ø§Ø¦Ø² Ø±ÙˆÙ„Ø²",
  bom_sku_rules: "SKU Rules",
  bom_advanced_rules: "Advanced Rules",
  bom_sku_rules_hint:
    "Select a SKU to edit final raw material requirements. Only differences are saved as SKU overrides.",
  bom_select_sku: "Select SKU",
  bom_no_sku_available: "No SKU available for selected article.",
  bom_no_material_lines_for_sku_rules:
    "Add material lines first to edit SKU rules.",
  bom_labour_selection_title: "Ù„ÛŒØ¨Ø± Ø§Ù†ØªØ®Ø§Ø¨",
  bom_labour_selection_hint:
    "Ù„ÛŒØ¨Ø±ØŒ Ø´Ø¹Ø¨Û Ø§ÙˆØ± Ø±ÛŒÙ¹ Ù¹Ø§Ø¦Ù¾ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ” Ø³Ø§Ø¦Ø² Ú©Û’ Ù…Ø·Ø§Ø¨Ù‚ Ø±ÛŒÙ¹Ø³ Ù†ÛŒÚ†Û’ Ø³ÛŒÙ¹ ÛÙˆÚº Ú¯Û’Û”",
  bom_labour_size_rules_title: "Ø³Ø§Ø¦Ø² Ø±ÙˆÙ„Ø²",
  bom_labour_size_rules_hint:
    "ÛŒÛ Ø±ÛŒÙ¹Ø³ Ø§Ø³ÛŒ Ø³Ø§Ø¦Ø² ÙˆØ§Ù„Û’ ØªÙ…Ø§Ù… SKU Ù¾Ø± Ù„Ø§Ú¯Ùˆ ÛÙˆÚº Ú¯Û’Û”",
  bom_labour_sku_rules_hint:
    "SKU Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº Ø§ÙˆØ± Ù„ÛŒØ¨Ø± Ø±ÛŒÙ¹Ø³ Ø³ÛŒÙ¹ Ú©Ø±ÛŒÚºÛ” ÛŒÛ Ø±ÛŒÙ¹Ø³ Ù…Ù†ØªØ®Ø¨ SKU Ú©Û’ Ø³Ø§Ø¦Ø² Ø§Ø³Ú©ÙˆÙ¾ Ú©Û’ Ù…Ø·Ø§Ø¨Ù‚ Ù„Ø§Ú¯Ùˆ ÛÙˆÚº Ú¯Û’Û”",
  bom_no_labour_selected:
    "Ø³Ø§Ø¦Ø² Ú©Û’ Ù…Ø·Ø§Ø¨Ù‚ Ø±ÛŒÙ¹Ø³ Ø³ÛŒÙ¹ Ú©Ø±Ù†Û’ Ú©Û’ Ù„ÛŒÛ’ Ù¾ÛÙ„Û’ Ù„ÛŒØ¨Ø± Ù„Ø§Ø¦Ù†Ø² Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚºÛ”",
  bom_color_scope_hint:
    "Ù…ÛŒÙ¹ÛŒØ±ÛŒÙ„ Ú©Ù„Ø± Ù…ÛŒÙ¾Ù†Ú¯ Ù…ÛŒÚº ØªØ±Ù…ÛŒÙ… Ú©Û’ Ù„ÛŒÛ’ SKU ÙˆÛŒØ±ÛŒØ¦Ù†Ù¹ Ø§Ø³Ú©ÙˆÙ¾ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  bom_rm_col_material: "Ù…ÛŒÙ¹ÛŒØ±ÛŒÙ„",
  bom_rm_col_color: "Ø±Ù†Ú¯ Ú©ÛŒ Ù‚Ø³Ù…",
  bom_rm_col_size: "Ø³Ø§Ø¦Ø² Ú©ÛŒ Ù‚Ø³Ù…",
  bom_rm_col_department: "Ø§Ø³ØªØ¹Ù…Ø§Ù„ Ú©Ø±Ù†Û’ ÙˆØ§Ù„Ø§ ÚˆÛŒÙ¾Ø§Ø±Ù¹Ù…Ù†Ù¹",
  bom_rm_col_actions: "Ø§Ø¹Ù…Ø§Ù„",
  bom_sku_variant_scope: "SKU ÙˆÛŒØ±ÛŒØ¦Ù†Ù¹ Ø§Ø³Ú©ÙˆÙ¾",
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
    "Ø¬Ø³ Ø³Ø§Ø¦Ø² Ú©Û’ Ù„ÛŒÛ’ Ù‚ÙˆØ§Ø¹Ø¯ ØªØ¨Ø¯ÛŒÙ„ Ú©Ø±Ù†Û’ ÛÛŒÚºØŒ ÙˆÛ Ø³Ø§Ø¦Ø² Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  bom_rules_active_size_label:
    "Ø§Ø³ Ø³Ø§Ø¦Ø² Ú©Û’ Ù‚ÙˆØ§Ø¹Ø¯ Ù…ÛŒÚº ØªØ±Ù…ÛŒÙ…",
  bom_rules_count_label: "Ø±ÙˆÙ„Ø²",
  bom_rules_col_qty: "Ø¯Ø±Ú©Ø§Ø± Ù…Ù‚Ø¯Ø§Ø±",
  bom_rules_col_uom: "ÛŒÙˆÙ†Ù¹",
  bom_sfg_col_step_upper_sku: "Step/Upper SKU",
  bom_sfg_col_step_qty: "Step Quantity",
  bom_all_skus: "ØªÙ…Ø§Ù… SKU",
  bom_all_skus_no_color:
    "ØªÙ…Ø§Ù… SKU (Ø±Ù†Ú¯ÛŒ ÙˆÛŒØ±ÛŒØ¦Ù†Ù¹ Ù…ÙˆØ¬ÙˆØ¯ Ù†ÛÛŒÚº)",
  bom_rule_add_rm: "RM Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚºÛ”",
  bom_rule_adjust_qty: "Ù…Ù‚Ø¯Ø§Ø± Ú©Ùˆ Ø§ÛŒÚˆØ¬Ø³Ù¹ Ú©Ø±ÛŒÚºÛ”",
  bom_rule_change_loss: "Ù†Ù‚ØµØ§Ù† Ú©Ùˆ ØªØ¨Ø¯ÛŒÙ„ Ú©Ø±ÛŒÚºÛ”",
  bom_rule_remove_rm: "RM Ú©Ùˆ ÛÙ¹Ø§ Ø¯ÛŒÚºÛ”",
  bom_rule_replace_rm: "RM Ú©Ùˆ ØªØ¨Ø¯ÛŒÙ„ Ú©Ø±ÛŒÚºÛ”",
  bom_specific: "Ù…Ø®ØµÙˆØµ",
  bom_tab_labour:
    "Ø³Ø§Ø¦Ø² Ø§ÙˆØ± ÚˆÛŒÙ¾Ø§Ø±Ù¹Ù…Ù†Ù¹ Ú©Û’ Ù…Ø·Ø§Ø¨Ù‚ Ù„ÛŒØ¨Ø± Ø±ÛŒÙ¹Ø³",
  bom_tab_rm: "Ø§Ø³ BOM Ú©Û’ Ù„ÛŒÛ’ Ø®Ø§Ù… Ù…Ø§Ù„ Ø§ÙÙ† Ù¾Ù¹Ø³",
  bom_tab_sfg:
    "Ø§Ø³ØªØ¹Ù…Ø§Ù„ ÛÙˆÙ†Û’ ÙˆØ§Ù„ÛŒ Ù†ÛŒÙ… ØªÛŒØ§Ø± Ù…ØµÙ†ÙˆØ¹Ø§Øª (Ø§Ú¯Ø± ÛÙˆÚº)",
  bom_tab_sfg_per_sku: "ہر SKU کے لیے استعمال ہونے والی نیم تیار مصنوعات",
  bom_tab_variant_rules: "Ù…ØªØºÛŒØ± Ù‚ÙˆØ§Ø¹Ø¯",
  bom_version_created: "Ù†ÛŒØ§ ÙˆØ±Ú˜Ù† Ø¨Ù†Ø§ÛŒØ§ Ú¯ÛŒØ§Û”",
  bom_versions: "ÙˆØ±Ú˜Ù†Ø²",
  bom_versions_description:
    "Ø¢Ø¦Ù¹Ù… Ø§ÙˆØ± Ø³Ø·Ø­ Ú©Û’ Ù„Ø­Ø§Ø¸ Ø³Û’ ÙˆØ±Ú˜Ù† Ú©ÛŒ ØªØ§Ø±ÛŒØ® Ø§ÙˆØ± Ø­ÛŒØ«ÛŒØª Ú©Ùˆ Ù¹Ø±ÛŒÚ© Ú©Ø±ÛŒÚºÛ”",
  book_number: "Ú©ØªØ§Ø¨ Ú©Ø§ Ù†Ù…Ø¨Ø±",
  branch_code: "Ø¨Ø±Ø§Ù†Ú† Ú©ÙˆÚˆ",
  branch_name_ur: "Ø¨Ø±Ø§Ù†Ú† Ú©Ø§ Ù†Ø§Ù… (Ø§Ø±Ø¯Ùˆ)",
  branch_not_found: "Ø¨Ø±Ø§Ù†Ú† Ù†ÛÛŒÚº Ù…Ù„ÛŒÛ”",
  branches: "Ø´Ø§Ø®ÛŒÚº",
  cancel: "Ù…Ù†Ø³ÙˆØ® Ú©Ø±ÛŒÚºÛ”",
  cash_account: "Ú©ÛŒØ´ Ø§Ú©Ø§Ø¤Ù†Ù¹",
  cash_account_required:
    "Ù†Ù‚Ø¯ Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ Ú©Û’ Ù„ÛŒÛ’ Ú©ÛŒØ´ Ø§Ú©Ø§Ø¤Ù†Ù¹ Ø¯Ø±Ú©Ø§Ø± ÛÛ’Û”",
  cash_book: "Ú©ÛŒØ´ Ø¨Ú©",
  cash_paid_account: "Ú©ÛŒØ´ Ù¾ÛŒÚˆ Ø§Ú©Ø§Ø¤Ù†Ù¹",
  cash_payment: "Ù†Ù‚Ø¯ Ø§Ø¯Ø§Ø¦ÛŒÚ¯ÛŒ",
  cash_purchase: "Ù†Ù‚Ø¯ Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ",
  cash_receipt: "Ù†Ù‚Ø¯ Ø±Ø³ÛŒØ¯",
  cash_sale: "Ú©ÛŒØ´ Ø³ÛŒÙ„",
  cash_voucher: "Ú©ÛŒØ´ ÙˆØ§Ø¤Ú†Ø±",
  cash_voucher_description:
    "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©Û’ Ù„ÛŒÛ’ ØªÛŒØ§Ø± ÙˆØ±Ú© ÙÙ„Ùˆ Ú©Û’ Ø³Ø§ØªÚ¾ Ù†Ù‚Ø¯ Ø§Ø¯Ø§Ø¦ÛŒÚ¯ÛŒ/Ø±Ø³ÛŒØ¯ ÙˆØ§Ø¤Ú†Ø± Ø¨Ù†Ø§Ø¦ÛŒÚº Ø§ÙˆØ± Ø¬Ù…Ø¹ Ú©Ø±ÙˆØ§Ø¦ÛŒÚºÛ”",
  cash_voucher_register: "Ú©ÛŒØ´ ÙˆØ§Ø¤Ú†Ø± Ø±Ø¬Ø³Ù¹Ø±",
  cashier: "Ú©ÛŒØ´Ø¦ÛŒØ±",
  cashiers: "Ú©ÛŒØ´ÛŒØ¦Ø±Ø²",
  category: "Ø²Ù…Ø±Û",
  change_percentage: "ØªØ¨Ø¯ÛŒÙ„ÛŒ %",
  change_summary: "ØªØ¨Ø¯ÛŒÙ„ÛŒ Ú©Ø§ Ø®Ù„Ø§ØµÛ",
  change_vs_previous: "ØªØ¨Ø¯ÛŒÙ„ÛŒ Ø¨Ù…Ù‚Ø§Ø¨Ù„Û Ù¾Ú†Ú¾Ù„Ø§",
  change_vs_previous_help:
    "Ù…Ø«Ø¨Øª Ú©Ø§ Ù…Ø·Ù„Ø¨ ÛÛ’ Ú¯Ø²Ø´ØªÛ Ù…Ø¯Øª Ú©Û’ Ù…Ù‚Ø§Ø¨Ù„Û’ Ø§Ø®Ø±Ø§Ø¬Ø§Øª Ù…ÛŒÚº Ø§Ø¶Ø§ÙÛÛ”",
  changed_fields: "ØªØ¨Ø¯ÛŒÙ„ Ø´Ø¯Û ÙÛŒÙ„ÚˆØ²",
  check_availability: "Ø¯Ø³ØªÛŒØ§Ø¨ÛŒ Ú†ÛŒÚ© Ú©Ø±ÛŒÚºÛ”",
  choose_option_top_right:
    "Ø§ÙˆÙ¾Ø±ÛŒ Ø¯Ø§Ø¦ÛŒÚº Ø³Û’ Ø¢Ù¾Ø´Ù† Ú©Ø§ Ø§Ù†ØªØ®Ø§Ø¨ Ú©Ø±ÛŒÚºÛ”",
  choose_role_above:
    "Ø§Ø¬Ø§Ø²ØªÙˆÚº Ú©Ùˆ Ø¯ÛŒÚ©Ú¾Ù†Û’ Ø§ÙˆØ± Ø§Ù¾ ÚˆÛŒÙ¹ Ú©Ø±Ù†Û’ Ú©Û’ Ù„ÛŒÛ’ Ø§ÙˆÙ¾Ø± Ø§ÛŒÚ© Ú©Ø±Ø¯Ø§Ø± Ú©Ø§ Ø§Ù†ØªØ®Ø§Ø¨ Ú©Ø±ÛŒÚºÛ”",
  choose_role_or_user_above:
    "Ø§Ø¬Ø§Ø²ØªÙˆÚº Ú©Ùˆ ØªØ±ØªÛŒØ¨ Ø¯ÛŒÙ†Û’ Ú©Û’ Ù„ÛŒÛ’ Ø§ÙˆÙ¾Ø± Ø§ÛŒÚ© Ú©Ø±Ø¯Ø§Ø± ÛŒØ§ ØµØ§Ø±Ù Ú©Ø§ Ø§Ù†ØªØ®Ø§Ø¨ Ú©Ø±ÛŒÚºÛ”",
  clear: "ØµØ§Ù",
  closing_balance: "Ø§Ø®ØªØªØ§Ù…ÛŒ Ø¨ÛŒÙ„Ù†Ø³",
  cnic: "CNIC",
  code: "Ú©ÙˆÚˆ",
  collapse: "Ø³Ù…Ù¹Ù†Ø§",
  color_rates: "Ø±Ù†Ú¯ Ú©Û’ Ù†Ø±Ø®",
  colors: "Ø±Ù†Ú¯",
  commission_basis: "Ú©Ù…ÛŒØ´Ù† Ú©ÛŒ Ø¨Ù†ÛŒØ§Ø¯",
  commission_basis_fixed_per_invoice: "ÙÛŒ Ø§Ù†ÙˆØ§Ø¦Ø³ ÙÚ©Ø³Úˆ",
  commission_basis_fixed_per_unit: "ÙÚ©Ø³Úˆ ÙÛŒ Ø¨Ù†ÛŒØ§Ø¯ÛŒ ÛŒÙˆÙ†Ù¹",
  commission_basis_gross_margin_percent: "Ù…Ø¬Ù…ÙˆØ¹ÛŒ Ù…Ø§Ø±Ø¬Ù† Ú©Ø§ %",
  commission_basis_net_sales_percent: "Ø®Ø§Ù„Øµ ÙØ±ÙˆØ®Øª Ú©Ø§ %",
  condition_at_dispatch: "ÚˆØ³Ù¾ÛŒÚ† Ú©Û’ ÙˆÙ‚Øª Ø­Ø§Ù„Øª",
  condition_on_return: "ÙˆØ§Ù¾Ø³ÛŒ Ú©ÛŒ Ø­Ø§Ù„Øª",
  config: "ØªØ±ØªÛŒØ¨",
  context: "Ø³ÛŒØ§Ù‚ Ùˆ Ø³Ø¨Ø§Ù‚",
  continue: "Ø¬Ø§Ø±ÛŒ Ø±Ú©Ú¾ÛŒÚº",
  contribution_to_delta: "ÚˆÛŒÙ„Ù¹Ø§ Ú©Ø§ %",
  contribution_to_delta_tooltip:
    "Ø¯Ú©Ú¾Ø§Ø¦Û’ Ú¯Ø¦Û’ ÚˆØ±Ø§Ø¦ÛŒÙˆØ±ÙˆÚº Ù…ÛŒÚº ÛØ± Ù‚Ø·Ø§Ø± Ú©Ø§ Ø­ØµÛ Ù…Ø·Ù„Ù‚ ØªØ¨Ø¯ÛŒÙ„ÛŒÛ”",
  contribution_to_driver_movement:
    "ÚˆØ±Ø§Ø¦ÛŒÙˆØ± Ú©ÛŒ Ù†Ù‚Ù„ Ùˆ Ø­Ø±Ú©Øª Ú©Ø§ %",
  conversion_exists: "ØªØ¨Ø¯ÛŒÙ„ÛŒ Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  conversion_factor:
    "ØªØ¨Ø§Ø¯Ù„ÙˆÚº Ú©Ø§ Ø¹Ù†ØµØ± ØµÙØ± Ø³Û’ Ø²ÛŒØ§Ø¯Û ÛÙˆÙ†Ø§ Ú†Ø§ÛÛŒÛ’Û”",
  conversion_same_units:
    "Ø³Û’ Ø§ÙˆØ± ØªÚ© ÛŒÙˆÙ†Ù¹Ø³ Ø§ÛŒÚ© Ø¬ÛŒØ³Û’ Ù†ÛÛŒÚº ÛÙˆ Ø³Ú©ØªÛ’Û”",
  coverage_scope_both: "Ø¯ÙˆÙ†ÙˆÚº",
  coverage_scope_fg: "Ø®ØªÙ…",
  coverage_scope_sfg: "Ù†ÛŒÙ… ØªÛŒØ§Ø±",
  created: "Ø¨Ù†Ø§ÛŒØ§",
  created_at: "Ù¾Ø± ØªØ®Ù„ÛŒÙ‚ Ú©ÛŒØ§ Ú¯ÛŒØ§Û”",
  created_by: "Ú©Û’ Ø°Ø±ÛŒØ¹Û ØªØ®Ù„ÛŒÙ‚ Ú©ÛŒØ§ Ú¯ÛŒØ§Û”",
  credit: "Ú©Ø±ÛŒÚˆÙ¹",
  credit_allowed: "Ú©Ø±ÛŒÚˆÙ¹ Ú©ÛŒ Ø§Ø¬Ø§Ø²Øª ÛÛ’Û”",
  credit_purchase: "Ú©Ø±ÛŒÚˆÙ¹ Ù¾Ø±Ú†ÛŒØ²",
  credit_sale: "Ú©Ø±ÛŒÚˆÙ¹ Ø³ÛŒÙ„",
  credits_adjustments: "Ú©Ø±ÛŒÚˆÙ¹ / Ø§ÛŒÚˆØ¬Ø³Ù¹Ù…Ù†Ù¹",
  current_dozen_rate: "Ù…ÙˆØ¬ÙˆØ¯Û Ø¯Ø±Ø¬Ù† Ú©ÛŒ Ø´Ø±Ø­",
  current_period: "Ù…ÙˆØ¬ÙˆØ¯Û Ø¯ÙˆØ±",
  current_period_total: "Ù…ÙˆØ¬ÙˆØ¯Û Ù…Ø¯Øª Ú©Ø§ Ú©Ù„",
  customer: "Ú¯Ø§ÛÚ©",
  customer_balance_information: "Ú©Ø³Ù¹Ù…Ø± Ø¨ÛŒÙ„Ù†Ø³ Ú©ÛŒ Ù…Ø¹Ù„ÙˆÙ…Ø§Øª",
  customer_balances_report: "Ú©Ø³Ù¹Ù…Ø± Ø¨ÛŒÙ„Ù†Ø³ Ú©ÛŒ Ø±Ù¾ÙˆØ±Ù¹",
  customer_contact_analysis: "Ú©Ø³Ù¹Ù…Ø± Ø±Ø§Ø¨Ø·Û ØªØ¬Ø²ÛŒÛ",
  customer_ledger_report: "Ú©Ø³Ù¹Ù…Ø± Ù„ÛŒØ¬Ø± Ø±Ù¾ÙˆØ±Ù¹",
  customer_listings: "Ú¯Ø§ÛÚ© Ú©ÛŒ ÙÛØ±Ø³ØªÛŒÚº",
  customer_name: "Ú¯Ø§ÛÚ© Ú©Ø§ Ù†Ø§Ù…",
  customer_pickup: "Ú©Ø³Ù¹Ù…Ø± Ù¾Ú© Ø§Ù¾",
  customer_reports: "Ú©Ø³Ù¹Ù…Ø± Ø±Ù¾ÙˆØ±Ù¹Ø³",
  daily: "Ø±ÙˆØ²Ø§Ù†Û",
  dashboard: "ÚˆÛŒØ´ Ø¨ÙˆØ±Úˆ",
  date_filters_auto_corrected:
    "ØªØ§Ø±ÛŒØ® Ú©Û’ Ú©Ú†Ú¾ ÙÙ„Ù¹Ø±Ø² ØºÙ„Ø· ØªÚ¾Û’ Ø§ÙˆØ± Ø§Ù†ÛÛŒÚº Ø¯ÙˆØ¨Ø§Ø±Û ØªØ±ØªÛŒØ¨ Ø¯ÛŒØ§ Ú¯ÛŒØ§ ÛÛ’Û”",
  date_range: "ØªØ§Ø±ÛŒØ® Ú©ÛŒ Ø­Ø¯",
  deactivate: "ØºÛŒØ± ÙØ¹Ø§Ù„ Ú©Ø±ÛŒÚºÛ”",
  debit: "ÚˆÛŒØ¨Ù¹",
  decision: "ÙÛŒØµÙ„Û",
  deleted_successfully: "Ú©Ø§Ù…ÛŒØ§Ø¨ÛŒ Ø³Û’ Ø­Ø°Ù Ú©Ø± Ø¯ÛŒØ§ Ú¯ÛŒØ§Û”",
  deletion_requested: "Ø­Ø°Ù Ú©Ø±Ù†Û’ Ú©ÛŒ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ú©ÛŒ Ú¯Ø¦ÛŒÛ”",
  delivery_method: "ØªØ±Ø³ÛŒÙ„ Ú©Ø§ Ø·Ø±ÛŒÙ‚Û",
  delta: "ÚˆÛŒÙ„Ù¹Ø§",
  delta_tooltip:
    "Ù…ÙˆØ¬ÙˆØ¯Û Ù…Ø¯Øª Ú©Ø§ Ú©Ù„ Ù…Ø§Ø¦Ù†Ø³ Ù¾Ú†Ú¾Ù„ÛŒ Ù…Ø¯Øª Ú©Ø§ Ú©Ù„Û”",
  department: "Ù…Ø­Ú©Ù…Û",
  department_breakdown: "Ù…Ø­Ú©Ù…Û Ú©ÛŒ Ø®Ø±Ø§Ø¨ÛŒÛ”",
  departments: "Ù…Ø­Ú©Ù…Û’",
  production_stages: "Production Stages",
  departments_description:
    "Ù¾ÛŒØ¯Ø§ÙˆØ§Ø± Ø¨Ù…Ù‚Ø§Ø¨Ù„Û ØºÛŒØ± Ù¾ÛŒØ¯Ø§ÙˆØ§Ø±ÛŒ Ù„Ø§Ú¯Øª Ú©Û’ Ù…Ø±Ø§Ú©Ø²Û”",
  designation_role: "Ø¹ÛØ¯Û/ Ú©Ø±Ø¯Ø§Ø±",
  details: "ØªÙØµÛŒÙ„Ø§Øª",
  dismiss: "Ø¨Ø±Ø·Ø±Ù Ú©Ø±Ù†Ø§",
  dozen_rate: "Ø¯Ø±Ø¬Ù† Ø±ÛŒÙ¹",
  drilldown_starts_at: "ÚˆØ±Ù„ ÚˆØ§Ø¤Ù† Ø´Ø±ÙˆØ¹ ÛÙˆØªØ§ ÛÛ’Û”",
  dropped_to_zero: "ØµÙØ± Ù¾Ø± Ú¯Ø± Ú¯ÛŒØ§Û”",
  edit: "ØªØ±Ù…ÛŒÙ… Ú©Ø±ÛŒÚºÛ”",
  edit_branch: "Ø¨Ø±Ø§Ù†Ú† Ù…ÛŒÚº ØªØ±Ù…ÛŒÙ… Ú©Ø±ÛŒÚºÛ”",
  edit_rates: "Ø´Ø±Ø­ÙˆÚº Ù…ÛŒÚº ØªØ±Ù…ÛŒÙ… Ú©Ø±ÛŒÚºÛ”",
  edit_role: "Ú©Ø±Ø¯Ø§Ø± Ù…ÛŒÚº ØªØ±Ù…ÛŒÙ… Ú©Ø±ÛŒÚºÛ”",
  effective_from: "Ø³Û’ Ù…ÙˆØ«Ø±",
  effective_to: "Ú©Û’ Ù„ÛŒÛ’ Ù…ÙˆØ«Ø±",
  employees: "Ù…Ù„Ø§Ø²Ù…ÛŒÙ†",
  employees_description:
    "HR Ø§ÙˆØ± Ù¾Û’ Ø±ÙˆÙ„ Ú©Û’ Ù„ÛŒÛ’ Ù…Ù„Ø§Ø²Ù… Ú©Û’ Ù…Ø§Ø³Ù¹Ø± Ø±ÛŒÚ©Ø§Ø±Úˆ Ú©Ø§ Ù†Ø¸Ù… Ú©Ø±ÛŒÚºÛ”",
  enter: "Ø¯Ø§Ø®Ù„ Ú©Ø±ÛŒÚºÛ”",
  enter_code: "Ú©ÙˆÚˆ Ø¯Ø±Ø¬ Ú©Ø±ÛŒÚºÛ”",
  enter_details_save:
    "ØªÙØµÛŒÙ„Ø§Øª Ø¯Ø±Ø¬ Ú©Ø±ÛŒÚº Ø§ÙˆØ± Ù…Ø­ÙÙˆØ¸ Ú©Ø±ÛŒÚºÛ”",
  enter_note: "Ø§ÛŒÚ© Ù†ÙˆÙ¹ Ø¯Ø±Ø¬ Ú©Ø±ÛŒÚºÛ”",
  entity: "ÛØ³ØªÛŒ",
  entity_id: "ÛØ³ØªÛŒ Ú©ÛŒ Ø´Ù†Ø§Ø®Øª",
  entity_type: "ÛØ³ØªÛŒ Ú©ÛŒ Ù‚Ø³Ù…",
  entries: "Ø§Ù†Ø¯Ø±Ø§Ø¬Ø§Øª",
  error_action_not_allowed: "Ø§Ø³ Ø¹Ù…Ù„ Ú©ÛŒ Ø§Ø¬Ø§Ø²Øª Ù†ÛÛŒÚº ÛÛ’Û”",
  error_add_valid_purchase_rate:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ú©Ù… Ø§Ø² Ú©Ù… Ø§ÛŒÚ© Ø¯Ø±Ø³Øª Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ Ú©ÛŒ Ø´Ø±Ø­ Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚºÛ”",
  error_advance_receive_enabled_no_amount:
    "Ø§ÛŒÚˆÙˆØ§Ù†Ø³ ÙˆØµÙˆÙ„ÛŒ ÙØ¹Ø§Ù„ ÛÛ’ Ù„ÛŒÚ©Ù† Ú©ÙˆØ¦ÛŒ Ø§ÛŒÚˆÙˆØ§Ù†Ø³ Ø§Ø¯Ø§Ø¦ÛŒÚ¯ÛŒ Ú©ÛŒ Ø±Ù‚Ù… Ø¯Ø±Ø¬ Ù†ÛÛŒÚº Ú©ÛŒ Ú¯Ø¦ÛŒÛ”",
  error_branch_code_exists: "Ø¨Ø±Ø§Ù†Ú† Ú©ÙˆÚˆ Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  error_branch_out_of_scope:
    "Ø§ÛŒÚ© ÛŒØ§ Ø²ÛŒØ§Ø¯Û Ù…Ù†ØªØ®Ø¨ Ø´Ø§Ø®ÛŒÚº Ø¢Ù¾ Ú©ÛŒ Ø¨Ø±Ø§Ù†Ú† Ú©ÛŒ Ø±Ø³Ø§Ø¦ÛŒ Ø³Û’ Ø¨Ø§ÛØ± ÛÛŒÚºÛ”",
  error_cash_received_must_equal_final:
    "ÙˆØµÙˆÙ„ Ø´Ø¯Û Ø±Ù‚Ù… Ù†Ù‚Ø¯ ÙØ±ÙˆØ®Øª Ú©Û’ Ù„ÛŒÛ’ Ø­ØªÙ…ÛŒ Ø±Ù‚Ù… Ú©Û’ Ø¨Ø±Ø§Ø¨Ø± ÛÙˆÙ†ÛŒ Ú†Ø§ÛÛŒÛ’Û”",
  error_cash_sale_no_advanced_amount:
    "Ù†Ù‚Ø¯ ÙØ±ÙˆØ®Øª Ú©Û’ Ù„ÛŒÛ’ Ø§ÛŒÚˆÙˆØ§Ù†Ø³Úˆ ÙˆØµÙˆÙ„ Ø´Ø¯Û Ø±Ù‚Ù… Ø¯Ø±Ú©Ø§Ø± ÛÛ’Û”",
  error_cash_voucher_single_direction:
    "Ú©ÛŒØ´ ÙˆØ§Ø¤Ú†Ø± Ø§ÛŒÚ© Ø·Ø±Ù ÛÙˆÙ†Ø§ Ú†Ø§ÛÛŒÛ’: Ø±Ø³ÛŒØ¯ ÛŒØ§ Ø§Ø¯Ø§Ø¦ÛŒÚ¯ÛŒ Ú©Ø§ Ø§Ø³ØªØ¹Ù…Ø§Ù„ Ú©Ø±ÛŒÚºÛ”",
  error_delete: "Ø­Ø°Ù Ú©Ø±Ù†Û’ Ø³Û’ Ù‚Ø§ØµØ±Û”",
  error_duplicate_allowance_rule:
    "Ø§Ø³ Ù…Ù„Ø§Ø²Ù… Ú©Û’ Ù„ÛŒÛ’ Ø§Ù„Ø§Ø¤Ù†Ø³ Ú©ÛŒ Ù‚Ø³Ù… Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  error_duplicate_cnic: "CNIC Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  error_duplicate_code: "Ú©ÙˆÚˆ Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  error_duplicate_commission_rule:
    "Ø§Ø³ÛŒ Ø·Ø±Ø­ Ú©Ø§ Ú©Ù…ÛŒØ´Ù† Ú©Ø§ Ø§ØµÙˆÙ„ Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  error_duplicate_labour_rate_rule:
    "Ø§Ø³ÛŒ Ø·Ø±Ø­ Ú©ÛŒ Ù…Ø²Ø¯ÙˆØ±ÛŒ Ú©ÛŒ Ø´Ø±Ø­ Ú©Ø§ Ø§ØµÙˆÙ„ Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  error_duplicate_name:
    "Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ù†Ø¸ÙˆØ± Ù†ÛÛŒÚº ÛÙˆ Ø³Ú©ÛŒ Ú©ÛŒÙˆÙ†Ú©Û Ù†Ø§Ù… Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  error_duplicate_phone_number: "ÙÙˆÙ† Ù†Ù…Ø¨Ø± Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  error_duplicate_record:
    "Ø§Ø³ÛŒ ØªÙØµÛŒÙ„Ø§Øª Ú©Û’ Ø³Ø§ØªÚ¾ Ø§ÛŒÚ© Ø±ÛŒÚ©Ø§Ø±Úˆ Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  error_generic: "Ø®Ø±Ø§Ø¨ÛŒ",
  error_group_subgroup_only_for_bulk_commission:
    "Ø§Ø³ Ø§Ø³Ú©Ø±ÛŒÙ† Ú©Û’ Ù„ÛŒÛ’ØŒ Ú¯Ø±ÙˆÙ¾/Ø³Ø¨ Ú¯Ø±ÙˆÙ¾ Ú©Ù…ÛŒØ´Ù† Ú©ÛŒ ØªØ¨Ø¯ÛŒÙ„ÛŒÙˆÚº Ú©ÛŒ Ø§Ø¬Ø§Ø²Øª ØµØ±Ù Ø¨Ù„Ú© Ø³ÛŒÙˆ Ú©Û’ Ø°Ø±ÛŒØ¹Û’ ÛÛ’Û”",
  error_immutable_field:
    "Ø·Ø¨Ø¹ÛŒ Ù…Ø®ØªÙ„Ù Ø®ØµÙˆØµÛŒØ§Øª Ù…ÛŒÚº ØªØ±Ù…ÛŒÙ… Ù†ÛÛŒÚº Ú©ÛŒ Ø¬Ø§ Ø³Ú©ØªÛŒÛ”",
  error_invalid_account_group:
    "Ø§Ú©Ø§Ø¤Ù†Ù¹ Ú©Ø§ ØºÙ„Ø· Ú¯Ø±ÙˆÙ¾ Ù…Ù†ØªØ®Ø¨ Ú©ÛŒØ§ Ú¯ÛŒØ§Û”",
  error_invalid_amount_type:
    "Ø±Ù‚Ù… Ú©ÛŒ ØºÙ„Ø· Ù‚Ø³Ù… Ù…Ù†ØªØ®Ø¨ Ú©ÛŒ Ú¯Ø¦ÛŒÛ”",
  error_invalid_apply_on: "Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù¾Ø± ØºÙ„Ø· Ø§Ù†ØªØ®Ø§Ø¨Û”",
  error_invalid_article_type:
    "ØºÙ„Ø· Ù…Ø¶Ù…ÙˆÙ† Ú©ÛŒ Ù‚Ø³Ù… Ù…Ù†ØªØ®Ø¨ Ú©ÛŒ Ú¯Ø¦ÛŒÛ”",
  error_invalid_bulk_commission_payload:
    "ØºÙ„Ø· Ø¨Ù„Ú© Ú©Ù…ÛŒØ´Ù† Ù¾Û’ Ù„ÙˆÚˆÛ”",
  error_invalid_bulk_labour_rate_payload:
    "ØºÙ„Ø· Ù„ÛŒØ¨Ø± Ø±ÛŒÙ¹ Ù¾Û’ Ù„ÙˆÚˆÛ”",
  error_invalid_cnic: "ØºÙ„Ø· CNIC ÙØ§Ø±Ù…ÛŒÙ¹Û”",
  error_invalid_commission_basis:
    "Ú©Ù…ÛŒØ´Ù† Ú©ÛŒ Ø¨Ù†ÛŒØ§Ø¯ Ù¾Ø± ØºÙ„Ø· Ø§Ù†ØªØ®Ø§Ø¨ Ú©ÛŒØ§ Ú¯ÛŒØ§Û”",
  error_invalid_frequency: "ØºÙ„Ø· ÙØ±ÛŒÚ©ÙˆØ¦Ù†Ø³ÛŒ Ù…Ù†ØªØ®Ø¨ Ú©ÛŒ Ú¯Ø¦ÛŒÛ”",
  error_invalid_payroll_type:
    "Ù¾Û’ Ø±ÙˆÙ„ Ú©ÛŒ ØºÙ„Ø· Ù‚Ø³Ù… Ù…Ù†ØªØ®Ø¨ Ú©ÛŒ Ú¯Ø¦ÛŒÛ”",
  error_invalid_phone_number: "ÙÙˆÙ† Ù†Ù…Ø¨Ø± Ú©ÛŒ ØºÙ„Ø· Ø´Ú©Ù„Û”",
  error_invalid_posting_class:
    "ØºÙ„Ø· Ù¾ÙˆØ³Ù¹Ù†Ú¯ Ú©Ù„Ø§Ø³ Ù…Ù†ØªØ®Ø¨ Ú©ÛŒ Ú¯Ø¦ÛŒÛ”",
  error_invalid_production_category:
    "ØºÙ„Ø· Ù¾Ø±ÙˆÚˆÚ©Ø´Ù† Ø²Ù…Ø±Û Ù…Ù†ØªØ®Ø¨ Ú©ÛŒØ§ Ú¯ÛŒØ§Û”",
  error_invalid_rate_type: "ØºÙ„Ø· Ø´Ø±Ø­ Ú©ÛŒ Ù‚Ø³Ù… Ù…Ù†ØªØ®Ø¨ Ú©ÛŒ Ú¯Ø¦ÛŒÛ”",
  error_invalid_rate_value: "ØºÙ„Ø· Ù‚Ø¯Ø±",
  error_invalid_salary:
    "Ø¨Ù†ÛŒØ§Ø¯ÛŒ ØªÙ†Ø®ÙˆØ§Û Ø§ÛŒÚ© ØºÛŒØ± Ù…Ù†ÙÛŒ Ù†Ù…Ø¨Ø± ÛÙˆÙ†ÛŒ Ú†Ø§ÛÛŒÛ’Û”",
  error_invalid_salary_precision:
    "Ø¨Ù†ÛŒØ§Ø¯ÛŒ ØªÙ†Ø®ÙˆØ§Û ØµØ±Ù 2 Ø§Ø¹Ø´Ø§Ø±ÛŒÛ 2 Ù…Ù‚Ø§Ù…Ø§Øª Ø§ÙˆØ± Ø¯Ø±Ø³Øª Ø­Ø¯ ØªÚ© Ø³Ù¾ÙˆØ±Ù¹ Ú©Ø±ØªÛŒ ÛÛ’Û”",
  error_invalid_status: "ØºÙ„Ø· Ø­ÛŒØ«ÛŒØª Ú©Ø§ Ø§Ù†ØªØ®Ø§Ø¨ Ú©ÛŒØ§ Ú¯ÛŒØ§Û”",
  error_invalid_value: "Ø§ÛŒÚ© ÛŒØ§ Ø²ÛŒØ§Ø¯Û Ù‚Ø¯Ø±ÛŒÚº ØºÙ„Ø· ÛÛŒÚºÛ”",
  error_invalid_value_type:
    "ØºÙ„Ø· Ù‚Ø¯Ø± Ú©ÛŒ Ù‚Ø³Ù… Ù…Ù†ØªØ®Ø¨ Ú©ÛŒ Ú¯Ø¦ÛŒÛ”",
  error_no_target_skus_found:
    "Ù…Ù†ØªØ®Ø¨ ÙÙ„Ù¹Ø±Ø² Ú©Û’ Ù„ÛŒÛ’ Ú©ÙˆØ¦ÛŒ ÛØ¯Ù SKUs Ù†ÛÛŒÚº Ù…Ù„Û’Û”",
  error_party_group_type:
    "Ù¾Ø§Ø±Ù¹ÛŒ Ú©ÛŒ Ù‚Ø³Ù… Ù…Ù†ØªØ®Ø¨ Ú¯Ø±ÙˆÙ¾ Ø³Û’ Ù…Ù…Ø§Ø«Ù„ Ù†ÛÛŒÚº ÛÛ’Û”",
  error_record_in_use:
    "ÛŒÛ Ø±ÛŒÚ©Ø§Ø±Úˆ Ø¯ÙˆØ³Ø±Û’ ÚˆÛŒÙ¹Ø§ Ø³Û’ Ù…Ù†Ø³Ù„Ú© ÛÛ’ Ø§ÙˆØ± Ø§Ø³Û’ Ø­Ø°Ù Ù†ÛÛŒÚº Ú©ÛŒØ§ Ø¬Ø§ Ø³Ú©ØªØ§Û”",
  error_required_fields:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… ØªÙ…Ø§Ù… Ù…Ø·Ù„ÙˆØ¨Û ÙÛŒÙ„ÚˆØ² Ú©Ùˆ Ù¾ÙØ± Ú©Ø±ÛŒÚºÛ”",
  error_saving: "Ù…Ø­ÙÙˆØ¸ Ú©Ø±Ù†Û’ Ù…ÛŒÚº Ø®Ø±Ø§Ø¨ÛŒÛ”",
  error_select_article_type:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ù…Ø¶Ù…ÙˆÙ† Ú©ÛŒ Ù‚Ø³Ù… Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_select_branch: "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ø§ÛŒÚ© Ø¨Ø±Ø§Ù†Ú† Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_select_city: "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ø´ÛØ± Ú©Ø§ Ø§Ù†ØªØ®Ø§Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_select_commission_basis:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ú©Ù…ÛŒØ´Ù† Ú©ÛŒ Ø¨Ù†ÛŒØ§Ø¯ Ù¾Ø± Ø§Ù†ØªØ®Ø§Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_select_department:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ø§ÛŒÚ© Ø´Ø¹Ø¨Û Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_select_group:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ø§ÛŒÚ© Ù¾Ø±ÙˆÚˆÚ©Ù¹ Ú¯Ø±ÙˆÙ¾ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_select_labour: "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ø§ÛŒÚ© Ù„ÛŒØ¨Ø± Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_select_party_group:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ù¾Ø§Ø±Ù¹ÛŒ Ú¯Ø±ÙˆÙ¾ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_select_phone:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ú©Ù… Ø§Ø² Ú©Ù… Ø§ÛŒÚ© ÙÙˆÙ† Ù†Ù…Ø¨Ø± Ø¯Ø±Ø¬ Ú©Ø±ÛŒÚºÛ”",
  error_select_rate_type:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ø´Ø±Ø­ Ú©ÛŒ Ù‚Ø³Ù… Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_select_sku:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ø§ÛŒÚ© Ù…Ø¶Ù…ÙˆÙ† (SKU) Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_select_subgroup:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ø§ÛŒÚ© Ù¾Ø±ÙˆÚˆÚ©Ù¹ Ø°ÛŒÙ„ÛŒ Ú¯Ø±ÙˆÙ¾ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_select_vendor_capabilities:
    "Ø¨Ø±Ø§Û Ú©Ø±Ù… Ø³Ù¾Ù„Ø§Ø¦Ø± Ú©Û’ Ù„ÛŒÛ’ Ú©Ù… Ø§Ø² Ú©Ù… Ø§ÛŒÚ© ÙˆÛŒÙ†ÚˆØ± Ú©ÛŒ Ø§ÛÙ„ÛŒØª Ú©Ø§ Ø§Ù†ØªØ®Ø§Ø¨ Ú©Ø±ÛŒÚºÛ”",
  error_unable_save: "Ù…Ø­ÙÙˆØ¸ Ú©Ø±Ù†Û’ Ø³Û’ Ù‚Ø§ØµØ±Û”",
  error_unit_code_locked:
    "ÛŒÙˆÙ†Ù¹ Ú©ÙˆÚˆ Ú©Ùˆ ØªØ¨Ø¯ÛŒÙ„ Ù†ÛÛŒÚº Ú©ÛŒØ§ Ø¬Ø§ Ø³Ú©ØªØ§Û”",
  error_update_status: "Ø§Ø³Ù¹ÛŒÙ¹Ø³ Ú©Ùˆ Ø§Ù¾ ÚˆÛŒÙ¹ Ú©Ø±Ù†Û’ Ø³Û’ Ù‚Ø§ØµØ±Û”",
  exclude: "Ø®Ø§Ø±Ø¬ Ú©Ø±Ù†Ø§",
  expand: "Ù¾Ú¾ÛŒÙ„Ø§Ø¦ÛŒÚºÛ”",
  expanded: "ØªÙˆØ³ÛŒØ¹ Ø´Ø¯Û",
  expected_return_date: "Ù…ØªÙˆÙ‚Ø¹ ÙˆØ§Ù¾Ø³ÛŒ Ú©ÛŒ ØªØ§Ø±ÛŒØ®",
  expense_analysis: "Ø§Ø®Ø±Ø§Ø¬Ø§Øª Ú©Û’ ØªØ¬Ø²ÛŒÛ Ú©ÛŒ Ø±Ù¾ÙˆØ±Ù¹",
  expense_breakdown: "Ø§Ø®Ø±Ø§Ø¬Ø§Øª Ú©ÛŒ Ø®Ø±Ø§Ø¨ÛŒÛ”",
  expense_credit_dominant_warning:
    "Ú©Ú†Ú¾ Ø§Ø¯ÙˆØ§Ø± Ø®Ø§Ù„Øµ Ø§Ù„Ù¹ Ù¾Ù„Ù¹ ÛÙˆØªÛ’ ÛÛŒÚº (Ú©Ø±ÛŒÚˆÙ¹ ÚˆÛŒØ¨Ù¹ Ø³Û’ Ø²ÛŒØ§Ø¯Û ÛÙˆØªÛ’ ÛÛŒÚº)Û”",
  expense_trends: "Ø§Ø®Ø±Ø§Ø¬Ø§Øª Ú©Û’ Ø±Ø¬Ø­Ø§Ù†Ø§Øª Ú©ÛŒ Ø±Ù¾ÙˆØ±Ù¹",
  extra_discount: "Ø§Ø¶Ø§ÙÛŒ Ø±Ø¹Ø§ÛŒØª",
  factor: "Ø¹Ø§Ù…Ù„",
  field_required: "ÛŒÛ ÙÛŒÙ„Úˆ Ø¯Ø±Ú©Ø§Ø± ÛÛ’Û”",
  filter_primary: "Ù¾Ø±Ø§Ø¦Ù…Ø±ÛŒ ÙÙ„Ù¹Ø±",
  filter_secondary: "Ø«Ø§Ù†ÙˆÛŒ ÙÙ„Ù¹Ø±",
  filters: "ÙÙ„Ù¹Ø±Ø²",
  final_amount: "Ø­ØªÙ…ÛŒ Ø±Ù‚Ù…",
  financial_reports: "Ù…Ø§Ù„ÛŒØ§ØªÛŒ Ø±Ù¾ÙˆØ±Ù¹Ø³",
  finished: "Ø®ØªÙ…",
  finished_description:
    "ØªÛŒØ§Ø± Ø³Ø§Ù…Ø§Ù† Ú©ÛŒ Ø§Ø´ÛŒØ§Ø¡ Ø§ÙˆØ± Ø§Ù† Ú©ÛŒ Ù…Ø®ØªÙ„Ù Ø­Ø§Ù„ØªÙˆÚº Ú©Ø§ Ù†Ø¸Ù… Ú©Ø±ÛŒÚºÛ”",
  finished_goods: "ØªÛŒØ§Ø± Ø³Ø§Ù…Ø§Ù†",
  finished_setup_note:
    "ØªÛŒØ§Ø± Ø§Ø´ÛŒØ§Ø¡ Ú©Û’ Ù„ÛŒÛ’ Ø³Ø§Ø¦Ø² Ø§ÙˆØ± Ù…Ø®ØªÙ„Ù Ø³ÛŒÙ¹ Ø§Ù¾ ØªØ±ØªÛŒØ¨ Ø¯ÛŒÚºÛ”",
  frequency: "ØªØ¹Ø¯Ø¯",
  frequency_daily: "Ø±ÙˆØ²Ø§Ù†Û",
  frequency_monthly: "Ù…Ø§ÛØ§Ù†Û",
  from_unit: "ÛŒÙˆÙ†Ù¹ Ø³Û’",
  gate_pass: "Ú¯ÛŒÙ¹ Ù¾Ø§Ø³",
  general_purchase: "Ø¹Ø§Ù… Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ",
  general_purchase_description:
    "Ú©ÛŒØ´ ÛŒØ§ Ú©Ø±ÛŒÚˆÙ¹ Ú©Û’ Ù„ÛŒÛ’ Ø³Ù¾Ù„Ø§Ø¦Ø± Ø§Ù†ÙˆØ§Ø¦Ø³ Ø±ÛŒÚ©Ø§Ø±Úˆ Ú©Ø±ÛŒÚº Ø§ÙˆØ± Ø®ÙˆØ¯Ú©Ø§Ø± Ø­ÙˆØ§Ù„Û Ø§ÙˆÙ¾Ù† GRNsÛ”",
  general_purchase_voucher: "Ø¹Ø§Ù… Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ ÙˆØ§Ø¤Ú†Ø±",
  generated_combinations: "Ù¾ÛŒØ¯Ø§ Ú©Ø±Ø¯Û Ø§Ù…ØªØ²Ø§Ø¬",
  generic_error: "Ø®Ø±Ø§Ø¨ÛŒ",
  goods_receipt_note: "Ø³Ø§Ù…Ø§Ù† Ú©ÛŒ Ø±Ø³ÛŒØ¯ Ú©Ø§ Ù†ÙˆÙ¹",
  goods_receipt_note_description:
    "Ø¬Ø¨ Ø±ÛŒÙ¹Ø³ Ø§Ø¨Ú¾ÛŒ Ø·Û’ Ù†ÛÛŒÚº ÛÙˆØ¦Û’ ÛÛŒÚº ØªÙˆ Ø±ÛŒÚ©Ø§Ø±Úˆ Ø®Ø§Ù… Ù…Ø§Ù„ Ú©ÛŒ Ù…Ù‚Ø¯Ø§Ø± Ù…ÙˆØµÙˆÙ„ ÛÙˆØ¦ÛŒ ÛÛ’Û”",
  goods_receipt_note_voucher: "Ø³Ø§Ù…Ø§Ù† Ú©ÛŒ Ø±Ø³ÛŒØ¯ Ù†ÙˆÙ¹ ÙˆØ§Ø¤Ú†Ø±",
  grade: "Ú¯Ø±ÛŒÚˆ",
  grades: "Ø¯Ø±Ø¬Ø§Øª",
  grand_total: "Ú¯Ø±ÛŒÙ†Úˆ Ù¹ÙˆÙ¹Ù„",
  grn_reference: "GRN Ø­ÙˆØ§Ù„Û",
  gross_expense: "Ù…Ø¬Ù…ÙˆØ¹ÛŒ Ø§Ø®Ø±Ø§Ø¬Ø§Øª",
  group: "Ú¯Ø±ÙˆÙ¾",
  group_header: "Ú¯Ø±ÙˆÙ¾ ÛÛŒÚˆØ±",
  groups: "Ú¯Ø±ÙˆÙ¾Ø³",
  groups_description:
    "Ù¾Ø±ÙˆÚˆÚ©Ù¹Ø³ØŒ Ù¾Ø§Ø±Ù¹ÛŒÙˆÚºØŒ Ø§Ú©Ø§Ø¤Ù†Ù¹Ø³ Ø§ÙˆØ± Ù…Ø­Ú©Ù…ÙˆÚº Ù…ÛŒÚº Ø§Ø³ØªØ¹Ù…Ø§Ù„ ÛÙˆÙ†Û’ ÙˆØ§Ù„Û’ Ú¯Ø±ÙˆÙ¾Ø³ Ú©Ø§ Ù†Ø¸Ù… Ú©Ø±ÛŒÚºÛ”",
  help_posting_class:
    "Ù¾ÙˆØ³Ù¹Ù†Ú¯ Ø±ÙˆÛŒÛ’ Ú©Û’ Ù„ÛŒÛ’ Ø§Ø®ØªÛŒØ§Ø±ÛŒ Ø¯Ø±Ø¬Û Ø¨Ù†Ø¯ÛŒ Ú©Ø§ Ø§Ø³ØªØ¹Ù…Ø§Ù„ Ú©ÛŒØ§ Ø¬Ø§ØªØ§ ÛÛ’ (Ù…Ø«Ø§Ù„ Ú©Û’ Ø·ÙˆØ± Ù¾Ø±ØŒ Ø¨ÛŒÙ†Ú©)Û”",
  help_unit_code:
    "Ø³Ø³Ù¹Ù… Ú©Û’ Ø°Ø±ÛŒØ¹Û’ Ø§Ø³ØªØ¹Ù…Ø§Ù„ ÛÙˆÙ†Û’ ÙˆØ§Ù„ÛŒ Ù…Ø®ØªØµØ± Ù…Ù†ÙØ±Ø¯ Ú©Ù„ÛŒØ¯ (Ø¬ÛŒØ³Û’ØŒ PCSØŒ KG)Û”",
  help_unit_name:
    "ÙˆØ¶Ø§Ø­ØªÛŒ Ù†Ø§Ù… Ø±Ù¾ÙˆØ±Ù¹ÙˆÚº Ø§ÙˆØ± Ø¯Ø³ØªØ§ÙˆÛŒØ²Ø§Øª Ù¾Ø± Ø¯Ú©Ú¾Ø§ÛŒØ§ Ú¯ÛŒØ§ ÛÛ’Û”",
  highest_bill: "Ø³Ø¨ Ø³Û’ Ø²ÛŒØ§Ø¯Û Ø¨Ù„",
  highest_bucket: "Ú†ÙˆÙ¹ÛŒ Ú©Û’ Ø§Ø®Ø±Ø§Ø¬Ø§Øª Ú©ÛŒ Ù…Ø¯Øª",
  home_branch: "ÛÙˆÙ… Ø¨Ø±Ø§Ù†Ú†",
  hr_screen_description:
    "Ø§Ø³ÛŒ ÛŒÙˆÙ†ÛŒÙˆØ±Ø³Ù„ ÙˆØ±Ú© ÙÙ„Ùˆ Ø§ÙˆØ± Ù…Ù†Ø¸ÙˆØ±ÛŒÙˆÚº Ú©Ø§ Ø§Ø³ØªØ¹Ù…Ø§Ù„ Ú©Ø±ØªÛ’ ÛÙˆØ¦Û’ HR Ø§ÙˆØ± Ù¾Û’ Ø±ÙˆÙ„ Ø³ÛŒÙ¹ Ø§Ù¾ Ú©Ø§ Ù†Ø¸Ù… Ú©Ø±ÛŒÚºÛ”",
  hr_screen_planned_note:
    "ÛŒÛ Ø§Ø³Ú©Ø±ÛŒÙ† Ú©Ø§ Ø±Ø§Ø³ØªÛ ÙØ¹Ø§Ù„ ÛÛ’ Ø§ÙˆØ± Ø§Ø¬Ø§Ø²ØªÙˆÚº Ø³Û’ Ù…Ù†Ø³Ù„Ú© ÛÛ’Û”",
  id: "ID",
  impact: "Ø§Ø«Ø±",
  inactive: "ØºÛŒØ± ÙØ¹Ø§Ù„",
  include: "Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚºÛ”",
  include_na: "N/A Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚºÛ”",
  include_non_department_postings:
    "ØºÛŒØ± Ù…Ø­Ú©Ù…Ø§Ù†Û Ù¾ÙˆØ³Ù¹Ù†Ú¯ Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚº (N/A)",
  include_non_department_postings_hint:
    "Ø§Ù† Ù„Ø§Ø¦Ù†ÙˆÚº Ù¾Ø± Ù…Ø´ØªÙ…Ù„ ÛÛ’ Ø¬ÛØ§Úº Ù…Ø­Ú©Ù…Û Ù„Ø§Ú¯Ùˆ Ù†ÛÛŒÚº ÛÛ’ (Ù†Ù‚Ø¯/Ø¨ÛŒÙ†Ú©/ Ø§ÛŒÚˆÙˆØ§Ù†Ø³Ø²/ Ù¹Ø±Ø§Ù†Ø³ÙØ±Ø²)Û”",
  incorrect_credentials: "ØºÙ„Ø· ØµØ§Ø±Ù Ù†Ø§Ù… ÛŒØ§ Ù¾Ø§Ø³ ÙˆØ±ÚˆÛ”",
  inventory_reports: "Ø§Ù†ÙˆÛŒÙ†Ù¹Ø±ÛŒ Ø±Ù¾ÙˆØ±Ù¹Ø³",
  inventory_voucher: "Ø§Ù†ÙˆÛŒÙ†Ù¹Ø±ÛŒ ÙˆØ§Ø¤Ú†Ø±",
  item_name: "Ø¢Ø¦Ù¹Ù… Ú©Ø§ Ù†Ø§Ù…",
  item_selector: "Ø¢Ø¦Ù¹Ù… Ø³Ù„ÛŒÚ©Ù¹Ø±",
  item_type: "Ø¢Ø¦Ù¹Ù… Ú©ÛŒ Ù‚Ø³Ù…",
  items_label: "Ø§Ø´ÛŒØ§Ø¡",
  journal_type: "Ø¬Ø±Ù†Ù„ Ú©ÛŒ Ù‚Ø³Ù…",
  journal_voucher: "Ø¬Ø±Ù†Ù„ ÙˆØ§Ø¤Ú†Ø±",
  journal_voucher_description:
    "Ø¬Ù…Ø¹ØŒ Ø§ÛŒÚˆØ¬Ø³Ù¹Ù…Ù†Ù¹ØŒ Ø§ÙˆØ± Ø¨Ù†Ø¯ Ø§Ù†Ø¯Ø±Ø§Ø¬Ø§Øª Ú©Û’ Ù„ÛŒÛ’ Ù…ØªÙˆØ§Ø²Ù† Ø¬Ø±Ù†Ù„ ÙˆØ§Ø¤Ú†Ø±Ø² Ø¨Ù†Ø§Ø¦ÛŒÚºÛ”",
  journal_voucher_register: "Ø¬Ø±Ù†Ù„ ÙˆØ§Ø¤Ú†Ø± Ø±Ø¬Ø³Ù¹Ø±",
  labours: "Ù„ÛŒØ¨Ø±Ø²",
  labours_description:
    "Ù¾ÛŒØ¯Ø§ÙˆØ§Ø± Ø§ÙˆØ± Ø§Ø¬Ø±Øª Ú©ÛŒ Ú©Ø§Ø±Ø±ÙˆØ§Ø¦ÛŒ Ú©Û’ Ù„ÛŒÛ’ Ù„ÛŒØ¨Ø± Ù…Ø§Ø³Ù¹Ø± Ø±ÛŒÚ©Ø§Ø±ÚˆØ² Ú©Ø§ Ù†Ø¸Ù… Ú©Ø±ÛŒÚºÛ”",
  last_30_days: "Ø¢Ø®Ø±ÛŒ 30 Ø¯Ù†",
  last_3_months: "Ù¾Ú†Ú¾Ù„Û’ 3 Ù…ÛÛŒÙ†Û’",
  last_7_days: "Ø¢Ø®Ø±ÛŒ 7 Ø¯Ù†",
  last_month: "Ù¾Ú†Ú¾Ù„Û’ Ù…ÛÛŒÙ†Û’",
  last_purchase_date: "Ø¢Ø®Ø±ÛŒ Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ Ú©ÛŒ ØªØ§Ø±ÛŒØ®",
  level: "Ø³Ø·Ø­",
  bom_stage: "Ù…Ø±Ø­Ù„Û",
  level_account: "Ø§Ú©Ø§Ø¤Ù†Ù¹ Ù„ÛŒÙˆÙ„",
  level_department: "ÚˆÛŒÙ¾Ø§Ø±Ù¹Ù…Ù†Ù¹ Ù„ÛŒÙˆÙ„",
  level_group: "Ú¯Ø±ÙˆÙ¾ Ù„ÛŒÙˆÙ„",
  line_count: "Ù„Ø§Ø¦Ù† Ø´Ù…Ø§Ø±",
  line_item: "Ù„Ø§Ø¦Ù† Ø¢Ø¦Ù¹Ù…",
  load_failed: "Ù…ÙˆØ§Ø¯ Ù„ÙˆÚˆ Ú©Ø±Ù†Û’ Ù…ÛŒÚº Ù†Ø§Ú©Ø§Ù…Û”",
  load_report_to_view:
    "ÙÙ„Ù¹Ø±Ø² Ú©Ùˆ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº Ø§ÙˆØ± Ø±Ù¾ÙˆØ±Ù¹ Ø¯ÛŒÚ©Ú¾Ù†Û’ Ú©Û’ Ù„ÛŒÛ’ Ù„ÙˆÚˆ Ù¾Ø± Ú©Ù„Ú© Ú©Ø±ÛŒÚºÛ”",
  load_skus: "SKUs Ù„ÙˆÚˆ Ú©Ø±ÛŒÚºÛ”",
  loading: "Ù„ÙˆÚˆ ÛÙˆ Ø±ÛØ§ ÛÛ’Û”",
  lock_posting: "Ù„Ø§Ú© Ù¾ÙˆØ³Ù¹Ù†Ú¯",
  login: "Ù„Ø§Ú¯ Ø§Ù†",
  login_failed: "Ù„Ø§Ú¯ Ø§Ù† Ù†Ø§Ú©Ø§Ù… ÛÙˆ Ú¯ÛŒØ§Û”",
  loose: "ÚˆÚ¾ÛŒÙ„Ø§",
  manage_company_locations:
    "Ø¨Ø±Ø§Ù†Ú† Ú©Û’ Ù…Ù‚Ø§Ù…Ø§Øª Ø§ÙˆØ± Ø¯Ø³ØªÛŒØ§Ø¨ÛŒ Ú©Ø§ Ù†Ø¸Ù… Ú©Ø±ÛŒÚºÛ”",
  manage_permissions: "Ø§Ø¬Ø§Ø²ØªÙˆÚº Ú©Ø§ Ù†Ø¸Ù… Ú©Ø±ÛŒÚºÛ”",
  material_capability: "Ù…ÙˆØ§Ø¯",
  min_stock: "Ú©Ù… Ø§Ø² Ú©Ù… Ø§Ø³Ù¹Ø§Ú©",
  modules: "Ù…Ø§ÚˆÛŒÙˆÙ„Ø²",
  monthly: "Ù…Ø§ÛØ§Ù†Û",
  monthly_short_range_daily_hint: "Ù¹Ø§Ø¦Ù… Ú¯Ø±Ø§Ù†ÙˆØ±Ù¹ÛŒ: Ù…Ø§ÛØ§Ù†ÛÛ”",
  name: "Ù†Ø§Ù…",
  name_ur: "Ù†Ø§Ù… (Ø§Ø±Ø¯Ùˆ)",
  net_expense: "Ø®Ø§Ù„Øµ Ø§Ø®Ø±Ø§Ø¬Ø§Øª",
  net_expense_previous_period: "Ø®Ø§Ù„Øµ Ø®Ø±Ú† (Ù¾Ú†Ú¾Ù„ÛŒ Ù…Ø¯Øª)",
  net_expense_this_period: "Ø®Ø§Ù„Øµ Ø®Ø±Ú† (Ø§Ø³ Ù…Ø¯Øª)",
  network_error: "Ù†ÛŒÙ¹ ÙˆØ±Ú© Ú©ÛŒ Ø®Ø±Ø§Ø¨ÛŒÛ”",
  new: "Ù†ÛŒØ§",
  new_combinations_found: "Ù†Ø¦Û’ Ø§Ù…ØªØ²Ø§Ø¬ Ù…Ù„Û’Û”",
  new_dozen_rate: "Ù†ÛŒØ§ Ø¯Ø±Ø¬Ù† Ø±ÛŒÙ¹",
  new_expense: "Ù†ÛŒØ§ Ø®Ø±Ú†Û",
  new_rate: "Ù†ÛŒØ§ Ø±ÛŒÙ¹",
  new_value: "Ù†Ø¦ÛŒ Ù‚Ø¯Ø±",
  no: "Ù†ÛÛŒÚº",
  no_data: "Ú©ÙˆØ¦ÛŒ ÚˆÛŒÙ¹Ø§ Ù†ÛÛŒÚº Ù…Ù„Ø§Û”",
  no_data_for_selected_period:
    "Ù…Ù†ØªØ®Ø¨ Ù…Ø¯Øª Ú©Û’ Ù„ÛŒÛ’ Ø§Ø®Ø±Ø§Ø¬Ø§Øª Ú©Û’ Ø§Ù†Ø¯Ø±Ø§Ø¬Ø§Øª Ù†ÛÛŒÚº Ù…Ù„Û’Û”",
  no_entries: "Ø§Ø¨Ú¾ÛŒ ØªÚ© Ú©ÙˆØ¦ÛŒ Ø§Ù†Ø¯Ø±Ø§Ø¬ Ù†ÛÛŒÚº ÛÛ’Û”",
  no_labours_found_for_department:
    "Ù…Ù†ØªØ®Ø¨ Ù…Ø­Ú©Ù…Û Ú©Û’ Ù„ÛŒÛ’ Ú©ÙˆØ¦ÛŒ ÙØ¹Ø§Ù„ Ù…Ø²Ø¯ÙˆØ± Ù†ÛÛŒÚº Ù…Ù„Ø§Û”",
  no_navigate_access_message:
    "Ø±ÛŒÚ©Ø§Ø±ÚˆØ² Ù¾ÙˆØ´ÛŒØ¯Û ÛÛŒÚº Ú©ÛŒÙˆÙ†Ú©Û Ø¢Ù¾ Ú©Ùˆ Ù†ÛŒÙˆÛŒÚ¯ÛŒØ´Ù† ØªÚ© Ø±Ø³Ø§Ø¦ÛŒ Ù†ÛÛŒÚº ÛÛ’Û”",
  no_new_combinations:
    "ØªÙ…Ø§Ù… Ù…Ù†ØªØ®Ø¨ Ú©Ø±Ø¯Û Ø§Ù…ØªØ²Ø§Ø¬ Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛŒÚºÛ”",
  no_records_found: "Ú©ÙˆØ¦ÛŒ Ø±ÛŒÚ©Ø§Ø±Úˆ Ù†ÛÛŒÚº Ù…Ù„Ø§",
  non_production_expense:
    "ØºÛŒØ± Ù¾ÛŒØ¯Ø§ÙˆØ§Ø±ÛŒ Ø§Ø®Ø±Ø§Ø¬Ø§Øª Ú©Ø§ ØªØ¬Ø²ÛŒÛ",
  note: "Ù†ÙˆÙ¹",
  of: "Ú©ÛŒ",
  ok: "Ù¹Ú¾ÛŒÚ© ÛÛ’",
  old_rate: "Ù¾Ø±Ø§Ù†Ø§ Ø±ÛŒÙ¹",
  old_value: "Ù¾Ø±Ø§Ù†ÛŒ Ù‚Ø¯Ø±",
  one_color: "Ø§ÛŒÚ© Ø±Ù†Ú¯",
  one_size: "Ø§ÛŒÚ© Ø³Ø§Ø¦Ø²",
  open: "Ú©Ú¾ÙˆÙ„ÛŒÚºÛ”",
  open_qty: "Ú©Ú¾ÙˆÙ„ÛŒÚº Ù…Ù‚Ø¯Ø§Ø±",
  opening_balance: "Ø§ÙˆÙ¾Ù†Ù†Ú¯ Ø¨ÛŒÙ„Ù†Ø³",
  order_by: "Ø¢Ø±ÚˆØ± Ø¨Ø°Ø±ÛŒØ¹Û",
  others: "Ø¯ÙˆØ³Ø±Û’",
  our_delivery: "ÛÙ…Ø§Ø±ÛŒ ÚˆÛŒÙ„ÛŒÙˆØ±ÛŒ",
  overridden: "Ø§ÙˆÙˆØ± Ø±Ø§Ø¦Úˆ",
  override_mode_active: "Ø§ÙˆÙˆØ± Ø±Ø§Ø¦ÛŒÚˆ Ù…ÙˆÚˆ ÙØ¹Ø§Ù„ ÛÛ’Û”",
  packed: "Ù¾ÛŒÚ©",
  packing: "Ù¾ÛŒÚ©Ù†Ú¯",
  packing_type: "Ù¾ÛŒÚ©Ù†Ú¯ Ú©ÛŒ Ù‚Ø³Ù…",
  packing_types: "Ù¾ÛŒÚ©Ù†Ú¯ Ú©ÛŒ Ø§Ù‚Ø³Ø§Ù…",
  pair_discount: "Ø¬ÙˆÚ‘ÛŒ ÚˆØ³Ú©Ø§Ø¤Ù†Ù¹",
  pair_rate: "Ø¬ÙˆÚ‘ÛŒ Ú©ÛŒ Ø´Ø±Ø­",
  pairs: "Ø¬ÙˆÚ‘Û’",
  parties: "Ù¾Ø§Ø±Ù¹ÛŒØ§Úº",
  parties_label: "Ù¾Ø§Ø±Ù¹ÛŒØ§Úº",
  party_code: "Ù¾Ø§Ø±Ù¹ÛŒ Ú©ÙˆÚˆ",
  party_group: "Ù¾Ø§Ø±Ù¹ÛŒ Ú¯Ø±ÙˆÙ¾",
  party_groups: "Ù¾Ø§Ø±Ù¹ÛŒ Ú¯Ø±ÙˆÙ¾Ø³",
  party_groups_description:
    "ØµØ§Ø±ÙÛŒÙ† Ø§ÙˆØ± Ø³Ù¾Ù„Ø§Ø¦Ø±Ø² Ú©Ùˆ ØªÙ‚Ø³ÛŒÙ… Ú©Ø±ÛŒÚºÛ”",
  party_name: "Ù¾Ø§Ø±Ù¹ÛŒ Ú©Ø§ Ù†Ø§Ù…",
  party_type: "Ù¾Ø§Ø±Ù¹ÛŒ Ú©ÛŒ Ù‚Ø³Ù…",
  password: "Ù¾Ø§Ø³ ÙˆØ±Úˆ",
  payee: "Ø§Ø¯Ø§ Ú©Ø±Ù†Û’ ÙˆØ§Ù„Ø§",
  payment_due_date: "Ø§Ø¯Ø§Ø¦ÛŒÚ¯ÛŒ Ú©ÛŒ Ø¢Ø®Ø±ÛŒ ØªØ§Ø±ÛŒØ®",
  payroll_daily: "Ø±ÙˆØ²Ø§Ù†Û",
  payroll_monthly: "Ù…Ø§ÛØ§Ù†Û",
  payroll_multiple: "Ù…ØªØ¹Ø¯Ø¯",
  payroll_piece_rate: "Ù¾ÛŒØ³ Ø±ÛŒÙ¹",
  payroll_type: "Ù¾Û’ Ø±ÙˆÙ„ Ú©ÛŒ Ù‚Ø³Ù…",
  payroll_wage_balance:
    "Ù¾Û’ Ø±ÙˆÙ„ Ø§ÙˆØ± Ø§Ø¬Ø±Øª Ú©Û’ ØªÙˆØ§Ø²Ù† Ú©ÛŒ Ø±Ù¾ÙˆØ±Ù¹",
  pending: "Ø²ÛŒØ± Ø§Ù„ØªÙˆØ§Ø¡",
  pending_delivery_qty: "Ø²ÛŒØ± Ø§Ù„ØªÙˆØ§Ø¡ ØªØ±Ø³ÛŒÙ„ Ú©ÛŒ Ù…Ù‚Ø¯Ø§Ø±",
  percent_of_department: "Ù…Ø­Ú©Ù…Û Ú©Ø§ %",
  percent_of_total: "Ú©Ù„ Ú©Ø§ %",
  period: "Ù…Ø¯Øª",
  permanent_delete: "Ù…Ø³ØªÙ‚Ù„ Ø­Ø°Ù Ú©Ø±ÛŒÚºÛ”",
  permanent_delete_message:
    "ÛŒÛ Ø¹Ù…Ù„ Ù…Ø³ØªÙ‚Ù„ Ø·ÙˆØ± Ù¾Ø± Ø±ÛŒÚ©Ø§Ø±Úˆ Ú©Ùˆ Ø­Ø°Ù Ú©Ø± Ø¯ÛŒØªØ§ ÛÛ’Û”",
  permissions_read_only_hint:
    "Ø¢Ù¾ Ú©Ùˆ Ø¯ÛŒÚ©Ú¾Ù†Û’ Ú©ÛŒ Ø§Ø¬Ø§Ø²Øª ØªÚ© Ø±Ø³Ø§Ø¦ÛŒ Ø­Ø§ØµÙ„ ÛÛ’ØŒ Ù„ÛŒÚ©Ù† Ø¢Ù¾ Ø§Ù† Ù…ÛŒÚº ØªØ±Ù…ÛŒÙ… Ù†ÛÛŒÚº Ú©Ø± Ø³Ú©ØªÛ’Û”",
  permissions_subtitle:
    "ØµØ§Ø±Ù Ø§ÙˆØ± Ú©Ø±Ø¯Ø§Ø± ØªÚ© Ø±Ø³Ø§Ø¦ÛŒ Ú©ÛŒ Ø³Ø·Ø­ÙˆÚº Ú©Ø§ Ù†Ø¸Ù… Ú©Ø±ÛŒÚºÛ”",
  permissions_tip_approve:
    "Ø±ÛŒÚ©Ø§Ø±Úˆ Ú©ÛŒ Ø­ÛŒØ«ÛŒØª Ú©Ùˆ Ø­ØªÙ…ÛŒ Ø´Ú©Ù„ Ø¯ÛŒÙ†Û’ Ú©Ø§ Ø§Ø®ØªÛŒØ§Ø± Ø¯ÛŒØªØ§ ÛÛ’Û”",
  permissions_tip_create:
    "Ù†Ø¦ÛŒ Ø§Ù†Ø¯Ø±Ø§Ø¬Ø§Øª Ú©Ùˆ Ù…Ø­ÙÙˆØ¸ Ú©Ø±Ù†Û’ Ú©Û’ Ù„ÛŒÛ’ Ù†ÛŒØ§ ÙØ§Ø±Ù… Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚº Ú©Ùˆ ÙØ¹Ø§Ù„ Ú©Ø±ØªØ§ ÛÛ’Û”",
  permissions_tip_deactivate:
    "Ø±ÛŒÚ©Ø§Ø±ÚˆØ² Ú©Ùˆ ØºÛŒØ± ÙØ¹Ø§Ù„ Ú©Ø±Ù†Û’ Ú©Û’ Ø§Ø®ØªÛŒØ§Ø± Ú©Ùˆ ÙØ¹Ø§Ù„ Ú©Ø±ØªØ§ ÛÛ’Û”",
  permissions_tip_delete:
    "Ù…Ø³ØªÙ‚Ù„ Ø·ÙˆØ± Ù¾Ø± Ø±ÛŒÚ©Ø§Ø±Úˆ Ú©Ùˆ ÛÙ¹Ø§ØªØ§ ÛÛ’Û”",
  permissions_tip_download:
    "ÚˆØ§Ø¤Ù† Ù„ÙˆÚˆ Ø§ÙˆØ± Ø§ÛŒÚ©Ø³Ù¾ÙˆØ±Ù¹ Ø¨Ù¹Ù† Ú©Ùˆ ÙØ¹Ø§Ù„ Ú©Ø±ØªØ§ ÛÛ’Û”",
  permissions_tip_edit:
    "Ù…ÙˆØ¬ÙˆØ¯Û Ø±ÛŒÚ©Ø§Ø±ÚˆØ² Ù…ÛŒÚº ÚˆÛŒÙ¹Ø§ Ú©Ùˆ ØªØ¨Ø¯ÛŒÙ„ Ú©Ø±Ù†Û’ Ú©ÛŒ ØµÙ„Ø§Ø­ÛŒØª Ú©Ùˆ ØºÛŒØ± Ù…Ù‚ÙÙ„ Ú©Ø±ØªØ§ ÛÛ’Û”",
  permissions_tip_navigate:
    "Ø§Ø³ Ø§Ø³Ú©Ø±ÛŒÙ† Ù…ÛŒÚº Ù…ÙˆØ¬ÙˆØ¯Û Ø±ÛŒÚ©Ø§Ø±ÚˆØ² Ú©ÛŒ ÙÛØ±Ø³Øª Ø¨Ù†Ø§Ù†Û’ Ú©ÛŒ Ø§Ø¬Ø§Ø²Øª Ø¯ÛŒØªØ§ ÛÛ’Û”",
  permissions_tip_view:
    "Ø§Ø³ Ù…Ø§ÚˆÛŒÙˆÙ„ Ú©Ùˆ Ú©Ú¾ÙˆÙ„Ù†Û’ Ú©ÛŒ Ø§Ø¬Ø§Ø²Øª Ø¯ÛŒØªØ§ ÛÛ’Û”",
  phone_1: "ÙÙˆÙ† 1",
  phone_2: "ÙÙˆÙ† 2",
  phone_number: "ÙÙˆÙ† Ù†Ù…Ø¨Ø±",
  phone_primary: "ÙÙˆÙ† (Ø¨Ù†ÛŒØ§Ø¯ÛŒ)",
  phone_secondary: "ÙÙˆÙ† (Ø«Ø§Ù†ÙˆÛŒ)",
  placeholder_allowance_type: "Ú¯Ú¾Ø±ØŒ Ù†Ù‚Ù„ Ùˆ Ø­Ù…Ù„ØŒ Ù…ÙˆØ¨Ø§Ø¦Ù„",
  placeholder_designation_role: "Ø³ÛŒÙ„Ø² Ø¢ÙÛŒØ³Ø±",
  placeholder_employee_code: "EMP-001",
  placeholder_employee_name: "Ø¹Ù„ÛŒ Ø±Ø¶Ø§",
  placeholder_labour_code: "LAB-001",
  placeholder_labour_name: "Ø±ÙÛŒÙ‚",
  placeholder_raw_material_name: "Ø¬ÛŒØ³Û’",
  placeholder_raw_material_name_ur: "Ø¬ÛŒØ³Û’",
  popup_blocked_new_tab: "Ù¾Ø§Ù¾ Ø§Ù¾ Ù…Ø³Ø¯ÙˆØ¯ ÛÛ’Û”",
  post: "Ù¾ÙˆØ³Ù¹",
  posting_class: "Ù¾ÙˆØ³Ù¹Ù†Ú¯ Ú©Ù„Ø§Ø³",
  previous_balance: "Ù¾Ú†Ú¾Ù„Ø§ Ø¨ÛŒÙ„Ù†Ø³",
  previous_dozen_rate: "Ù¾Ú†Ú¾Ù„Ø§ Ø¯Ø±Ø¬Ù† Ø±ÛŒÙ¹",
  previous_period: "Ù¾Ú†Ú¾Ù„Ø§ Ø¯ÙˆØ±",
  previous_period_total: "Ù¾Ú†Ú¾Ù„ÛŒ Ù…Ø¯Øª Ú©Ø§ Ú©Ù„",
  previous_rate: "Ù¾Ú†Ú¾Ù„Ø§ Ø±ÛŒÙ¹",
  primary_customer_name: "Ø¨Ù†ÛŒØ§Ø¯ÛŒ Ú¯Ø§ÛÚ© Ú©Ø§ Ù†Ø§Ù…",
  print_gate_pass: "Ú¯ÛŒÙ¹ Ù¾Ø§Ø³ Ù¾Ø±Ù†Ù¹ Ú©Ø±ÛŒÚºÛ”",
  proceed_change: "ØªØ¨Ø¯ÛŒÙ„ÛŒ Ú©Û’ Ø³Ø§ØªÚ¾ Ø¢Ú¯Û’ Ø¨Ú‘Ú¾ÛŒÚºÛ”",
  product_group: "Ù¾Ø±ÙˆÚˆÚ©Ù¹ Ú¯Ø±ÙˆÙ¾",
  product_groups: "Ù¾Ø±ÙˆÚˆÚ©Ù¹ Ú¯Ø±ÙˆÙ¾Ø³",
  product_groups_bought: "Ù¾Ø±ÙˆÚˆÚ©Ù¹ Ú¯Ø±ÙˆÙ¾Ø³ Ø®Ø±ÛŒØ¯Û’ Ú¯Ø¦Û’Û”",
  product_groups_description:
    "RM/SFG/FG Ù…Ø±Ø¦ÛŒØª Ú¯Ø±ÙˆÙ¾Ø³ Ú©ÛŒ ÙˆØ¶Ø§Ø­Øª Ú©Ø±ÛŒÚºÛ”",
  product_scope: "Ù¾Ø±ÙˆÚˆÚ©Ù¹ Ú©Ø§ Ø¯Ø§Ø¦Ø±Û Ú©Ø§Ø±",
  product_subgroups: "Ù¾Ø±ÙˆÚˆÚ©Ù¹ Ú©Û’ Ø°ÛŒÙ„ÛŒ Ú¯Ø±ÙˆÙ¾Ø³",
  product_types: "Ù…ØµÙ†ÙˆØ¹Ø§Øª Ú©ÛŒ Ø§Ù‚Ø³Ø§Ù…",
  production_category: "Ù¾ÛŒØ¯Ø§ÙˆØ§Ø± Ú©Ø§ Ø²Ù…Ø±Û",
  production_category_finished: "Ø®ØªÙ…",
  production_category_semi_finished: "Ù†ÛŒÙ… ØªÛŒØ§Ø±",
  production_overhead: "Ù¾Ø±ÙˆÚˆÚ©Ø´Ù† Ø§ÙˆÙˆØ± ÛÛŒÚˆ Ù„Ø§Ú¯Øª Ú©Ø§ ØªØ¬Ø²ÛŒÛ",
  production_reports: "Ù¾ÛŒØ¯Ø§ÙˆØ§Ø±ÛŒ Ø±Ù¾ÙˆØ±Ù¹Ø³",
  select_department: "Ø´Ø¹Ø¨Û Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº",
  select_labour: "Ù„ÛŒØ¨Ø± Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº",
  select_sku: "SKU Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº",
  abnormal_loss_voucher: "ØºÛŒØ± Ù…Ø¹Ù…ÙˆÙ„ÛŒ Ù†Ù‚ØµØ§Ù† ÙˆÙˆÚ†Ø±",
  finished_production_voucher: "ÙÙ†Ø´Úˆ Ù¾Ø±ÙˆÚˆÚ©Ø´Ù† ÙˆÙˆÚ†Ø±",
  semi_finished_production_voucher: "Ø³ÛŒÙ…ÛŒ ÙÙ†Ø´Úˆ Ù¾Ø±ÙˆÚˆÚ©Ø´Ù† ÙˆÙˆÚ†Ø±",
  department_completion_voucher: "ÚˆÛŒÙ¾Ø§Ø±Ù¹Ù…Ù†Ù¹ Ú©Ù…Ù¾Ù„ÛŒØ´Ù† ÙˆÙˆÚ†Ø±",
  consumption_voucher: "Ú©Ù†Ø²Ù…Ù¾Ø´Ù† ÙˆÙˆÚ†Ø±",
  labour_production_voucher: "Ù„ÛŒØ¨Ø± Ù¾Ø±ÙˆÚˆÚ©Ø´Ù† ÙˆÙˆÚ†Ø±",
  production_planning_voucher: "Ù¾Ø±ÙˆÚˆÚ©Ø´Ù† Ù¾Ù„Ø§Ù†Ù†Ú¯ ÙˆÙˆÚ†Ø±",
  finished_production_voucher_description:
    "ÙÙ†Ø´Úˆ Ù¾Ø±ÙˆÚˆÚ©Ø´Ù† Ø±ÛŒÚ©Ø§Ø±Úˆ Ú©Ø±ÛŒÚº Ø§ÙˆØ± Ù…ØªØ¹Ù„Ù‚Û Ú©Ù†Ø²Ù…Ù¾Ø´Ù† Ø§ÙˆØ± Ù„ÛŒØ¨Ø± ÙˆÙˆÚ†Ø±Ø² Ø®ÙˆØ¯Ú©Ø§Ø± Ø¨Ù†Ø§Ø¦ÛŒÚºÛ”",
  semi_finished_production_voucher_description:
    "Ø³ÛŒÙ…ÛŒ ÙÙ†Ø´Úˆ Ù¾Ø±ÙˆÚˆÚ©Ø´Ù† Ø±ÛŒÚ©Ø§Ø±Úˆ Ú©Ø±ÛŒÚº Ø§ÙˆØ± Ù…ØªØ¹Ù„Ù‚Û Ú©Ù†Ø²Ù…Ù¾Ø´Ù† Ø§ÙˆØ± Ù„ÛŒØ¨Ø± ÙˆÙˆÚ†Ø±Ø² Ø®ÙˆØ¯Ú©Ø§Ø± Ø¨Ù†Ø§Ø¦ÛŒÚºÛ”",
  department_completion_voucher_description:
    "ÚˆÛŒÙ¾Ø§Ø±Ù¹Ù…Ù†Ù¹ Ú©ÛŒ Ù…Ú©Ù…Ù„ Ø´Ø¯Û Ù…Ù‚Ø¯Ø§Ø± Ø±ÛŒÚ©Ø§Ø±Úˆ Ú©Ø±ÛŒÚº Ø§ÙˆØ± WIP Ù¾ÙˆÙ„ Ù…ÛŒÚº Ø´Ø§Ù…Ù„ Ú©Ø±ÛŒÚºÛ”",
  consumption_voucher_description:
    "Ù…Ù†Ø¸ÙˆØ± Ø´Ø¯Û Ù¾Ø±ÙˆÚˆÚ©Ø´Ù† ÙˆÙˆÚ†Ø±Ø² Ø³Û’ Ù…Ù†Ø³Ù„Ú© Ø®ÙˆØ¯Ú©Ø§Ø± Ú©Ù†Ø²Ù…Ù¾Ø´Ù† ÙˆÙˆÚ†Ø±Û”",
  labour_production_voucher_description:
    "Ù…Ù†Ø¸ÙˆØ± Ø´Ø¯Û Ù¾Ø±ÙˆÚˆÚ©Ø´Ù† ÙˆÙˆÚ†Ø±Ø² Ø³Û’ Ù…Ù†Ø³Ù„Ú© Ø®ÙˆØ¯Ú©Ø§Ø± Ù„ÛŒØ¨Ø± ÙˆÙˆÚ†Ø±Û”",
  production_planning_voucher_description:
    "Ù…Ø³ØªÙ‚Ø¨Ù„ Ú©ÛŒ Ù¾Ø±ÙˆÚˆÚ©Ø´Ù† Ù…Ù‚Ø¯Ø§Ø± Ú©ÛŒ Ù…Ù†ØµÙˆØ¨Û Ø¨Ù†Ø¯ÛŒ Ú©Ø±ÛŒÚºØŒ Ú©Ù†Ø²Ù…Ù¾Ø´Ù† ÛŒØ§ Ù„ÛŒØ¨Ø± Ù¾ÙˆØ³Ù¹Ù†Ú¯ Ú©Û’ Ø¨ØºÛŒØ±Û”",
  loss_type: "Ù†Ù‚ØµØ§Ù† Ú©ÛŒ Ù‚Ø³Ù…",
  plan_kind: "Ù¾Ù„Ø§Ù† Ú©ÛŒ Ù‚Ø³Ù…",
  voucher_lines_required: "ÙˆÙˆÚ†Ø± Ù„Ø§Ø¦Ù†Ø² Ù„Ø§Ø²Ù…ÛŒ ÛÛŒÚºÛ”",
  is_required: "Ù„Ø§Ø²Ù…ÛŒ ÛÛ’",
  must_be_positive: "ØµÙØ± Ø³Û’ Ø¨Ú‘Ø§ ÛÙˆÙ†Ø§ Ø¶Ø±ÙˆØ±ÛŒ ÛÛ’",
  products: "Ù…ØµÙ†ÙˆØ¹Ø§Øª",
  profit_and_loss: "Ù…Ù†Ø§ÙØ¹ Ø§ÙˆØ± Ù†Ù‚ØµØ§Ù† Ú©Ø§ Ø¨ÛŒØ§Ù†",
  profitability_analysis: "Ù…Ù†Ø§ÙØ¹ Ø¨Ø®Ø´ ØªØ¬Ø²ÛŒÛ Ø±Ù¾ÙˆØ±Ù¹",
  purchase_invoice: "Ø¹Ø§Ù… Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ",
  purchase_order: "Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ Ú©Ø§ Ø¢Ø±ÚˆØ±",
  purchase_rate: "Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ Ú©ÛŒ Ø´Ø±Ø­",
  purchase_reports: "Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ Ú©ÛŒ Ø±Ù¾ÙˆØ±Ù¹",
  purchase_return_description:
    "Ø±ÛŒÚ©Ø§Ø±Úˆ Ø³Ù¾Ù„Ø§Ø¦Ø± Ø§ÙˆØ± ÙˆØ¬Û Ú©Û’ Ø®Ù„Ø§Ù Ø®Ø§Ù… Ù…Ø§Ù„ ÙˆØ§Ù¾Ø³.",
  purchase_type: "Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ Ú©ÛŒ Ù‚Ø³Ù…",
  quantity: "Ù…Ù‚Ø¯Ø§Ø±",
  quick_ranges: "ÙÙˆØ±ÛŒ Ø­Ø¯ÙˆØ¯",
  rate_change_submitted:
    "Ø´Ø±Ø­ Ú©ÛŒ ØªØ¨Ø¯ÛŒÙ„ÛŒ Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©Û’ Ù„ÛŒÛ’ Ø¬Ù…Ø¹ Ú©Ø±Ø§Ø¦ÛŒ Ú¯Ø¦ÛŒÛ”",
  rate_type: "Ø´Ø±Ø­ Ú©ÛŒ Ù‚Ø³Ù…",
  rate_type_per_dozen: "ÙÛŒ Ø¯Ø±Ø¬Ù†",
  rate_type_per_pair: "ÙÛŒ Ø¬ÙˆÚ‘Ø§",
  rate_value: "Ø±ÛŒÙ¹ ÙˆÛŒÙ„ÛŒÙˆ",
  rates: "Ù†Ø±Ø®",
  raw_materials: "Ø®Ø§Ù… Ù…Ø§Ù„",
  raw_materials_description:
    "ÙÛŒ Ø±Ù†Ú¯ Ø®Ø±ÛŒØ¯Ø§Ø±ÛŒ Ú©ÛŒ Ø´Ø±Ø­ Ú©Û’ Ø³Ø§ØªÚ¾ Ø®Ø§Ù… Ù…Ø§Ù„ Ú©Ùˆ Ø¨Ø±Ù‚Ø±Ø§Ø± Ø±Ú©Ú¾ÛŒÚº.",
  raw_request_data: "Ø®Ø§Ù… Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ú©Ø§ ÚˆÛŒÙ¹Ø§",
  read_only: "ØµØ±Ù Ù¾Ú‘Ú¾Ù†Û’ Ú©Û’ Ù„ÛŒÛ’",
  receive_into_account: "Ø§Ø¯Ø§Ø¦ÛŒÚ¯ÛŒ Ù…ÙˆØµÙˆÙ„ ÛÙˆØ¦ÛŒ Ø§Ú©Ø§Ø¤Ù†Ù¹",
  received_quantity: "Ù…ÙˆØµÙˆÙ„ Ø´Ø¯Û Ù…Ù‚Ø¯Ø§Ø±",
  recent_vouchers: "Ø­Ø§Ù„ÛŒÛ ÙˆØ§Ø¤Ú†Ø±Ø²",
  ref_line: "Ø±ÛŒÙ Ù„Ø§Ø¦Ù†",
  reject: "Ø±Ø¯ Ú©Ø±Ù†Ø§",
  rejected: "Ù…Ø³ØªØ±Ø¯",
  remaining_amount: "Ø¨Ø§Ù‚ÛŒ Ø±Ù‚Ù…",
  remarks: "Ø±ÛŒÙ…Ø§Ø±Ú©Ø³",
  repair_capability: "Ù…Ø±Ù…Øª",
  report_not_configured_yet:
    "ÛŒÛ Ø±Ù¾ÙˆØ±Ù¹ Ø§Ø¨Ú¾ÛŒ ØªÚ© Ú©Ù†ÙÛŒÚ¯Ø± Ù†ÛÛŒÚº ÛÙˆØ¦ÛŒ ÛÛ’Û”",
  report_type: "Ø±Ù¾ÙˆØ±Ù¹ Ú©ÛŒ Ù‚Ø³Ù…",
  reports: "Ø±Ù¾ÙˆØ±Ù¹Ø³",
  request_approved: "Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ù†Ø¸ÙˆØ± Ú©Ø± Ù„ÛŒ Ú¯Ø¦ÛŒÛ”",
  request_rejected: "Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ù…Ø³ØªØ±Ø¯ Ú©Ø± Ø¯ÛŒ Ú¯Ø¦ÛŒÛ”",
  request_type: "Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ú©ÛŒ Ù‚Ø³Ù…",
  requested_by: "Ú©ÛŒ Ø·Ø±Ù Ø³Û’ Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ú©ÛŒ",
  requested_entity: "Ø¯Ø±Ø®ÙˆØ§Ø³Øª Ú©Ø±Ø¯Û ÛØ³ØªÛŒ",
  requester: "Ù…Ø§Ù†Ú¯Ù†Û’ ÙˆØ§Ù„Ø§",
  requirement_ref: "Ø¶Ø±ÙˆØ±Øª Ref",
  resolved_from: "Ø³Û’ Ø­Ù„ ÛÙˆØ§Û”",
  return_qty: "ÙˆØ§Ù¾Ø³ÛŒ Ú©ÛŒ Ù…Ù‚Ø¯Ø§Ø±",
  return_reason_damaged: "Ù†Ù‚ØµØ§Ù† Ù¾ÛÙ†Ú†Ø§",
  return_reason_excess_qty: "Ø²ÛŒØ§Ø¯Û Ù…Ù‚Ø¯Ø§Ø±",
  return_reason_late_delivery: "Ø¯ÛŒØ± Ø³Û’ ÚˆÛŒÙ„ÛŒÙˆØ±ÛŒ",
  return_reason_other: "Ø¯ÛŒÚ¯Ø±",
  return_reason_quality_issue: "Ù…Ø¹ÛŒØ§Ø± Ú©Ø§ Ù…Ø³Ø¦Ù„Û",
  return_reason_rate_dispute: "Ø´Ø±Ø­ ØªÙ†Ø§Ø²Ø¹Û",
  return_reason_wrong_item: "ØºÙ„Ø· Ø¢Ø¦Ù¹Ù…",
  returnable_assets: "Ù‚Ø§Ø¨Ù„ ÙˆØ§Ù¾Ø³ÛŒ Ø§Ø«Ø§Ø«Û’Û”",
  returnable_assets_description:
    "Ø¸Ø§ÛØ±ÛŒ/ Ø±Ø³ÛŒØ¯ ÙˆØ§Ø¤Ú†Ø±Ø² Ú©Û’ Ù„ÛŒÛ’ ÙˆØ§Ù¾Ø³ÛŒ Ú©Û’ Ù‚Ø§Ø¨Ù„ Ù¹ÙˆÙ„Ø²ØŒ Ù…ÙˆÙ„ÚˆØ²ØŒ ÙÚ©Ø³Ú†Ø± Ø§ÙˆØ± Ù„ÙˆØ§Ø²Ù…Ø§Øª Ú©Ùˆ Ø¨Ø±Ù‚Ø±Ø§Ø± Ø±Ú©Ú¾ÛŒÚºÛ”",
  returnable_dispatch_voucher: "ÚˆØ³Ù¾ÛŒÚ† (Ø¨Ø§ÛØ± Ú©ÛŒ Ø·Ø±Ù)",
  returnable_receipt_voucher: "Ø±Ø³ÛŒØ¯ (Ø§Ù†Ø¯Ø± Ú©ÛŒ Ø·Ø±Ù ÙˆØ§Ù¾Ø³ÛŒ)",
  returnable_reports: "Ù‚Ø§Ø¨Ù„ ÙˆØ§Ù¾Ø³ÛŒ Ø±Ù¾ÙˆØ±Ù¹Ø³",
  returnable_status: "Ù‚Ø§Ø¨Ù„ ÙˆØ§Ù¾Ø³ÛŒ Ú©ÛŒ Ø­ÛŒØ«ÛŒØª",
  returnables: "Ù‚Ø§Ø¨Ù„ ÙˆØ§Ù¾Ø³ÛŒ",
  pending_returnables: "Ø²ÛŒØ± Ø§Ù„ØªÙˆØ§ Ù‚Ø§Ø¨Ù„ ÙˆØ§Ù¾Ø³ÛŒ",
  overdue_returnables: "Ù…Ø¯Øª Ø³Û’ ØªØ¬Ø§ÙˆØ² Ø´Ø¯Û Ù‚Ø§Ø¨Ù„ ÙˆØ§Ù¾Ø³ÛŒ",
  reverse_on_returns: "ÙˆØ§Ù¾Ø³ÛŒ Ù¾Ø± Ø±ÛŒÙˆØ±Ø³",
  rgp_outward_reference: "Ø¢Ø± Ø¬ÛŒ Ù¾ÛŒ - Ø¸Ø§ÛØ±ÛŒ Ø­ÙˆØ§Ù„Û",
  role_changes_global_hint:
    "Ú©Ø±Ø¯Ø§Ø± Ú©ÛŒ Ø§Ø¬Ø§Ø²Øª Ø§Ø³ Ú©Ø±Ø¯Ø§Ø± Ú©Û’ Ù„ÛŒÛ’ ØªÙÙˆÛŒØ¶ Ú©Ø±Ø¯Û ØªÙ…Ø§Ù… ØµØ§Ø±ÙÛŒÙ† Ù¾Ø± Ù„Ø§Ú¯Ùˆ ÛÙˆØªÛŒ ÛÛ’Û”",
  role_name_ur: "Ú©Ø±Ø¯Ø§Ø± Ú©Ø§ Ù†Ø§Ù… (Ø§Ø±Ø¯Ùˆ)",
  roles: "Ú©Ø±Ø¯Ø§Ø±",
  row_notes: "Ù‚Ø·Ø§Ø± Ú©Û’ Ù†ÙˆÙ¹Ø³",
  rows: "Ù‚Ø·Ø§Ø±ÛŒÚº",
  sale_mode: "Ø³ÛŒÙ„ Ù…ÙˆÚˆ",
  sale_mode_direct: "Ø¨Ø±Ø§Û Ø±Ø§Ø³Øª ÙØ±ÙˆØ®Øª",
  sale_mode_from_so: "Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ø³Û’",
  sale_qty: "ÙØ±ÙˆØ®Øª Ú©ÛŒ Ù…Ù‚Ø¯Ø§Ø±",
  sale_rate: "ÙØ±ÙˆØ®Øª Ú©ÛŒ Ø´Ø±Ø­",
  sales_commission: "Ø³ÛŒÙ„Ø² Ú©Ù…ÛŒØ´Ù†",
  sales_commission_description:
    "Ø³ÛŒÙ„Ø² Ú©Ù…ÛŒØ´Ù† Ú©Û’ Ù‚ÙˆØ§Ù†ÛŒÙ† ÛŒÛØ§Úº ÙÛŒ Ù…Ù„Ø§Ø²Ù… Ø§ÙˆØ± Ù¾Ø±ÙˆÚˆÚ©Ù¹ Ú©Û’ Ø¯Ø§Ø¦Ø±Û Ú©Ø§Ø± Ú©Û’ Ù…Ø·Ø§Ø¨Ù‚ ØªØ±ØªÛŒØ¨ Ø¯ÛŒØ¦Û’ Ø¬Ø§Ø¦ÛŒÚº Ú¯Û’Û”",
  sales_discount_policies: "Ø³ÛŒÙ„Ø² ÚˆØ³Ú©Ø§Ø¤Ù†Ù¹ Ù¾Ø§Ù„ÛŒØ³ÛŒØ§Úº",
  sales_order: "Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ±",
  sales_order_description:
    "Ø²ÛŒØ± Ø§Ù„ØªÙˆØ§Ø¡ ØªØ±Ø³ÛŒÙ„ Ú©ÛŒ Ù…Ù‚Ø¯Ø§Ø± Ú©Û’ Ø³Ø§ØªÚ¾ Ú©Ø³Ù¹Ù…Ø± Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ø±ÛŒÚ©Ø§Ø±Úˆ Ú©Ø±ÛŒÚºÛ”",
  sales_order_line: "Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ± Ù„Ø§Ø¦Ù†",
  sales_reports: "Ø³ÛŒÙ„Ø² Ø±Ù¾ÙˆØ±Ù¹Ø³",
  sales_voucher_description:
    "Ú©ÛŒØ´/Ú©Ø±ÛŒÚˆÙ¹ ÛÛŒÙ†ÚˆÙ„Ù†Ú¯ Ú©Û’ Ø³Ø§ØªÚ¾ Ø³ÛŒÙ„Ø² Ø¢Ø±ÚˆØ±Ø² Ú©Û’ Ø®Ù„Ø§Ù Ø¨Ø±Ø§Û Ø±Ø§Ø³Øª ÙØ±ÙˆØ®Øª ÛŒØ§ ØªØ±Ø³ÛŒÙ„ Ø±ÛŒÚ©Ø§Ø±Úˆ Ú©Ø±ÛŒÚºÛ”",
  salesman: "Ø³ÛŒÙ„Ø² Ù…ÛŒÙ†",
  save: "Ù…Ø­ÙÙˆØ¸ Ú©Ø±ÛŒÚºÛ”",
  save_draft: "ÚˆØ±Ø§ÙÙ¹ Ù…Ø­ÙÙˆØ¸ Ú©Ø±ÛŒÚºÛ”",
  saved: "Ù…Ø­ÙÙˆØ¸ Ú©ÛŒØ§ Ú¯ÛŒØ§Û”",
  saved_successfully: "Ú©Ø§Ù…ÛŒØ§Ø¨ÛŒ Ø³Û’ Ù…Ø­ÙÙˆØ¸ ÛÙˆ Ú¯ÛŒØ§Û”",
  saving: "Ù…Ø­ÙÙˆØ¸ Ú©Ø± Ø±ÛØ§ ÛÛ’...",
  scope: "Ø¯Ø§Ø¦Ø±Û Ú©Ø§Ø±",
  scope_missing: "Ø±Ø¬Ø³Ù¹Ø±ÛŒ Ù…ÛŒÚº Ø§Ø³Ú©ÙˆÙ¾ ØºØ§Ø¦Ø¨ ÛÛ’Û”",
  search: "ØªÙ„Ø§Ø´ Ú©Ø±ÛŒÚºÛ”",
  select_account_name: "Ø§Ú©Ø§Ø¤Ù†Ù¹ Ú©Ø§ Ù†Ø§Ù… Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_all: "Ø³Ø¨Ú¾ÛŒ Ú©Ùˆ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_article: "Ø¢Ø±Ù¹ÛŒÚ©Ù„ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_asset_type: "Ø§Ø«Ø§Ø«Û Ú©ÛŒ Ù‚Ø³Ù… Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_condition: "Ø­Ø§Ù„Øª Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_customer: "Ú©Ø³Ù¹Ù…Ø± Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_grn_lines: "Ú©Ù… Ø§Ø² Ú©Ù… Ø§ÛŒÚ© GRN Ù„Ø§Ø¦Ù† Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_item: "Ø¢Ø¦Ù¹Ù… Ú©Ùˆ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_item_type: "Ø¢Ø¦Ù¹Ù… Ú©ÛŒ Ù‚Ø³Ù… Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_module: "Ø§ÛŒÚ© Ù…Ø§ÚˆÛŒÙˆÙ„ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_module_approval_rules:
    "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©Û’ Ø§ØµÙˆÙ„ Ø¯ÛŒÚ©Ú¾Ù†Û’ Ú©Û’ Ù„ÛŒÛ’ Ø³Ø§Ø¦ÚˆØ¨Ø§Ø± Ø³Û’ Ø§ÛŒÚ© Ù…Ø§ÚˆÛŒÙˆÙ„ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_module_permissions:
    "Ø§Ø³ Ú©ÛŒ Ø§Ø¬Ø§Ø²ØªÙˆÚº Ú©Ùˆ Ø¯ÛŒÚ©Ú¾Ù†Û’ Ø§ÙˆØ± Ø§Ø³ Ù…ÛŒÚº ØªØ±Ù…ÛŒÙ… Ú©Ø±Ù†Û’ Ú©Û’ Ù„ÛŒÛ’ Ø³Ø§Ø¦ÚˆØ¨Ø§Ø± Ø³Û’ Ø§ÛŒÚ© Ù…Ø§ÚˆÛŒÙˆÙ„ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_option: "Ø¢Ù¾Ø´Ù† Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_options_to_generate:
    "Ù¾ÛŒØ¯Ø§ Ú©Ø±Ù†Û’ Ú©Û’ Ù„ÛŒÛ’ Ø§Ø®ØªÛŒØ§Ø±Ø§Øª Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_outward_reference: "Ø¸Ø§ÛØ±ÛŒ Ø­ÙˆØ§Ù„Û Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_raw_material: "Ø®Ø§Ù… Ù…Ø§Ù„ Ú©Ùˆ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_role_to_configure:
    "Ø§Ø¬Ø§Ø²ØªÙˆÚº Ú©Ùˆ ØªØ±ØªÛŒØ¨ Ø¯ÛŒÙ†Û’ Ú©Û’ Ù„ÛŒÛ’ Ø§ÛŒÚ© Ú©Ø±Ø¯Ø§Ø± Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_salesman: "Ø³ÛŒÙ„Ø² Ù…ÛŒÙ† Ú©Ùˆ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_target_to_configure:
    "ØªØ±ØªÛŒØ¨ Ø¯ÛŒÙ†Û’ Ú©Û’ Ù„ÛŒÛ’ Ø§ÛŒÚ© ÛØ¯Ù Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_target_to_preview_impact:
    "Ø§Ø«Ø± Ú©Ø§ Ø¬Ø§Ø¦Ø²Û Ù„ÛŒÙ†Û’ Ú©Û’ Ù„ÛŒÛ’ Ø§ÛŒÚ© ÛØ¯Ù Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_unit: "ÛŒÙˆÙ†Ù¹ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_user_to_configure:
    "Ø§Ø¬Ø§Ø²ØªÙˆÚº Ú©Ùˆ ØªØ±ØªÛŒØ¨ Ø¯ÛŒÙ†Û’ Ú©Û’ Ù„ÛŒÛ’ ØµØ§Ø±Ù Ú©Ùˆ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  select_vendor: "ÙˆÛŒÙ†ÚˆØ± Ú©Ùˆ Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  semi_finished: "Ù†ÛŒÙ… ØªÛŒØ§Ø±",
  semi_finished_description:
    "Ù†ÛŒÙ… ØªÛŒØ§Ø± Ø§Ø´ÛŒØ§Ø¡ Ø§ÙˆØ± Ø§Ù† Ú©Û’ Ù‚Ø§Ø¨Ù„ Ø§Ø·Ù„Ø§Ù‚ Ø³Ø§Ø¦Ø² Ú©Ùˆ Ø¨Ø±Ù‚Ø±Ø§Ø± Ø±Ú©Ú¾ÛŒÚºÛ”",
  semi_finished_goods: "Ù†ÛŒÙ… ØªÛŒØ§Ø± Ø´Ø¯Û Ø³Ø§Ù…Ø§Ù†",
  send_for_approval: "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©Û’ Ù„ÛŒÛ’ Ø¨Ú¾ÛŒØ¬ÛŒÚºÛ”",
  sent_qty: "Ù…Ù‚Ø¯Ø§Ø± Ø¨Ú¾ÛŒØ¬ÛŒ Ú¯Ø¦ÛŒÛ”",
  service_capability: "Ø³Ø±ÙˆØ³",
  setup: "Ø³ÛŒÙ¹ Ø§Ù¾",
  sfg_part_type: "SFG Ø­ØµÛ Ú©ÛŒ Ù‚Ø³Ù…",
  show: "Ø¯Ú©Ú¾Ø§Ø¦ÛŒÚºÛ”",
  show_raw_data: "Ø®Ø§Ù… ÚˆÛŒÙ¹Ø§ Ø¯Ú©Ú¾Ø§Ø¦ÛŒÚºÛ”",
  showing: "Ø¯Ú©Ú¾Ø§ Ø±ÛØ§ ÛÛ’Û”",
  shown_rows_totals: "Ø¯Ú©Ú¾Ø§Ø¦ÛŒ Ú¯Ø¦ÛŒ Ù‚Ø·Ø§Ø±ÙˆÚº Ú©Û’ Ù„ÛŒÛ’ Ù¹ÙˆÙ¹Ù„",
  sign_in: "Ø³Ø§Ø¦Ù† Ø§Ù† Ú©Ø±ÛŒÚºÛ”",
  single_grn_voucher_only:
    "Ø§ÛŒÚ© ÙˆØ§Ø­Ø¯ ÙˆØ§Ø¤Ú†Ø± Ø³Û’ GRN Ù„Ø§Ø¦Ù†ÛŒÚº Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  single_outward_voucher_only:
    "Ø§ÛŒÚ© ÙˆØ§Ø¤Ú†Ø± Ø³Û’ Ø¸Ø§ÛØ±ÛŒ Ø­ÙˆØ§Ù„Û Ú©ÛŒ Ù„Ú©ÛŒØ±ÛŒÚº Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  sizes_help:
    "Ø§Ø³ Ù†ÛŒÙ… ØªÛŒØ§Ø± Ø´Ø¯Û Ø´Û’ Ú©Û’ Ø°Ø±ÛŒØ¹Û’ Ø§Ø³ØªØ¹Ù…Ø§Ù„ ÛÙˆÙ†Û’ ÙˆØ§Ù„Û’ Ø§ÛŒÚ© ÛŒØ§ Ø²ÛŒØ§Ø¯Û Ø³Ø§Ø¦Ø² Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚºÛ”",
  sku: "SKU",
  sku_code: "SKU Ú©ÙˆÚˆ",
  skus: "SKUs",
  skus_description:
    "SKU Ù…Ø®ØªÙ„Ù Ø­Ø§Ù„ØªÙˆÚº Ø§ÙˆØ± Ù‚ÛŒÙ…ØªÙˆÚº Ú©Ùˆ Ø¨Ø±Ù‚Ø±Ø§Ø± Ø±Ú©Ú¾ÛŒÚºÛ”",
  source: "Ù…Ø§Ø®Ø°",
  sr_no: "Sr.No",
  start_account: "Ø§Ú©Ø§Ø¤Ù†Ù¹",
  start_at: "Ù¾Ø± Ø´Ø±ÙˆØ¹ Ú©Ø±ÛŒÚºÛ”",
  start_department: "Ù…Ø­Ú©Ù…Û",
  start_group: "Ú¯Ø±ÙˆÙ¾",
  step: "Ù‚Ø¯Ù…",
  stock_count: "Ø§Ø³Ù¹Ø§Ú© Ø´Ù…Ø§Ø±",
  stock_transfer: "Ø§Ø³Ù¹Ø§Ú© Ú©ÛŒ Ù…Ù†ØªÙ‚Ù„ÛŒ",
  sub_group: "Ø°ÛŒÙ„ÛŒ Ú¯Ø±ÙˆÙ¾",
  submitted_for_approval: "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©Û’ Ù„ÛŒÛ’ Ù¾ÛŒØ´ Ú©ÛŒØ§ Ú¯ÛŒØ§Û”",
  subtotal: "Ø°ÛŒÙ„ÛŒ Ú©Ù„",
  success_bulk_commission_saved:
    "Ø¨Ù„Ú© Ú©Ù…ÛŒØ´Ù† Ú©Ø§Ù…ÛŒØ§Ø¨ÛŒ Ø³Û’ Ù…Ø­ÙÙˆØ¸ ÛÙˆ Ú¯ÛŒØ§Û”",
  success_bulk_commission_saved_counts:
    "ØªØ®Ù„ÛŒÙ‚ Ú©ÛŒØ§ Ú¯ÛŒØ§: {created}ØŒ Ø§Ù¾ ÚˆÛŒÙ¹ Ú©ÛŒØ§ Ú¯ÛŒØ§: {updated}Û”",
  success_bulk_labour_rate_saved:
    "Ø¨Ú‘ÛŒ ØªØ¹Ø¯Ø§Ø¯ Ù…ÛŒÚº Ù„ÛŒØ¨Ø± Ú©ÛŒ Ø´Ø±Ø­ Ú©Ø§Ù…ÛŒØ§Ø¨ÛŒ Ú©Û’ Ø³Ø§ØªÚ¾ Ø¨Ú† Ú¯Ø¦ÛŒÛ”",
  success_bulk_labour_rate_saved_counts:
    "ØªØ®Ù„ÛŒÙ‚ Ú©ÛŒØ§ Ú¯ÛŒØ§: {created}ØŒ Ø§Ù¾ ÚˆÛŒÙ¹ Ú©ÛŒØ§ Ú¯ÛŒØ§: {updated}Û”",
  summary: "Ø®Ù„Ø§ØµÛ",
  summary_row: "Ø®Ù„Ø§ØµÛ Ù‚Ø·Ø§Ø±",
  supplier_balance_information: "Ø³Ù¾Ù„Ø§Ø¦Ø± Ø¨ÛŒÙ„Ù†Ø³ Ú©ÛŒ Ù…Ø¹Ù„ÙˆÙ…Ø§Øª",
  supplier_balances_report: "Ø³Ù¾Ù„Ø§Ø¦Ø± Ø¨ÛŒÙ„Ù†Ø³ Ú©ÛŒ Ø±Ù¾ÙˆØ±Ù¹",
  supplier_ledger_report: "Ø³Ù¾Ù„Ø§Ø¦Ø± Ù„ÛŒØ¬Ø± Ø±Ù¾ÙˆØ±Ù¹",
  supplier_listings: "Ø³Ù¾Ù„Ø§Ø¦Ø± Ú©ÛŒ ÙÛØ±Ø³ØªÛŒÚº",
  supplier_reports: "ÙØ±Ø§ÛÙ… Ú©Ù†Ù†Ø¯Û Ú©ÛŒ Ø±Ù¾ÙˆØ±Ù¹Ø³",
  target: "ÛØ¯Ù",
  target_type: "ÛØ¯Ù Ú©ÛŒ Ù‚Ø³Ù…",
  taxable: "Ù‚Ø§Ø¨Ù„ Ù¹ÛŒÚ©Ø³",
  this_month: "Ø§Ø³ Ù…ÛÛŒÙ†Û’",
  time_granularity: "Ù¹Ø§Ø¦Ù… Ú¯Ø±Ø§Ù†ÙˆØ±Ù¹ÛŒ",
  to_unit: "ÛŒÙˆÙ†Ù¹ Ú©Ùˆ",
  tooltip_account_type:
    "Ù…Ø±Ú©Ø²ÛŒ Ø§Ú©Ø§Ø¤Ù†Ù¹Ù†Ú¯ Ú©ÛŒ Ø¯Ø±Ø¬Û Ø¨Ù†Ø¯ÛŒ (Ø§Ø«Ø§Ø«ÛØŒ Ø°Ù…Û Ø¯Ø§Ø±ÛŒØŒ Ø§ÛŒÚ©ÙˆÛŒÙ¹ÛŒØŒ Ù…Ø­ØµÙˆÙ„ØŒ Ø§Ø®Ø±Ø§Ø¬Ø§Øª)Û”",
  tooltip_code:
    "Ø±Ù¾ÙˆØ±Ù¹Ø³ Ø§ÙˆØ± ÙÙ„Ù¹Ø±Ù†Ú¯ Ù…ÛŒÚº Ø§Ø³ØªØ¹Ù…Ø§Ù„ ÛÙˆÙ†Û’ ÙˆØ§Ù„Ø§ Ù…Ø®ØªØµØ± Ú©ÙˆÚˆÛ”",
  tooltip_contra:
    "Ø§Ø³ Ú©Û’ Ù¾ÛŒØ±Ù†Ù¹ Ú¯Ø±ÙˆÙ¾ Ú©Û’ ØªÙˆØ§Ø²Ù† Ú©Ùˆ Ø¢ÙØ³ÛŒÙ¹ Ú©Ø±ØªØ§ ÛÛ’Û”",
  top_account_groups: "Ø³Ø±ÙÛØ±Ø³Øª Ø§Ú©Ø§Ø¤Ù†Ù¹ Ú¯Ø±ÙˆÙ¾Ø³",
  top_accounts: "Ù¹Ø§Ù¾ Ø§Ú©Ø§Ø¤Ù†Ù¹Ø³",
  top_departments: "Ø§Ø¹Ù„ÛŒÙ° Ù…Ø­Ú©Ù…Û’",
  top_groups: "Ø³Ø±ÙÛØ±Ø³Øª Ú¯Ø±ÙˆÙ¾Ø³",
  total_amount: "Ú©Ù„ Ø±Ù‚Ù…",
  total_bill_amount: "Ø¨Ù„ Ú©ÛŒ Ú©Ù„ Ø±Ù‚Ù…",
  total_credit: "Ú©Ù„ Ú©Ø±ÛŒÚˆÙ¹",
  total_debit: "Ú©Ù„ ÚˆÛŒØ¨Ù¹",
  total_discount: "Ú©Ù„ ÚˆØ³Ú©Ø§Ø¤Ù†Ù¹",
  total_returns_amount: "Ú©Ù„ ÙˆØ§Ù¾Ø³ÛŒ Ú©ÛŒ Ø±Ù‚Ù…",
  total_sales_amount: "Ú©Ù„ ÙØ±ÙˆØ®Øª Ú©ÛŒ Ø±Ù‚Ù…",
  transactions_count: "Ù„ÛŒÙ† Ø¯ÛŒÙ†",
  translate_to_urdu: "Ø§Ø±Ø¯Ùˆ Ù…ÛŒÚº ØªØ±Ø¬Ù…Û Ú©Ø±ÛŒÚºÛ”",
  translation_failed: "ØªØ±Ø¬Ù…Û Ø¯Ø³ØªÛŒØ§Ø¨ Ù†ÛÛŒÚº ÛÛ’Û”",
  translation_fetching: "ØªØ±Ø¬Ù…Û Ù„Ø§ Ø±ÛØ§ ÛÛ’...",
  translation_idle:
    "Ø§Ø±Ø¯Ùˆ Ù†Ø§Ù… Ø¨Ú¾Ø±Ù†Û’ Ú©Û’ Ù„ÛŒÛ’ Ø¢Ù¹Ùˆ Ù¹Ø±Ø§Ù†Ø³Ù„ÛŒÙ¹ Ù¾Ø± Ú©Ù„Ú© Ú©Ø±ÛŒÚºÛ”",
  translation_ready: "ØªØ±Ø¬Ù…Û Ø´Ø¯Û",
  trend_chart: "Ø±Ø¬Ø­Ø§Ù† Ú†Ø§Ø±Ù¹",
  trend_chart_click_hint:
    "Ø§Ø³ Ù…Ø¯Øª Ú©Ùˆ Ú©Ú¾ÙˆÙ„Ù†Û’ Ú©Û’ Ù„ÛŒÛ’ Ú©Ø³ÛŒ Ø¨Ú¾ÛŒ Ú†Ø§Ø±Ù¹ Ù¾ÙˆØ§Ø¦Ù†Ù¹ Ù¾Ø± Ú©Ù„Ú© Ú©Ø±ÛŒÚºÛ”",
  trend_vs_previous_period: "Ø±Ø¬Ø­Ø§Ù† Ø¨Ù…Ù‚Ø§Ø¨Ù„Û Ù¾Ú†Ú¾Ù„Ø§ Ø¯ÙˆØ±",
  trial_balance: "Ù¹Ø±Ø§Ø¦Ù„ Ø¨ÛŒÙ„Ù†Ø³ Ú©Ø§ Ø®Ù„Ø§ØµÛ",
  unexpected_response: "ØºÛŒØ± Ù…ØªÙˆÙ‚Ø¹ Ø¬ÙˆØ§Ø¨",
  unique_identifier_hint:
    "Ø§Ø³ Ø¨Ø±Ø§Ù†Ú† Ú©Û’ Ù„ÛŒÛ’ Ù…Ø®ØªØµØ± Ù…Ù†ÙØ±Ø¯ Ú©ÙˆÚˆ (Ø¬ÛŒØ³Û’ LHR01)",
  unit_code_exists: "ÛŒÙˆÙ†Ù¹ Ú©ÙˆÚˆ Ù¾ÛÙ„Û’ Ø³Û’ Ù…ÙˆØ¬ÙˆØ¯ ÛÛ’Û”",
  units: "ÛŒÙˆÙ†Ù¹Ø³",
  unknown: "Ù†Ø§Ù…Ø¹Ù„ÙˆÙ…",
  uom_conversion_help:
    "ÙˆØ¶Ø§Ø­Øª Ú©Ø±ÛŒÚº Ú©Û Ø§ÛŒÚ© ÛŒÙˆÙ†Ù¹ Ø¯ÙˆØ³Ø±Û’ Ù…ÛŒÚº Ú©ÛŒØ³Û’ ØªØ¨Ø¯ÛŒÙ„ ÛÙˆØªØ§ ÛÛ’ (Ø¬ÛŒØ³Û’ØŒ 1 BOX = 10 PCS)Û”",
  uom_conversions: "UOM ØªØ¨Ø§Ø¯Ù„Û’Û”",
  updated: "ØªØ§Ø²Û Ú©Ø§Ø±ÛŒ",
  usage: "Ø§Ø³ØªØ¹Ù…Ø§Ù„ Ù…ÛŒÚº",
  usage_help: "Ø§Ø³ØªØ¹Ù…Ø§Ù„ Ù…ÛŒÚº Ù…Ø¯Ø¯",
  use_credentials:
    "Ø¬Ø§Ø±ÛŒ Ø±Ú©Ú¾Ù†Û’ Ú©Û’ Ù„ÛŒÛ’ Ø§Ù¾Ù†Û’ ERP Ø§Ø³Ù†Ø§Ø¯ Ú©Ø§ Ø§Ø³ØªØ¹Ù…Ø§Ù„ Ú©Ø±ÛŒÚºÛ”",
  user_inactive: "ØµØ§Ø±Ù ØºÛŒØ± ÙØ¹Ø§Ù„ ÛÛ’Û”",
  user_overrides_hint:
    "ØµØ±Ù ØµØ§Ø±Ù Ú©ÛŒ ØªØ¨Ø¯ÛŒÙ„ÛŒØ§Úº ØµØ±Ù Ø§Ø³ ØµØ§Ø±Ù Ù¾Ø± Ù„Ø§Ú¯Ùˆ ÛÙˆØªÛŒ ÛÛŒÚº (Ø±ÙˆÙ„ Ú©ÛŒ Ø§Ø¬Ø§Ø²ØªÛŒÚº ØªØ¨ ØªÚ© Ù„Ø§Ú¯Ùˆ ÛÙˆØªÛŒ ÛÛŒÚº Ø¬Ø¨ ØªÚ© Ú©Û Ø§ÙˆÙˆØ± Ø±Ø§Ø¦Úˆ Ù†Û ÛÙˆ Ø¬Ø§Ø¦ÛŒÚº)Û”",
  username: "ØµØ§Ø±Ù Ù†Ø§Ù…",
  users: "ØµØ§Ø±ÙÛŒÙ†",
  uses_sfg: "SFG Ø§Ø³ØªØ¹Ù…Ø§Ù„ Ú©Ø±ØªØ§ ÛÛ’Û”",
  value: "Ù‚Ø¯Ø±",
  value_type: "Ù‚Ø¯Ø± Ú©ÛŒ Ù‚Ø³Ù…",
  value_type_fixed: "ÙÚ©Ø³Úˆ",
  value_type_percent: "ÙÛŒØµØ¯",
  variance_drivers: "ÙˆÛŒØ±ÛŒØ¦Ù†Ø³ ÚˆØ±Ø§Ø¦ÛŒÙˆØ±Ø²",
  variance_drivers_help:
    "Ù¾ÛŒØ±ÛŒÚˆ Ø§ÙˆÙˆØ± Ù¾ÛŒØ±ÛŒÚˆ Ù…ÙˆÙˆÙ…Ù†Ù¹ Ú©Û’ Ù¾ÛŒÚ†Ú¾Û’ Ø§Ú©Ø§Ø¤Ù†Ù¹ Ú©Û’ Ø³Ø¨ Ø³Û’ Ø¨Ú‘Û’ Ú¯Ø±ÙˆÙ¾ Ø¯Ú©Ú¾Ø§ØªØ§ ÛÛ’Û”",
  variant_id: "Ù…ØªØºÛŒØ± ID",
  variants: "Ù…ØªØºÛŒØ±Ø§Øª",
  variants_sent_approval:
    "Ù…Ù†Ø¸ÙˆØ±ÛŒ Ú©Û’ Ø¨Ø¹Ø¯ Ù…Ø®ØªÙ„Ù Ù‚Ø³Ù…ÛŒÚº Ø´Ø§Ù…Ù„ Ú©ÛŒ Ø¬Ø§Ø¦ÛŒÚº Ú¯ÛŒÛ”",
  vendor_capabilities: "ÙˆÛŒÙ†ÚˆØ± Ú©ÛŒ ØµÙ„Ø§Ø­ÛŒØªÛŒÚºÛ”",
  vendor_capabilities_help:
    "Ù…Ù†ØªØ®Ø¨ Ú©Ø±ÛŒÚº Ú©Û ÛŒÛ Ø³Ù¾Ù„Ø§Ø¦Ø± Ú©ÛŒØ§ Ø³Ù†Ø¨Ú¾Ø§Ù„ Ø³Ú©ØªØ§ ÛÛ’ (Ù…ÙˆØ§Ø¯ØŒ Ù…Ø±Ù…ØªØŒ Ø³Ø±ÙˆØ³)Û”",
  vendor_party: "ÙØ±ÙˆØ´",
  version: "ÙˆØ±Ú˜Ù†",
  view_pending_approval: "Ø²ÛŒØ± Ø§Ù„ØªÙˆØ§Ø¡ Ù…Ù†Ø¸ÙˆØ±ÛŒ Ø¯ÛŒÚ©Ú¾ÛŒÚº",
  view_voucher: "ÙˆØ§Ø¤Ú†Ø± Ú©Ú¾ÙˆÙ„ÛŒÚºÛ”",
  voucher_deleted_read_only:
    "Ø­Ø°Ù Ø´Ø¯Û ÙˆØ§Ø¤Ú†Ø± ØµØ±Ù Ù¾Ú‘Ú¾Ù†Û’ Ú©Û’ Ù„ÛŒÛ’ ÛÛ’Û”",
  voucher_lines: "ÙˆØ§Ø¤Ú†Ø± Ù„Ø§Ø¦Ù†Ø²",
  voucher_register: "ÙˆØ§Ø¤Ú†Ø± Ø±Ø¬Ø³Ù¹Ø±",
  voucher_summary: "ÙˆØ§Ø¤Ú†Ø± Ú©Ø§ Ø®Ù„Ø§ØµÛ",
  voucher_type: "ÙˆØ§Ø¤Ú†Ø± Ú©ÛŒ Ù‚Ø³Ù…",
  vouchers: "ÙˆØ§Ø¤Ú†Ø±Ø²",
  vouchers_label: "ÙˆØ§Ø¤Ú†Ø±Ø²",
  vr_no: "VR Ù†Ù…Ø¨Ø±",
  weekday_fri_short: "Fr",
  weekday_mon_short: "Ù…Ùˆ",
  weekday_sat_short: "Øµ",
  weekday_sun_short: "Ø§ÛŒØ³ ÛŒÙˆ",
  weekday_thu_short: "Ùˆ",
  weekday_tue_short: "Ù¹Ùˆ",
  weekday_wed_short: "ÛÙ…",
  weekly: "ÛÙØªÛ ÙˆØ§Ø±",
  weekly_short_range_daily_hint: "Ù¹Ø§Ø¦Ù… Ú¯Ø±Ø§Ù†ÙˆØ±Ù¹ÛŒ: ÛÙØªÛ ÙˆØ§Ø±Û”",
  welcome: "Ø¯ÙˆØ¨Ø§Ø±Û Ø®ÙˆØ´ Ø¢Ù…Ø¯ÛŒØ¯Û”",
  year_to_date: "Ø³Ø§Ù„ ØªØ§ ØªØ§Ø±ÛŒØ®",
};
// AUTO-URDU-TRANSLATIONS-END

translations.ur = {
  ...translations.ur,
  sr_no: "Ø³Ø±ÛŒ Ù†Ù…Ø¨Ø±",
  weekday_fri_short: "Ø¬",
  skus: "Ø§ÛŒØ³ Ú©Û’ ÛŒÙˆØ²",
  bom: "Ø¨ÛŒ Ø§Ùˆ Ø§ÛŒÙ…",
  id: "Ø´Ù†Ø§Ø®Øª",
  cnic: "Ø´Ù†Ø§Ø®ØªÛŒ Ú©Ø§Ø±Úˆ Ù†Ù…Ø¨Ø±",
  placeholder_employee_code: "Ù…Ù„Ø§Ø²Ù…-001",
  placeholder_labour_code: "Ù„ÛŒØ¨Ø±-001",
  sku: "Ø§ÛŒØ³ Ú©Û’ ÛŒÙˆ",
};

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
  res.locals.t = (key) =>
    translations[locale][key] || translations.en[key] || key;
  res.locals.formatDateDisplay = formatDateDisplay;
  res.locals.formatNumberDisplay = formatNumberDisplay;
  next();
};
