require("dotenv").config();

const knex = require("../db/knex");
const { translateUrduWithFallback } = require("../utils/translate");

const TAG = "[urdu-voucher-text-backfill]";
const URDU_REGEX = /[\u0600-\u06FF]/;
const DEFAULT_LIMIT = 500;

const normalizeText = (value, max = 1000) =>
  String(value || "")
    .trim()
    .slice(0, max);

const parseLimit = (value) => {
  const parsed = Number(value || 0);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, 5000);
};

const parseMeta = (value) => {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (err) {
    console.error(`${TAG} invalid voucher_line meta`, err);
    return {};
  }
};

const translationCache = new Map();

const toUrdu = async (text, max) => {
  const source = normalizeText(text, max);
  if (!source) return "";
  if (URDU_REGEX.test(source)) return source;
  if (translationCache.has(source)) return translationCache.get(source);

  try {
    const translated = await translateUrduWithFallback({
      text: source,
      mode: "translate",
      logger: console,
    });
    const resolved = normalizeText(translated?.translated, max) || source;
    translationCache.set(source, resolved);
    return resolved;
  } catch (err) {
    console.error(`${TAG} translation failed`, {
      text: source,
      error: err && err.message ? err.message : String(err),
    });
    translationCache.set(source, source);
    return source;
  }
};

const fetchLineRows = (limit) =>
  knex("erp.voucher_line as vl")
    .join("erp.voucher_header as vh", "vh.id", "vl.voucher_header_id")
    .select(
      "vl.id",
      "vl.meta",
      "vh.voucher_type_code",
      "vh.voucher_no",
    )
    .whereRaw("NULLIF(vl.meta->>'description', '') IS NOT NULL")
    .andWhereRaw("COALESCE(NULLIF(vl.meta->>'description_ur', ''), '') = ''")
    .orderBy("vl.id", "asc")
    .limit(limit);

const fetchHeaderRows = async (limit) => {
  const hasRemarksUr = await knex.schema
    .withSchema("erp")
    .hasColumn("voucher_header", "remarks_ur")
    .catch(() => false);
  if (!hasRemarksUr) return [];

  return knex("erp.voucher_header")
    .select("id", "voucher_type_code", "voucher_no", "remarks")
    .whereRaw("NULLIF(remarks, '') IS NOT NULL")
    .andWhereRaw("COALESCE(NULLIF(remarks_ur, ''), '') = ''")
    .orderBy("id", "asc")
    .limit(limit);
};

const backfillLines = async ({ apply, limit }) => {
  const rows = await fetchLineRows(limit);
  if (!apply) {
    return { scanned: rows.length, updated: rows.length };
  }

  let updated = 0;

  for (const row of rows) {
    const meta = parseMeta(row.meta);
    const source = normalizeText(meta.description, 500);
    if (!source) continue;
    const descriptionUr = await toUrdu(source, 500);
    if (!descriptionUr) continue;

    await knex("erp.voucher_line")
      .where({ id: row.id })
      .update({
        meta: JSON.stringify({
          ...meta,
          description_ur: descriptionUr,
        }),
      });
    updated += 1;
  }

  return { scanned: rows.length, updated };
};

const backfillHeaders = async ({ apply, limit }) => {
  const rows = await fetchHeaderRows(limit);
  if (!apply) {
    return { scanned: rows.length, updated: rows.length };
  }

  let updated = 0;

  for (const row of rows) {
    const remarksUr = await toUrdu(row.remarks, 1000);
    if (!remarksUr) continue;

    await knex("erp.voucher_header")
      .where({ id: row.id })
      .update({ remarks_ur: remarksUr });
    updated += 1;
  }

  return { scanned: rows.length, updated };
};

const run = async () => {
  const apply = process.env.APPLY === "1";
  const limit = parseLimit(process.env.LIMIT);

  const [lineResult, headerResult] = await Promise.all([
    backfillLines({ apply, limit }),
    backfillHeaders({ apply, limit }),
  ]);

  console.log(
    `${TAG} mode=${apply ? "apply" : "dry-run"} limit=${limit} line_scanned=${lineResult.scanned} line_${apply ? "updated" : "would_update"}=${lineResult.updated} header_scanned=${headerResult.scanned} header_${apply ? "updated" : "would_update"}=${headerResult.updated}`,
  );
};

run()
  .catch((err) => {
    console.error(`${TAG} fatal`, err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await knex.destroy();
    } catch (err) {
      console.error(`${TAG} failed to close db`, err);
    }
  });
