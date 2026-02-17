const slugifyCode = (value, maxLen = 50) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLen);

const buildBaseCode = ({ name, prefix = "", maxLen = 50 }) => {
  const nameCode = slugifyCode(name, maxLen);
  const prefixCode = slugifyCode(prefix, maxLen);
  const base = [prefixCode, nameCode].filter(Boolean).join("_");
  return (base || prefixCode || "item").slice(0, maxLen);
};

const defaultExists = async ({ knex, table, candidate, excludeId }) => {
  if (!knex || !table || !candidate) return false;
  const query = knex(table).whereRaw("lower(code) = ?", [candidate.toLowerCase()]);
  if (excludeId) {
    query.andWhereNot({ id: excludeId });
  }
  const row = await query.first();
  return Boolean(row);
};

const generateUniqueCode = async ({
  name,
  prefix = "",
  maxLen = 50,
  knex,
  table,
  excludeId = null,
  exists = null,
}) => {
  const base = buildBaseCode({ name, prefix, maxLen });
  const checkExists = exists || ((candidate) => defaultExists({ knex, table, candidate, excludeId }));
  let candidate = base;
  let suffix = 2;

  while (await checkExists(candidate)) {
    const suffixText = `_${suffix}`;
    candidate = `${base.slice(0, Math.max(1, maxLen - suffixText.length))}${suffixText}`;
    suffix += 1;
  }

  return candidate;
};

module.exports = {
  slugifyCode,
  buildBaseCode,
  generateUniqueCode,
};
