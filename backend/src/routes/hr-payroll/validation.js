const normalizePhone = (value) => String(value || "").replace(/\D+/g, "");

const normalizeCnic = (value) => String(value || "").replace(/\D+/g, "");

const isValidPhone = (value) => {
  const normalized = normalizePhone(value);
  return normalized.length === 10 || normalized.length === 11 || normalized.length === 12;
};

const isValidCnic = (value) => {
  const normalized = normalizeCnic(value);
  return normalized.length === 13;
};

const toMoney = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  if (Number.isNaN(numberValue)) return null;
  return Number(numberValue.toFixed(2));
};

const hasTwoDecimalsOrLess = (value) => {
  if (value === null || value === undefined || value === "") return false;
  const raw = String(value);
  const dot = raw.indexOf(".");
  if (dot === -1) return true;
  return raw.slice(dot + 1).length <= 2;
};

const normalizeCode = (value) =>
  String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");

module.exports = {
  normalizePhone,
  normalizeCnic,
  isValidPhone,
  isValidCnic,
  toMoney,
  hasTwoDecimalsOrLess,
  normalizeCode,
};
