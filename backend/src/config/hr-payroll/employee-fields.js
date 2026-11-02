// Shared by the employee form and approval editor; new fields stay editable in legacy requests.
module.exports = [
    {
      name: "name",
      label: "name",
      placeholder: "placeholder_employee_name",
      required: true,
    },
    { name: "name_ur", label: "name_ur", placeholder: "name_ur" },
    {
      name: "cnic",
      label: "cnic",
      placeholder: "placeholder_employee_cnic",
      required: true,
    },
    {
      name: "phone",
      label: "phone_number",
      placeholder: "placeholder_phone_number",
      required: true,
    },
    {
      name: "designation",
      label: "designation_role",
      placeholder: "placeholder_designation_role",
      required: true,
    },
    {
      name: "payroll_type",
      label: "payroll_type",
      hint: 'salary_frequency_help',
      type: "select",
      required: true,
      options: [
        { value: "MONTHLY", label: "payroll_monthly" },
        { value: "WEEKLY", label: "payroll_weekly" },
        { value: "DAILY", label: "payroll_daily" },
        { value: "PIECE_RATE", label: "payroll_piece_rate" },
        { value: "MULTIPLE", label: "payroll_multiple" },
      ],
    },
    { name: "salary_effective_from", label: "salary_effective_from", type: "date", required: true },
    { name: "week_ending_day", label: "salary_week_ending", type: "select", required: true,
      showWhen: { field: "payroll_type", values: ["WEEKLY"] },
      options: [0,1,2,3,4,5,6].map(value => ({ value: String(value), label: `salary_weekday_${value}` })) },
    { name: "salary_proration", label: "salary_proration", type: "select", required: true,
      options: [{value:"NONE",label:"salary_full_period"},{value:"CALENDAR_DAYS",label:"salary_calendar_proration"}] },
    { name: "absence_deductions_enabled", label: "salary_enable_absence_deductions", type: "checkbox" },
    { name: "absence_day_divisor", label: "salary_absence_divisor", type: "number", min: 1, step: "0.001" },
    {
      name: "basic_salary",
      label: "basic_salary",
      type: "number",
      min: 0,
      step: "0.01",
      required: true,
    },
    {
      // Salary accrues only inside this window. Start defaults to the day the
      // record was created (the old implicit behaviour); leaving End blank means
      // still employed.
      name: "employment_start_date",
      label: "employment_start_date",
      type: "date",
      required: true,
    },
    {
      name: "employment_end_date",
      label: "employment_end_date",
      type: "date",
      required: false,
      hint: "employment_end_date_hint",
    },
    {
      name: "branch_ids",
      label: "branches",
      type: "multi-select",
      required: true,
      optionsQuery: {
        table: "erp.branches",
        valueKey: "id",
        labelKey: "name",
        orderBy: "name",
      },
    },
    {
      name: "status",
      label: "status",
      type: "select",
      required: true,
      options: [
        { value: "active", label: "active" },
        { value: "inactive", label: "inactive" },
      ],
    },
  ];
