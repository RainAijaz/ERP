// Phone-number normalization for WhatsApp messaging.
//
// Master records store phones in local, inconsistent forms (e.g. "0300-1234567",
// "+92 300 1234567", "3001234567"). whatsapp-web.js addresses individual chats as
// "<countrycode><number>@c.us", so we canonicalize to a Pakistan mobile MSISDN
// (92 + 10 digits, the 10 digits starting with 3) and build the chat id.
//
// Default country code is configurable but defaults to Pakistan (92).

const DEFAULT_COUNTRY_CODE = String(
  process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || "92",
).replace(/\D/g, "") || "92";

// Returns { chatId, normalized } on success, or { chatId: null, reason } on failure.
// reason is one of: "no_phone", "invalid_phone".
const normalizePkMobileToChatId = (raw) => {
  const cleaned = String(raw ?? "").trim();
  if (!cleaned) return { chatId: null, normalized: null, reason: "no_phone" };

  // Keep only digits (drops +, spaces, dashes, parentheses, etc.).
  let digits = cleaned.replace(/\D/g, "");
  if (!digits) return { chatId: null, normalized: null, reason: "no_phone" };

  const cc = DEFAULT_COUNTRY_CODE;

  // Strip an international "00" prefix (e.g. 0092...).
  if (digits.startsWith("00")) digits = digits.slice(2);

  // Canonicalize the common Pakistani forms to <cc> + national 10-digit number.
  if (digits.startsWith(cc) && digits.length === cc.length + 10) {
    // Already "92XXXXXXXXXX".
  } else if (digits.startsWith("0") && digits.length === 11) {
    // Local "03XXXXXXXXX" -> drop leading 0, prepend country code.
    digits = cc + digits.slice(1);
  } else if (digits.length === 10) {
    // National "3XXXXXXXXX" -> prepend country code.
    digits = cc + digits;
  }

  // Validate: <cc> followed by a 10-digit national number starting with 3 (PK mobile).
  const nationalPattern = new RegExp(`^${cc}3\\d{9}$`);
  if (!nationalPattern.test(digits)) {
    return { chatId: null, normalized: null, reason: "invalid_phone" };
  }

  return { chatId: `${digits}@c.us`, normalized: digits, reason: null };
};

module.exports = { normalizePkMobileToChatId };
