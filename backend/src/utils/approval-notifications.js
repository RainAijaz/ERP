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

const getActiveAdminEmails = async (knex) => {
  const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
  const isPlaceholderDomain = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized.endsWith("@example.com") || normalized.endsWith("@example.org") || normalized.endsWith("@example.net");
  };
  const adminRows = await knex("erp.users")
    .join("erp.role_templates", "erp.role_templates.id", "erp.users.primary_role_id")
    .select("erp.users.email")
    .whereRaw("lower(trim(erp.role_templates.name)) = 'admin'")
    .andWhereRaw("lower(trim(erp.users.status)) = 'active'")
    .whereNotNull("erp.users.email");
  return adminRows
    .map((row) => String(row.email || "").trim())
    .filter((email) => email && isValidEmail(email) && !isPlaceholderDomain(email));
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
  t,
}) => {
  const emails = await getActiveAdminEmails(knex);
  if (!emails.length) return;

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

  const text = [
    `${detailTitle}:`,
    `${requestLabel}: ${approvalRequestId || "-"}`,
    `${requestTypeLabel}: ${requestType || "-"}`,
    `${entityTypeLabel}: ${entityType || "-"}`,
    `${entityIdLabel}: ${entityId || "-"}`,
    `${requestedByLabel}: ${requestedByName || "-"}`,
    `${branchLabel}: ${branchId || "-"}`,
    `${summaryLabel}: ${summary || "-"}`,
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
