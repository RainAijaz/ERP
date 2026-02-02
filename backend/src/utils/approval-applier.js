const { BASIC_INFO_ENTITY_TYPES } = require("./approval-entity-map");

const BASIC_INFO_TABLES = {
  UOM: "erp.uom",
  SIZE: "erp.sizes",
  COLOR: "erp.colors",
  GRADE: "erp.grades",
  PACKING_TYPE: "erp.packing_types",
  CITY: "erp.cities",
  PRODUCT_GROUP: "erp.product_groups",
  PRODUCT_SUBGROUP: "erp.product_subgroups",
  PRODUCT_TYPE: "erp.product_types",
  PARTY_GROUP: "erp.party_groups",
  ACCOUNT_GROUP: "erp.account_groups",
  DEPARTMENT: "erp.departments",
  UOM_CONVERSION: "erp.uom_conversions",
};

const ITEM_TYPE_MAPS = {
  SIZE: { table: "erp.size_item_types", key: "size_id" },
  PRODUCT_GROUP: { table: "erp.product_group_item_types", key: "group_id" },
  PRODUCT_SUBGROUP: { table: "erp.product_subgroup_item_types", key: "subgroup_id" },
};

const BRANCH_MAPS = {
  ACCOUNT: { table: "erp.account_branch", key: "account_id", branchKey: "branch_id" },
  PARTY: { table: "erp.party_branch", key: "party_id", branchKey: "branch_id" },
};

const ACCOUNT_TABLE = "erp.accounts";
const PARTY_TABLE = "erp.parties";

const stripMeta = (value = {}) => {
  const clone = { ...value };
  delete clone.item_types;
  delete clone.branch_ids;
  delete clone._summary;
  delete clone._action;
  delete clone.rates;
  delete clone.usage_ids;
  return clone;
};

const toCode = (value) =>
  (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

const normalizeSkuPart = (value) => (value || "").toString().trim().toUpperCase();

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

const ensureUniqueSku = async (trx, baseCode) => {
  let candidate = baseCode;
  let counter = 2;
  while (await trx("erp.skus").where({ sku_code: candidate }).first()) {
    candidate = `${baseCode} ${counter}`;
    counter += 1;
  }
  return candidate;
};

const getLinkedSfgIds = async (trx, fgId) => {
  const rows = await trx("erp.item_usage").select("sfg_item_id").where({ fg_item_id: fgId });
  return rows.map((row) => row.sfg_item_id);
};

const ensureSfgForFinished = async (trx, finishedItem, sfgPartType, userId) => {
  const suffix = sfgPartType === "STEP" ? "STEP" : "UPPER";
  const sfgName = `${finishedItem.name} - ${suffix}`;
  const sfgCode = toCode(`${finishedItem.code}_${suffix}`);
  const linked = await getLinkedSfgIds(trx, finishedItem.id);
  const existingByCode = await trx("erp.items").select("id").where({ code: sfgCode, item_type: "SFG" }).first();
  if (linked.length) {
    let primaryId = linked[0];
    if (existingByCode && existingByCode.id !== primaryId) {
      await trx("erp.item_usage").where({ fg_item_id: finishedItem.id, sfg_item_id: primaryId }).del();
      await trx("erp.item_usage").insert({ fg_item_id: finishedItem.id, sfg_item_id: existingByCode.id }).onConflict(["fg_item_id", "sfg_item_id"]).ignore();
      primaryId = existingByCode.id;
    }
    await trx("erp.items")
      .where({ id: primaryId })
      .update({
        code: sfgCode,
        name: sfgName,
        name_ur: finishedItem.name_ur || null,
        group_id: finishedItem.group_id,
        subgroup_id: finishedItem.subgroup_id || null,
        product_type_id: finishedItem.product_type_id || null,
        base_uom_id: finishedItem.base_uom_id,
        updated_by: userId,
        updated_at: trx.fn.now(),
      });
    if (linked.length > 1) {
      const extras = linked.slice(1);
      await trx("erp.item_usage").where({ fg_item_id: finishedItem.id }).whereIn("sfg_item_id", extras).del();
      const usedElsewhere = await trx("erp.item_usage").whereIn("sfg_item_id", extras).select("sfg_item_id").groupBy("sfg_item_id");
      const usedSet = new Set(usedElsewhere.map((row) => row.sfg_item_id));
      const deletable = extras.filter((sfgId) => !usedSet.has(sfgId));
      if (deletable.length) {
        await trx("erp.items").whereIn("id", deletable).del();
      }
    }
    return;
  }

  if (existingByCode) {
    await trx("erp.items")
      .where({ id: existingByCode.id })
      .update({
        name: sfgName,
        name_ur: finishedItem.name_ur || null,
        group_id: finishedItem.group_id,
        subgroup_id: finishedItem.subgroup_id || null,
        product_type_id: finishedItem.product_type_id || null,
        base_uom_id: finishedItem.base_uom_id,
        updated_by: userId,
        updated_at: trx.fn.now(),
      });
    await trx("erp.item_usage").insert({ fg_item_id: finishedItem.id, sfg_item_id: existingByCode.id }).onConflict(["fg_item_id", "sfg_item_id"]).ignore();
    return;
  }

  const [created] = await trx("erp.items")
    .insert({
      item_type: "SFG",
      code: sfgCode,
      name: sfgName,
      name_ur: finishedItem.name_ur || null,
      group_id: finishedItem.group_id,
      subgroup_id: finishedItem.subgroup_id || null,
      product_type_id: finishedItem.product_type_id || null,
      base_uom_id: finishedItem.base_uom_id,
      min_stock_level: 0,
      created_by: userId,
      created_at: trx.fn.now(),
    })
    .returning("id");
  const sfgItemId = created.id || created;

  await trx("erp.item_usage").insert({ fg_item_id: finishedItem.id, sfg_item_id: sfgItemId }).onConflict(["fg_item_id", "sfg_item_id"]).ignore();
};

const getNameById = async (trx, table, id) => {
  if (!id) return null;
  const row = await trx(table).select("name").where({ id }).first();
  return row?.name || null;
};

const applySkuChange = async (trx, request, userId) => {
  const { entity_id: entityId, new_value: newValue } = request;
  if (!newValue) return false;

  const action = newValue._action || (entityId === "NEW" ? "create" : "update");

  if (action === "delete") {
    await trx("erp.skus")
      .where({ variant_id: Number(entityId) })
      .del();
    await trx("erp.variants")
      .where({ id: Number(entityId) })
      .del();
    return true;
  }

  if (action === "toggle") {
    await trx("erp.variants")
      .where({ id: Number(entityId) })
      .update({
        is_active: !!newValue.is_active,
        updated_by: userId || null,
        updated_at: trx.fn.now(),
      });
    await trx("erp.skus")
      .where({ variant_id: Number(entityId) })
      .update({ is_active: !!newValue.is_active });
    return true;
  }

  if (action === "update") {
    await trx("erp.variants")
      .where({ id: Number(entityId) })
      .update({
        sale_rate: newValue.sale_rate ?? 0,
        updated_by: userId || null,
        updated_at: trx.fn.now(),
      });
    return true;
  }

  if (action === "create") {
    const item = await trx("erp.items").select("id", "name", "name_ur", "code", "item_type").where({ id: newValue.item_id }).first();
    if (!item) return false;

    const [variant] = await trx("erp.variants")
      .insert({
        item_id: newValue.item_id,
        size_id: newValue.size_id || null,
        grade_id: newValue.grade_id || null,
        color_id: newValue.color_id || null,
        packing_type_id: newValue.packing_type_id || null,
        sale_rate: newValue.sale_rate ?? 0,
        is_active: newValue.is_active !== false,
        created_by: userId || null,
        created_at: trx.fn.now(),
      })
      .returning("id");

    const sizeName = await getNameById(trx, "erp.sizes", newValue.size_id);
    const gradeName = await getNameById(trx, "erp.grades", newValue.grade_id);
    const colorName = await getNameById(trx, "erp.colors", newValue.color_id);
    const packingName = await getNameById(trx, "erp.packing_types", newValue.packing_type_id);

    let baseSku = "";
    if (item.item_type === "SFG") {
      const { base, suffix } = parseSfgNameParts(item.name, item.code);
      baseSku = buildSkuCode(base, [sizeName, colorName, suffix]);
    } else {
      baseSku = buildSkuCode(item.name, [sizeName, packingName, gradeName, colorName]);
    }

    const sku_code = await ensureUniqueSku(trx, baseSku);
    await trx("erp.skus").insert({ variant_id: variant.id || variant, sku_code, is_active: true });
    return true;
  }

  return false;
};

const applyItemChange = async (trx, request, userId) => {
  const { entity_id: entityId, new_value: newValue } = request;
  if (!newValue && entityId === "NEW") return false;

  const action = newValue?._action || (entityId === "NEW" ? "create" : "update");
  const existing =
    entityId !== "NEW"
      ? await trx("erp.items")
          .select("id", "item_type", "code", "name", "name_ur", "group_id", "subgroup_id", "product_type_id", "base_uom_id", "uses_sfg", "sfg_part_type")
          .where({ id: Number(entityId) })
          .first()
      : null;
  const itemType = newValue?.item_type || existing?.item_type;

  if (!itemType) return false;

  if (action === "delete") {
    if (itemType === "FG") {
      const linked = await getLinkedSfgIds(trx, Number(entityId));
      await trx("erp.item_usage")
        .where({ fg_item_id: Number(entityId) })
        .del();
      if (linked.length) {
        const usedElsewhere = await trx("erp.item_usage").whereIn("sfg_item_id", linked).select("sfg_item_id").groupBy("sfg_item_id");
        const usedSet = new Set(usedElsewhere.map((row) => row.sfg_item_id));
        const deletable = linked.filter((sfgId) => !usedSet.has(sfgId));
        if (deletable.length) {
          await trx("erp.items").whereIn("id", deletable).del();
        }
      }
      await trx("erp.items")
        .where({ id: Number(entityId) })
        .del();
      return true;
    }
    if (itemType === "SFG") {
      await trx("erp.item_usage")
        .where({ sfg_item_id: Number(entityId) })
        .del();
      await trx("erp.items")
        .where({ id: Number(entityId) })
        .del();
      return true;
    }
    if (itemType === "RM") {
      await trx("erp.rm_purchase_rates")
        .where({ rm_item_id: Number(entityId) })
        .del();
      await trx("erp.items")
        .where({ id: Number(entityId) })
        .del();
      return true;
    }
    await trx("erp.items")
      .where({ id: Number(entityId) })
      .del();
    return true;
  }

  if (action === "toggle") {
    await trx("erp.items")
      .where({ id: Number(entityId) })
      .update({
        is_active: !!newValue.is_active,
        updated_by: userId || null,
        updated_at: trx.fn.now(),
      });
    if (itemType === "FG") {
      const linked = await getLinkedSfgIds(trx, Number(entityId));
      if (linked.length) {
        await trx("erp.items")
          .whereIn("id", linked)
          .update({
            is_active: !!newValue.is_active,
            updated_by: userId || null,
            updated_at: trx.fn.now(),
          });
      }
    }
    return true;
  }

  if (action === "create") {
    if (!newValue) return false;
    const [created] = await trx("erp.items")
      .insert({
        item_type: itemType,
        code: newValue.code || toCode(newValue.name),
        name: newValue.name,
        name_ur: newValue.name_ur || null,
        group_id: newValue.group_id || null,
        subgroup_id: newValue.subgroup_id || null,
        product_type_id: newValue.product_type_id || null,
        base_uom_id: newValue.base_uom_id || null,
        uses_sfg: newValue.uses_sfg || false,
        sfg_part_type: newValue.sfg_part_type || null,
        min_stock_level: newValue.min_stock_level ?? 0,
        created_by: userId || null,
        created_at: trx.fn.now(),
      })
      .returning("id");
    const newId = created.id || created;

    if (itemType === "RM") {
      const rateRows = Array.isArray(newValue.rates) ? newValue.rates : [];
      if (rateRows.length) {
        await trx("erp.rm_purchase_rates").insert(
          rateRows.map((row) => ({
            rm_item_id: newId,
            color_id: row.color_id || null,
            size_id: row.size_id || null,
            purchase_rate: row.purchase_rate,
            avg_purchase_rate: row.avg_purchase_rate ?? row.purchase_rate,
            created_by: userId || null,
            created_at: trx.fn.now(),
          })),
        );
      }
    }

    if (itemType === "SFG") {
      const usageIds = Array.isArray(newValue.usage_ids) ? newValue.usage_ids : [];
      if (usageIds.length) {
        await trx("erp.item_usage").insert(
          usageIds.map((fgId) => ({
            fg_item_id: fgId,
            sfg_item_id: newId,
          })),
        );
      }
    }

    if (itemType === "FG" && newValue.uses_sfg) {
      const itemRow = await trx("erp.items").select("*").where({ id: newId }).first();
      await ensureSfgForFinished(trx, itemRow, newValue.sfg_part_type, userId || null);
    }

    return true;
  }

  if (action === "update") {
    if (!existing) return false;
    await trx("erp.items")
      .where({ id: Number(entityId) })
      .update({
        code: newValue.code || existing.code,
        name: newValue.name || existing.name,
        name_ur: Object.prototype.hasOwnProperty.call(newValue, "name_ur") ? newValue.name_ur : existing.name_ur,
        group_id: Object.prototype.hasOwnProperty.call(newValue, "group_id") ? newValue.group_id : existing.group_id,
        subgroup_id: Object.prototype.hasOwnProperty.call(newValue, "subgroup_id") ? newValue.subgroup_id : existing.subgroup_id,
        product_type_id: Object.prototype.hasOwnProperty.call(newValue, "product_type_id") ? newValue.product_type_id : existing.product_type_id,
        base_uom_id: Object.prototype.hasOwnProperty.call(newValue, "base_uom_id") ? newValue.base_uom_id : existing.base_uom_id,
        uses_sfg: Object.prototype.hasOwnProperty.call(newValue, "uses_sfg") ? newValue.uses_sfg : existing.uses_sfg,
        sfg_part_type: Object.prototype.hasOwnProperty.call(newValue, "sfg_part_type") ? newValue.sfg_part_type : existing.sfg_part_type,
        min_stock_level: Object.prototype.hasOwnProperty.call(newValue, "min_stock_level") ? newValue.min_stock_level : existing.min_stock_level,
        updated_by: userId || null,
        updated_at: trx.fn.now(),
      });

    if (itemType === "RM") {
      await trx("erp.rm_purchase_rates")
        .where({ rm_item_id: Number(entityId) })
        .del();
      const rateRows = Array.isArray(newValue.rates) ? newValue.rates : [];
      if (rateRows.length) {
        await trx("erp.rm_purchase_rates").insert(
          rateRows.map((row) => ({
            rm_item_id: Number(entityId),
            color_id: row.color_id || null,
            size_id: row.size_id || null,
            purchase_rate: row.purchase_rate,
            avg_purchase_rate: row.avg_purchase_rate ?? row.purchase_rate,
            created_by: userId || null,
            created_at: trx.fn.now(),
          })),
        );
      }
    }

    if (itemType === "SFG") {
      const usageIds = Array.isArray(newValue.usage_ids) ? newValue.usage_ids : [];
      await trx("erp.item_usage")
        .where({ sfg_item_id: Number(entityId) })
        .del();
      if (usageIds.length) {
        await trx("erp.item_usage").insert(
          usageIds.map((fgId) => ({
            fg_item_id: fgId,
            sfg_item_id: Number(entityId),
          })),
        );
      }
    }

    if (itemType === "FG") {
      if (newValue.uses_sfg) {
        const itemRow = await trx("erp.items")
          .select("*")
          .where({ id: Number(entityId) })
          .first();
        await ensureSfgForFinished(trx, itemRow, newValue.sfg_part_type || itemRow.sfg_part_type, userId || null);
      } else {
        const linked = await getLinkedSfgIds(trx, Number(entityId));
        await trx("erp.item_usage")
          .where({ fg_item_id: Number(entityId) })
          .del();
        if (linked.length) {
          await trx("erp.items")
            .whereIn("id", linked)
            .update({
              is_active: false,
              updated_by: userId || null,
              updated_at: trx.fn.now(),
            });
        }
      }
    }

    return true;
  }

  return false;
};

const applyBasicInfoChange = async (trx, entityType, entityId, newValue, userId) => {
  const table = BASIC_INFO_TABLES[entityType];
  if (!table) return false;

  if (!newValue || newValue?._action === "delete") {
    const map = ITEM_TYPE_MAPS[entityType];
    if (map) {
      await trx(map.table)
        .where({ [map.key]: Number(entityId) })
        .del();
    }
    await trx(table)
      .where({ id: Number(entityId) })
      .del();
    return true;
  }

  const values = stripMeta(newValue);
  const isCreate = !entityId || entityId === "NEW";

  if (isCreate) {
    const [created] = await trx(table)
      .insert({
        ...values,
        created_by: userId || null,
        created_at: trx.fn.now(),
      })
      .returning(["id"]);
    const newId = created?.id;

    const map = ITEM_TYPE_MAPS[entityType];
    if (map && Array.isArray(newValue?.item_types) && newId) {
      await trx(map.table)
        .where({ [map.key]: newId })
        .del();
      await trx(map.table).insert(newValue.item_types.map((itemType) => ({ [map.key]: newId, item_type: itemType })));
    }
    return true;
  }

  await trx(table)
    .where({ id: Number(entityId) })
    .update({
      ...values,
      updated_by: userId || null,
      updated_at: trx.fn.now(),
    });

  const map = ITEM_TYPE_MAPS[entityType];
  if (map && Array.isArray(newValue?.item_types)) {
    await trx(map.table)
      .where({ [map.key]: Number(entityId) })
      .del();
    await trx(map.table).insert(newValue.item_types.map((itemType) => ({ [map.key]: Number(entityId), item_type: itemType })));
  }
  return true;
};

const applyAccountPartyChange = async (trx, entityType, entityId, newValue, userId) => {
  const isAccount = entityType === "ACCOUNT";
  const isParty = entityType === "PARTY";
  if (!isAccount && !isParty) return false;

  const table = isAccount ? ACCOUNT_TABLE : PARTY_TABLE;
  const branchMap = BRANCH_MAPS[entityType];
  if (!newValue || newValue?._action === "delete") {
    await trx(branchMap.table)
      .where({ [branchMap.key]: Number(entityId) })
      .del();
    await trx(table)
      .where({ id: Number(entityId) })
      .del();
    return true;
  }

  const values = stripMeta(newValue);
  const isCreate = !entityId || entityId === "NEW";

  if (isCreate) {
    const [created] = await trx(table)
      .insert({
        ...values,
        created_by: userId || null,
        created_at: trx.fn.now(),
      })
      .returning(["id"]);
    const newId = created?.id;

    if (branchMap && Array.isArray(newValue?.branch_ids) && newId) {
      await trx(branchMap.table)
        .where({ [branchMap.key]: newId })
        .del();
      await trx(branchMap.table).insert(
        newValue.branch_ids.map((branchId) => ({
          [branchMap.key]: newId,
          [branchMap.branchKey]: branchId,
        })),
      );
    }
    return true;
  }

  await trx(table)
    .where({ id: Number(entityId) })
    .update({
      ...values,
      updated_by: userId || null,
      updated_at: trx.fn.now(),
    });

  if (branchMap && Array.isArray(newValue?.branch_ids)) {
    await trx(branchMap.table)
      .where({ [branchMap.key]: Number(entityId) })
      .del();
    await trx(branchMap.table).insert(
      newValue.branch_ids.map((branchId) => ({
        [branchMap.key]: Number(entityId),
        [branchMap.branchKey]: branchId,
      })),
    );
  }
  return true;
};

const applyMasterDataChange = async (trx, request, userId) => {
  const { entity_type: entityType, entity_id: entityId, new_value: newValue } = request;
  if (BASIC_INFO_TABLES[entityType]) {
    return applyBasicInfoChange(trx, entityType, entityId, newValue, userId);
  }
  if (entityType === "ACCOUNT" || entityType === "PARTY") {
    return applyAccountPartyChange(trx, entityType, entityId, newValue, userId);
  }
  if (entityType === "ITEM") {
    return applyItemChange(trx, request, userId);
  }
  if (entityType === "SKU") {
    return applySkuChange(trx, request, userId);
  }
  return false;
};

module.exports = {
  applyMasterDataChange,
};
