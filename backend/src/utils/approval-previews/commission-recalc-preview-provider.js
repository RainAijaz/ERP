// Approvals preview for COMMISSION_RECALC requests.
//
// Registered as a provider rather than routed through the HR preview path on
// purpose: buildPreviewPayload runs normalizeRowsForLookup over any hr-payroll
// payload carrying `rows`, and that helper drops every row without a positive
// sku_id. Recalculation rows are keyed by voucher, so they would all be discarded
// and the approver would see "No entries".
//
// Providers run before buildPreviewPayload and short-circuit it entirely, so the
// diff is rendered server-side by our own partial with no client hydration.
const {
  registerApprovalPreviewProvider,
} = require("../approval-preview-registry");
const { RECALC_APPROVAL_MODE } = require("../commission-recalc-approval");

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

registerApprovalPreviewProvider(async ({ req, res, request, side }) => {
  const values =
    side === "old"
      ? request?.old_value
      : request?.new_value;
  if (!values || typeof values !== "object") return null;
  if (String(values.mode || "").toUpperCase() !== RECALC_APPROVAL_MODE) return null;

  const employeeNames =
    values.employee_names && typeof values.employee_names === "object"
      ? values.employee_names
      : {};

  const rows = (Array.isArray(values.rows) ? values.rows : []).map((row) => {
    const previous = row.o === null || row.o === undefined ? null : toNumber(row.o, 0);
    const next = toNumber(row.w, 0);
    return {
      voucher_id: row.v,
      voucher_no: row.n,
      voucher_date: row.d,
      employee_id: row.e,
      employee_name: employeeNames[String(row.e)] || `#${row.e}`,
      commission_type: row.t,
      previous_rate: previous,
      new_rate: next,
      delta: Number((next - (previous || 0)).toFixed(2)),
      status: row.s || "changed",
    };
  });

  return {
    previewAction: "edit",
    previewLabel: res.locals.t("recalculate_commission"),
    previewType: "commission-recalc",
    previewTitle: res.locals.t("recalculate_commission"),
    locale: req.locale,
    previewValues: {
      commission_type: (values.commission_types || []).join(", "),
      from_date: values.from_date || "",
      to_date: values.to_date || "",
      clear_orphans: values.clear_orphans ? "1" : "",
      rows,
      totals: values.totals || { old_total: 0, new_total: 0, delta: 0 },
      counts: values.counts || {},
    },
    formPartial: "../../administration/approvals/commission-recalc-preview.ejs",
  };
});

module.exports = {};
