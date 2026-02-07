// approval-preview-registry.js
// Purpose: Provides a registry for preview providers used in approval flows.
// Allows modules to register custom preview logic for approval requests (e.g., to show a summary or diff).
// Used by the approval UI to resolve the best preview for a given approval context.
//
// Usage:
//   const { registerApprovalPreviewProvider } = require("../../utils/approval-preview-registry");
//   registerApprovalPreviewProvider(async ({ req, res, request, side }) => { ...return payloadOrNull; });

const providers = [];

const registerApprovalPreviewProvider = (provider) => {
  if (typeof provider !== "function") {
    throw new TypeError("Approval preview provider must be a function.");
  }
  providers.push(provider);
  return provider;
};

const resolveApprovalPreview = async (context) => {
  for (const provider of providers) {
    // Providers can return null to skip and let the next provider handle it.
    const payload = await provider(context);
    if (payload) return payload;
  }
  return null;
};

module.exports = {
  registerApprovalPreviewProvider,
  resolveApprovalPreview,
};
