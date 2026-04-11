const VOUCHER_ENTITY_LABELS = {
  CASH_VOUCHER: "cash_voucher",
  BANK_VOUCHER: "bank_voucher",
  JOURNAL_VOUCHER: "journal_voucher",
  SALES_VOUCHER: "sales_voucher",
  SALES_ORDER: "sales_order",
  PURCHASE_VOUCHER: "purchase",
  GOODS_RECEIPT_NOTE: "goods_receipt_note",
  PURCHASE_RETURN: "purchase_return",
};

const VOUCHER_ROUTES = {
  CASH_VOUCHER: "/vouchers/cash",
  BANK_VOUCHER: "/vouchers/bank",
  JOURNAL_VOUCHER: "/vouchers/journal",
  SALES_VOUCHER: "/vouchers/sales",
  SALES_ORDER: "/vouchers/sales-order",
  PURCHASE_VOUCHER: "/vouchers/purchase",
  GOODS_RECEIPT_NOTE: "/vouchers/goods-receipt-note",
  PURCHASE_RETURN: "/vouchers/purchase-return",
};

const ACTION_STYLE = {
  CREATE: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  UPDATE: "bg-blue-50 text-blue-700 ring-blue-200",
  DELETE: "bg-rose-50 text-rose-700 ring-rose-200",
  APPROVE: "bg-amber-50 text-amber-700 ring-amber-200",
  REJECT: "bg-slate-100 text-slate-700 ring-slate-200",
  SUBMIT: "bg-cyan-50 text-cyan-700 ring-cyan-200",
  POST: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  CANCEL: "bg-orange-50 text-orange-700 ring-orange-200",
};

const ACTIVITY_LOG_REPORT_TIME_ZONE =
  String(
    process.env.ERP_REPORT_TIME_ZONE || process.env.TZ || "Asia/Karachi",
  ).trim() || "Asia/Karachi";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: ACTIVITY_LOG_REPORT_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const TIME_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  timeZone: ACTIVITY_LOG_REPORT_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

const parseContext = (value) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch (err) {
    return null;
  }
};

const toText = (value, fallback = "-") => {
  if (value === null || typeof value === "undefined" || value === "")
    return fallback;
  if (Array.isArray(value))
    return (
      value
        .map((entry) => toText(entry, ""))
        .filter(Boolean)
        .join(", ") || fallback
    );
  if (typeof value === "object") return fallback;
  return String(value);
};

const toDateObject = (value) => {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
};

const formatDateLabel = (value) => {
  const dt = toDateObject(value);
  if (!dt) return "-";
  return DATE_FORMATTER.format(dt).replace(/\//g, "-");
};

const formatTimeLabel = (value) => {
  const dt = toDateObject(value);
  if (!dt) return "-";
  return TIME_FORMATTER.format(dt);
};

const formatTimestamp = (value) => {
  if (!value) return "-";
  const datePart = formatDateLabel(value);
  const timePart = formatTimeLabel(value);
  if (datePart === "-" || timePart === "-") return toText(value);
  return `${datePart} ${timePart}`;
};

const toPlainObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const parseVoucherNoFromSummary = (value) => {
  const match = String(value || "").match(/#\s*(\d+)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const extractVoucherNo = (row, context) => {
  const candidates = [
    context?.voucher_no,
    context?.new_value?.voucher_no,
    context?.request_body?.voucher_no,
    parseVoucherNoFromSummary(context?.summary),
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate || 0);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
};

const buildVoucherHref = ({ voucherTypeCode, voucherNo }) => {
  const route = VOUCHER_ROUTES[String(voucherTypeCode || "").toUpperCase()];
  if (!route || !voucherNo) return null;
  return `${route}?voucher_no=${voucherNo}&view=1`;
};

const normalizeActionLabel = ({ row, context, t }) => {
  const action = String(row?.action || "").toUpperCase();
  if (action === "CREATE") return t("created");
  if (action === "UPDATE") return t("updated");
  if (action === "SUBMIT") return t("submitted_for_approval");
  if (action === "APPROVE") return t("approved");
  if (action === "REJECT") return t("rejected");
  if (action === "DELETE") {
    if (context?.approval_request_id) return t("deletion_requested");
    return t("delete");
  }
  if (action === "POST") return t("post");
  return action || "-";
};

const normalizeEntityLabel = ({ row, t }) => {
  if (!row) return "-";
  if (String(row.entity_type || "").toUpperCase() !== "VOUCHER")
    return row.entity_type || "-";
  const code = String(row.voucher_type_code || "").toUpperCase();
  const key = VOUCHER_ENTITY_LABELS[code];
  if (!key) return row.voucher_type_code || row.entity_type || "-";
  return t(key) || row.voucher_type_code || row.entity_type || "-";
};

const normalizeEntityIdLabel = ({ row, context, voucherNo }) => {
  if (!row) return "-";
  if (String(row.entity_type || "").toUpperCase() === "VOUCHER" && voucherNo)
    return String(voucherNo);
  if (row.entity_id !== "NEW") return row.entity_id || "-";
  if (row.action === "APPROVE" && context?.applied_entity_id)
    return String(context.applied_entity_id);
  return "Pending Create";
};

const compactRows = (rows = []) =>
  rows.filter((row) => row && row.value !== "-" && row.value !== "");

const firstDefined = (...values) => {
  for (const value of values) {
    if (value !== null && typeof value !== "undefined" && value !== "")
      return value;
  }
  return null;
};

const parseLinesValue = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return null;
  }
};

const buildChangedFieldRows = ({ context }) => {
  const changed = Array.isArray(context?.changed_fields)
    ? context.changed_fields
    : [];
  if (changed.length) {
    return changed.map((entry) => {
      const field = String(entry?.field || "field");
      return {
        field,
        oldValue: toText(entry?.old_value),
        newValue: toText(entry?.new_value),
      };
    });
  }

  const oldValue = toPlainObject(context?.old_value);
  const newValue = toPlainObject(context?.new_value);
  const keys = Array.from(
    new Set([...Object.keys(oldValue), ...Object.keys(newValue)]),
  )
    .filter((key) => !key.startsWith("_"))
    .filter(
      (key) => !["lines", "lines_json", "permission_reroute"].includes(key),
    );
  return keys
    .filter(
      (key) => JSON.stringify(oldValue[key]) !== JSON.stringify(newValue[key]),
    )
    .map((key) => ({
      field: key,
      oldValue: toText(oldValue[key]),
      newValue: toText(newValue[key]),
    }));
};

const buildDetailsModel = ({
  row,
  context,
  voucherNo,
  t,
  voucherHref,
  displayAction,
}) => {
  const requestBody = toPlainObject(context?.request_body);
  const newValue = toPlainObject(context?.new_value);
  const lineList = firstDefined(
    Array.isArray(newValue?.lines) ? newValue.lines : null,
    parseLinesValue(requestBody?.lines_json),
    Array.isArray(requestBody?.lines) ? requestBody.lines : null,
  );
  const lineCount = Array.isArray(lineList) ? lineList.length : null;

  const auditMetaRows = compactRows([
    { label: t("date"), value: formatTimestamp(row?.created_at) },
    { label: t("user"), value: toText(row?.user_name) },
    {
      label: t("branch"),
      value: toText(firstDefined(row?.branch_name, row?.branch_code)),
    },
    { label: t("entity_type"), value: toText(row?.entity_type) },
    {
      label: t("entity_id"),
      value: toText(normalizeEntityIdLabel({ row, context, voucherNo })),
    },
    { label: t("voucher_type"), value: toText(row?.voucher_type_code) },
  ]);

  const voucherRows = compactRows([
    { label: t("entity"), value: normalizeEntityLabel({ row, t }) },
    { label: t("voucher_no"), value: toText(voucherNo) },
    {
      label: t("date"),
      value: toText(
        firstDefined(
          newValue?.voucher_date,
          requestBody?.voucher_date,
          context?.voucher_date,
        ),
      ),
    },
    {
      label: t("payment_type"),
      value: toText(
        firstDefined(newValue?.payment_type, requestBody?.payment_type),
      ),
    },
    {
      label: t("customer_name"),
      value: toText(
        firstDefined(newValue?.customer_name, requestBody?.customer_name),
      ),
    },
    {
      label: t("total_amount"),
      value: toText(
        firstDefined(
          newValue?.total_amount,
          requestBody?.total_amount,
          requestBody?.payment_received_amount,
        ),
      ),
    },
    {
      label: t("status"),
      value: toText(firstDefined(context?.status, newValue?.status)),
    },
    { label: t("line_count"), value: toText(lineCount) },
  ]);

  const overviewRows = compactRows([
    { label: t("action"), value: displayAction },
    { label: t("source"), value: toText(context?.source) },
    { label: t("request_type"), value: toText(context?.request_type) },
    { label: t("summary"), value: toText(context?.summary) },
    { label: t("method"), value: toText(context?.method) },
    { label: t("path"), value: toText(context?.path) },
  ]);

  const changedFieldRows = buildChangedFieldRows({ context }).map((entry) => ({
    label: String(entry.field || "").replace(/_/g, " "),
    value: `${t("old_value")}: ${entry.oldValue} | ${t("new_value")}: ${entry.newValue}`,
  }));

  const nonVoucherContextRows = compactRows(
    Object.entries(toPlainObject(context))
      .filter(
        ([key]) =>
          ![
            "request_body",
            "new_value",
            "old_value",
            "changed_fields",
          ].includes(key),
      )
      .filter(
        ([key]) =>
          ![
            "source",
            "request_type",
            "summary",
            "method",
            "path",
            "status",
          ].includes(key),
      )
      .map(([key, value]) => ({
        label: key.replace(/_/g, " "),
        value: toText(value),
      })),
  );

  return {
    voucherHref: voucherHref || null,
    voucherLinkLabel: voucherNo ? `${t("view_voucher")} #${voucherNo}` : null,
    sections: compactRows([
      auditMetaRows.length
        ? { title: t("details"), rows: auditMetaRows }
        : null,
      overviewRows.length ? { title: t("overview"), rows: overviewRows } : null,
      voucherRows.length
        ? { title: t("voucher_summary"), rows: voucherRows }
        : null,
      changedFieldRows.length
        ? { title: t("changed_fields"), rows: changedFieldRows }
        : null,
      nonVoucherContextRows.length
        ? { title: t("context"), rows: nonVoucherContextRows }
        : null,
    ]),
    rawContext: context || null,
  };
};

const presentActivityRows = ({ rows = [], t }) =>
  rows.map((row) => {
    const context = parseContext(row.context_json);
    const voucherNo = extractVoucherNo(row, context);
    const voucherTypeCode = String(row.voucher_type_code || "").toUpperCase();
    const voucherHref = buildVoucherHref({ voucherTypeCode, voucherNo });
    const displayAction = normalizeActionLabel({ row, context, t });
    return {
      ...row,
      context_json: context,
      display_date: formatDateLabel(row.created_at),
      display_time: formatTimeLabel(row.created_at),
      display_action: displayAction,
      action_class:
        ACTION_STYLE[String(row.action || "").toUpperCase()] ||
        "bg-slate-50 text-slate-600 ring-slate-200",
      entity_label: normalizeEntityLabel({ row, t }),
      entity_id_label: normalizeEntityIdLabel({ row, context, voucherNo }),
      voucher_no: voucherNo,
      entity_href: voucherHref,
      details_model: buildDetailsModel({
        row,
        context,
        voucherNo,
        t,
        voucherHref,
        displayAction,
      }),
    };
  });

module.exports = {
  presentActivityRows,
};
