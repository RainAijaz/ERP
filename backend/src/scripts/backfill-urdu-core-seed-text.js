require("dotenv").config();

const knex = require("../db/knex");
const { translateUrduWithFallback } = require("../utils/translate");

const URDU_REGEX = /[\u0600-\u06FF]/;

const TABLE_CONFIGS = [
  {
    table: "branches",
    key: "id",
    fields: [{ source: "name", target: "name_ur", mode: "transliterate" }],
  },
  {
    table: "role_templates",
    key: "id",
    fields: [
      { source: "name", target: "name_ur", mode: "transliterate" },
      { source: "description", target: "description_ur", mode: "translate" },
    ],
  },
  {
    table: "entity_type_registry",
    key: "code",
    fields: [
      { source: "name", target: "name_ur", mode: "transliterate" },
      { source: "description", target: "description_ur", mode: "translate" },
    ],
  },
  {
    table: "audit_action_registry",
    key: "code",
    fields: [
      { source: "name", target: "name_ur", mode: "transliterate" },
      { source: "description", target: "description_ur", mode: "translate" },
    ],
  },
  {
    table: "approval_request_type_registry",
    key: "code",
    fields: [
      { source: "name", target: "name_ur", mode: "translate" },
      { source: "description", target: "description_ur", mode: "translate" },
    ],
  },
  {
    table: "voucher_type",
    key: "code",
    fields: [{ source: "name", target: "name_ur", mode: "translate" }],
  },
  {
    table: "return_reasons",
    key: "code",
    fields: [
      { source: "description", target: "description_ur", mode: "translate" },
    ],
  },
  {
    table: "permission_scope_registry",
    key: "id",
    fields: [
      { source: "description", target: "description_ur", mode: "translate" },
      { source: "module_group", target: "module_group_ur", mode: "translate" },
    ],
  },
  {
    table: "account_posting_classes",
    key: "code",
    fields: [{ source: "name", target: "name_ur", mode: "translate" }],
  },
  {
    table: "account_groups",
    key: "id",
    fields: [{ source: "name", target: "name_ur", mode: "translate" }],
  },
];

const cache = new Map();

const hasColumn = async (table, column) =>
  knex.schema.withSchema("erp").hasColumn(table, column);

const normalizeText = (value) => String(value || "").trim();

const toUrdu = async (text, mode) => {
  const source = normalizeText(text);
  if (!source) return "";
  if (URDU_REGEX.test(source)) return source;

  const cacheKey = `${mode}:${source}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const translated = await translateUrduWithFallback({
      text: source,
      mode,
      logger: console,
    });
    const resolved = normalizeText(translated?.translated);
    if (!resolved) return "";
    cache.set(cacheKey, resolved);
    return resolved;
  } catch (err) {
    console.error("[urdu-backfill] translation failed", {
      text: source,
      mode,
      error: err && err.message ? err.message : String(err),
    });
    return "";
  }
};

const backfillField = async (tableConfig, fieldConfig) => {
  const { table, key } = tableConfig;
  const { source, target, mode } = fieldConfig;

  const sourceExists = await hasColumn(table, source);
  const targetExists = await hasColumn(table, target);
  if (!sourceExists || !targetExists) {
    console.log(`[urdu-backfill] skip ${table}.${target} (column missing)`);
    return { scanned: 0, updated: 0 };
  }

  const rows = await knex
    .withSchema("erp")
    .from(table)
    .select(key, source, target)
    .whereNotNull(source)
    .andWhereRaw("COALESCE(NULLIF(trim(??), ''), '') = ''", [target]);

  let updated = 0;
  for (const row of rows) {
    const sourceText = normalizeText(row[source]);
    if (!sourceText) continue;
    const translatedText = await toUrdu(sourceText, mode || "translate");
    if (!translatedText) continue;

    await knex
      .withSchema("erp")
      .from(table)
      .where({ [key]: row[key] })
      .update({ [target]: translatedText });
    updated += 1;
  }

  console.log(
    `[urdu-backfill] ${table}.${target}: scanned=${rows.length}, updated=${updated}`,
  );
  return { scanned: rows.length, updated };
};

const run = async () => {
  let totalScanned = 0;
  let totalUpdated = 0;

  for (const tableConfig of TABLE_CONFIGS) {
    for (const fieldConfig of tableConfig.fields) {
      const result = await backfillField(tableConfig, fieldConfig);
      totalScanned += result.scanned;
      totalUpdated += result.updated;
    }
  }

  console.log(
    `[urdu-backfill] completed: scanned=${totalScanned}, updated=${totalUpdated}`,
  );
};

run()
  .catch((err) => {
    console.error("[urdu-backfill] fatal", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await knex.destroy();
    } catch (_) {
      // no-op
    }
  });
