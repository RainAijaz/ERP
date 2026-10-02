const { insertActivityLog } = require("../../utils/audit-log");

const normalizeSkuPart = (value) =>
  (value || "").toString().trim().toUpperCase();

const buildSkuCode = (itemName, parts) => {
  const cleanParts = parts.filter(Boolean).map(normalizeSkuPart);
  return [normalizeSkuPart(itemName), ...cleanParts].join(" ");
};

const parseSfgNameParts = (name, code) => {
  if (name && name.includes(" - ")) {
    const [base, ...rest] = name.split(" - ");
    return { base: (base || "").trim(), suffix: rest.join(" - ").trim() };
  }
  const fallback = (code || name || "SFG").replace(/_/g, " ").trim();
  return { base: fallback, suffix: "" };
};

const isGeneratedSkuCodeForBase = (skuCode, baseCode) => {
  const sku = String(skuCode || "").trim();
  const base = String(baseCode || "").trim();
  if (!sku || !base) return false;
  if (sku === base) return true;
  if (!sku.startsWith(`${base} `)) return false;
  return /^\d+$/.test(sku.slice(base.length + 1).trim());
};

const buildSkuCodeForVariant = (row, sizeName) => {
  const itemType = String(row?.item_type || "").trim().toUpperCase();
  if (itemType === "SFG") {
    const { base, suffix } = parseSfgNameParts(row?.item_name, row?.item_code);
    return buildSkuCode(base, [
      sizeName,
      row?.color_name || null,
      suffix || null,
    ]);
  }

  return buildSkuCode(row?.item_name, [
    sizeName,
    row?.packing_name || null,
    row?.grade_name || null,
    row?.color_name || null,
  ]);
};

const priorSizeNamesFromAudit = (entries) => {
  const names = new Set();
  for (const entry of entries) {
    let context = entry.context_json;
    if (typeof context === "string") {
      try { context = JSON.parse(context); } catch { continue; }
    }
    const candidates = [
      context?.old_values?.name,
      context?.old_size_name,
      ...(Array.isArray(context?.changed_fields)
        ? context.changed_fields.filter((field) => field.field === "name").map((field) => field.old_value)
        : []),
    ];
    for (const candidate of candidates) {
      const name = String(candidate || "").trim();
      if (name) names.add(name);
    }
  }
  return [...names];
};

const ensureUniqueSkuCode = async (trx, baseCode, excludeSkuId) => {
  let candidate = baseCode;
  let counter = 2;
  while (
    await trx("erp.skus")
      .where({ sku_code: candidate })
      .modify((query) => {
        if (excludeSkuId) query.whereNot({ id: excludeSkuId });
      })
      .first()
  ) {
    candidate = `${baseCode} ${counter}`;
    counter += 1;
  }
  return candidate;
};

const cascadeSizeRenameToSkuCodes = async ({
  trx,
  sizeId,
  oldName,
  newName,
  userId = null,
}) => {
  const normalizedSizeId = Number(sizeId);
  const previousName = String(oldName || "").trim();
  const nextName = String(newName || "").trim();
  if (!trx || !Number.isInteger(normalizedSizeId) || normalizedSizeId <= 0) {
    return { updated: 0, skipped: 0 };
  }
  if (!previousName || !nextName || previousName === nextName) {
    return { updated: 0, skipped: 0 };
  }

  try {
    const rows = await trx("erp.variants as v")
      .select(
        "v.id as variant_id",
        "v.size_id",
        "i.id as item_id",
        "i.name as item_name",
        "i.code as item_code",
        "i.item_type",
        "g.name as grade_name",
        "c.name as color_name",
        "p.name as packing_name",
        "k.id as sku_id",
        "k.sku_code",
      )
      .join("erp.items as i", "i.id", "v.item_id")
      .join("erp.skus as k", "k.variant_id", "v.id")
      .leftJoin("erp.grades as g", "g.id", "v.grade_id")
      .leftJoin("erp.colors as c", "c.id", "v.color_id")
      .leftJoin("erp.packing_types as p", "p.id", "v.packing_type_id")
      .where("v.size_id", normalizedSizeId)
      .forUpdate("k")
      .orderBy("k.id", "asc");

    const sizeHistory = await trx("erp.activity_log")
      .select("context_json")
      .where({ entity_type: "SIZE", entity_id: String(normalizedSizeId), action: "UPDATE" });
    const knownOldNames = [previousName, ...priorSizeNamesFromAudit(sizeHistory)];

    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      if (!knownOldNames.some((name) =>
        isGeneratedSkuCodeForBase(row.sku_code, buildSkuCodeForVariant(row, name)))) {
        skipped += 1;
        continue;
      }

      const newBaseCode = buildSkuCodeForVariant(row, nextName);
      const nextSkuCode = await ensureUniqueSkuCode(
        trx,
        newBaseCode,
        row.sku_id,
      );
      if (String(row.sku_code || "") === nextSkuCode) {
        skipped += 1;
        continue;
      }

      await trx("erp.skus")
        .where({ id: row.sku_id })
        .update({
          sku_code: nextSkuCode,
        });
      await insertActivityLog(trx, {
        userId: userId || null,
        entityType: "SKU",
        entityId: String(row.variant_id),
        action: "UPDATE",
        context: {
          source: "size-rename-cascade",
          size_id: normalizedSizeId,
          old_size_name: previousName,
          new_size_name: nextName,
          old_sku_code: row.sku_code,
          new_sku_code: nextSkuCode,
        },
      });
      updated += 1;
    }

    return { updated, skipped };
  } catch (err) {
    console.error("Error in SizeRenameService:", err);
    throw err;
  }
};

module.exports = {
  buildSkuCodeForVariant,
  cascadeSizeRenameToSkuCodes,
  isGeneratedSkuCodeForBase,
};
