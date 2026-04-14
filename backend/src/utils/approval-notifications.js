const { sendMail } = require("./email");

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const safeJson = (value) => {
  try {
    return JSON.stringify(value || {}, null, 2);
  } catch (err) {
    return "{}";
  }
};

const normalizeBaseUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_err) {
    return "";
  }
};

const resolveBaseUrl = (explicitBaseUrl) => {
  const candidates = [
    explicitBaseUrl,
    process.env.APP_BASE_URL,
    process.env.ERP_BASE_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.BASE_URL,
    process.env.E2E_BASE_URL,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeBaseUrl(candidate);
    if (normalized) return normalized;
  }
  return "";
};

const getActiveAdminEmails = async (knex) => {
  const isValidEmail = (value) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  const normalizeEmails = (rows = []) =>
    Array.from(
      new Set(
        rows
          .map((row) => String(row?.email || "").trim())
          .filter((email) => email && isValidEmail(email)),
      ),
    );

  const adminRows = await knex("erp.users")
    .join(
      "erp.role_templates",
      "erp.role_templates.id",
      "erp.users.primary_role_id",
    )
    .select("erp.users.email")
    .whereRaw(
      "lower(trim(erp.role_templates.name)) in ('admin', 'administrator')",
    )
    .andWhereRaw("lower(trim(erp.users.status)) = 'active'")
    .whereNotNull("erp.users.email");

  const scopeRow = await knex("erp.permission_scope_registry")
    .select("id")
    .where({
      scope_type: "SCREEN",
      scope_key: "administration.approvals",
    })
    .first();

  if (!scopeRow?.id) {
    return normalizeEmails(adminRows);
  }

  const rolePermissionRows = await knex("erp.users as u")
    .join("erp.role_permissions as rp", "rp.role_id", "u.primary_role_id")
    .select("u.email")
    .where("rp.scope_id", scopeRow.id)
    .andWhere((builder) => {
      builder
        .where("rp.can_approve", true)
        .orWhere("rp.can_view", true)
        .orWhere("rp.can_navigate", true);
    })
    .andWhereRaw("lower(trim(u.status)) = 'active'")
    .whereNotNull("u.email");

  const userOverrideRows = await knex("erp.users as u")
    .join("erp.user_permissions_override as upo", "upo.user_id", "u.id")
    .select("u.email")
    .where("upo.scope_id", scopeRow.id)
    .andWhere((builder) => {
      builder
        .where("upo.can_approve", true)
        .orWhere("upo.can_view", true)
        .orWhere("upo.can_navigate", true);
    })
    .andWhereRaw("lower(trim(u.status)) = 'active'")
    .whereNotNull("u.email");

  return normalizeEmails([
    ...adminRows,
    ...rolePermissionRows,
    ...userOverrideRows,
  ]);
};

const notifyPendingApprovalAdmins = async ({
  knex,
  approvalRequestId,
  requestType,
  entityType,
  entityId,
  summary,
  oldValue,
  newValue,
  requestedByName,
  branchId,
  baseUrl,
  t,
}) => {
  const emails = await getActiveAdminEmails(knex);
  if (!emails.length) {
    console.warn("[approval-notifications] no active admin emails found", {
      approvalRequestId,
      entityType,
    });
    return;
  }

  const resolvedBaseUrl = resolveBaseUrl(baseUrl);
  const approvalsPath = approvalRequestId
    ? `/administration/approvals?request_id=${encodeURIComponent(String(approvalRequestId))}`
    : "/administration/approvals";
  const approvalsUrl = resolvedBaseUrl
    ? `${resolvedBaseUrl}${approvalsPath}`
    : approvalsPath;
  const websiteUrl = resolvedBaseUrl || approvalsUrl;

  const subject = `${(t && t("approval_pending_subject")) || "ERP approval pending"}: ${entityType || "UNKNOWN"}`;
  const detailTitle = (t && t("approval_pending_details")) || "Request details";
  const requestLabel = (t && t("approval_request_id")) || "Request ID";
  const requestTypeLabel = (t && t("request_type")) || "Request Type";
  const entityTypeLabel = (t && t("entity_type")) || "Entity Type";
  const entityIdLabel = (t && t("entity_id")) || "Entity ID";
  const requestedByLabel = (t && t("requested_by")) || "Requested By";
  const summaryLabel = (t && t("summary")) || "Summary";
  const branchLabel = (t && t("branch")) || "Branch";
  const oldValueLabel = (t && t("old_value")) || "Old Value";
  const newValueLabel = (t && t("new_value")) || "New Value";
  const websiteLabel = (t && t("website")) || "Website";
  const loginLabel = (t && t("login")) || "Login";
  const viewPendingLabel =
    (t && t("view_pending_approval")) || "View pending approval";

  const text = [
    `${detailTitle}:`,
    `${requestLabel}: ${approvalRequestId || "-"}`,
    `${requestTypeLabel}: ${requestType || "-"}`,
    `${entityTypeLabel}: ${entityType || "-"}`,
    `${entityIdLabel}: ${entityId || "-"}`,
    `${requestedByLabel}: ${requestedByName || "-"}`,
    `${branchLabel}: ${branchId || "-"}`,
    `${summaryLabel}: ${summary || "-"}`,
    `${websiteLabel}: ${websiteUrl}`,
    `${loginLabel}: ${websiteUrl}`,
    `${viewPendingLabel}: ${approvalsUrl}`,
    `${oldValueLabel}: ${safeJson(oldValue)}`,
    `${newValueLabel}: ${safeJson(newValue)}`,
  ].join("\n");

  const html = `
    <p><strong>${escapeHtml(detailTitle)}</strong></p>
    <ul>
      <li><strong>${escapeHtml(requestLabel)}:</strong> ${escapeHtml(approvalRequestId || "-")}</li>
      <li><strong>${escapeHtml(requestTypeLabel)}:</strong> ${escapeHtml(requestType || "-")}</li>
      <li><strong>${escapeHtml(entityTypeLabel)}:</strong> ${escapeHtml(entityType || "-")}</li>
      <li><strong>${escapeHtml(entityIdLabel)}:</strong> ${escapeHtml(entityId || "-")}</li>
      <li><strong>${escapeHtml(requestedByLabel)}:</strong> ${escapeHtml(requestedByName || "-")}</li>
      <li><strong>${escapeHtml(branchLabel)}:</strong> ${escapeHtml(branchId || "-")}</li>
      <li><strong>${escapeHtml(summaryLabel)}:</strong> ${escapeHtml(summary || "-")}</li>
      <li><strong>${escapeHtml(websiteLabel)}:</strong> <a href="${escapeHtml(websiteUrl)}">${escapeHtml(websiteUrl)}</a></li>
      <li><strong>${escapeHtml(loginLabel)}:</strong> <a href="${escapeHtml(websiteUrl)}">${escapeHtml(websiteUrl)}</a></li>
      <li><strong>${escapeHtml(viewPendingLabel)}:</strong> <a href="${escapeHtml(approvalsUrl)}">${escapeHtml(approvalsUrl)}</a></li>
    </ul>
    <p><strong>${escapeHtml(oldValueLabel)}</strong></p>
    <pre>${escapeHtml(safeJson(oldValue))}</pre>
    <p><strong>${escapeHtml(newValueLabel)}</strong></p>
    <pre>${escapeHtml(safeJson(newValue))}</pre>
  `;

  try {
    await sendMail({ to: emails, subject, text, html });
  } catch (err) {
    console.error("[approval-notifications] failed to notify admins", {
      approvalRequestId,
      entityType,
      error: err?.message || err,
    });
  }
};

module.exports = {
  getActiveAdminEmails,
  notifyPendingApprovalAdmins,
};
