const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");
const { sendMail } = require("../../../utils/email");

const router = express.Router();

const canManageMasterData = (user) => {
  return user && (user.isAdmin || (user.permissions && user.permissions.can_create_master_data));
};

const canApproveRates = (user) => {
  return user && (user.isAdmin || (user.permissions && user.permissions.can_approve_rates));
};

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

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "object") return Object.values(value);
  return [value];
};

const parseNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isNaN(numberValue) ? null : numberValue;
};

const buildComboKey = (sizeId, gradeId, colorId, packingId) => [sizeId || 0, gradeId || 0, colorId || 0, packingId || 0].join("|");

const buildSfgComboKey = (itemId, sizeId, colorId) => [itemId || 0, sizeId || 0, colorId || 0].join("|");

const loadOptions = async (itemType = "FG") => {
  const [items, sizes, grades, colors, packings, subgroups] = await Promise.all([
    knex("erp.items").select("id", "code", "name", "name_ur").where({ item_type: itemType, is_active: true }).orderBy("name"),
    knex("erp.sizes as s").select("s.id", "s.name", "s.name_ur").join("erp.size_item_types as sit", "sit.size_id", "s.id").where("sit.item_type", itemType).andWhere("s.is_active", true).orderBy("s.name"),
    itemType === "FG" ? knex("erp.grades").select("id", "name", "name_ur").where("is_active", true).orderBy("name") : Promise.resolve([]),
    knex("erp.colors").select("id", "name", "name_ur").where("is_active", true).orderBy("name"),
    itemType === "FG" ? knex("erp.packing_types").select("id", "name", "name_ur").where("is_active", true).orderBy("name") : Promise.resolve([]),
    // UPDATED: Only fetch subgroups that have active SKUs/Variants
    knex("erp.product_subgroups as sg").distinct("sg.id", "sg.name", "sg.name_ur").join("erp.items as i", "sg.id", "i.subgroup_id").join("erp.variants as v", "i.id", "v.item_id").where("sg.is_active", true).andWhere("i.item_type", itemType).orderBy("sg.name"),
  ]);
  return { items, sizes, grades, colors, packings, subgroups };
};

const loadUsers = async () => knex("erp.users").select("id", "username").orderBy("username");

const syncSfgVariantsFromFinished = async (userId) => {
  await knex.transaction(async (trx) => {
    const usageRows = await trx("erp.item_usage as iu").select("iu.sfg_item_id", "v.size_id", "v.color_id").join("erp.variants as v", "v.item_id", "iu.fg_item_id").groupBy("iu.sfg_item_id", "v.size_id", "v.color_id");

    if (!usageRows.length) return;

    const sfgIds = [...new Set(usageRows.map((row) => row.sfg_item_id))];
    const sfgItems = await trx("erp.items").select("id", "name", "code").whereIn("id", sfgIds);
    const sfgNameMap = new Map(sfgItems.map((x) => [x.id, x.name]));
    const sfgCodeMap = new Map(sfgItems.map((x) => [x.id, x.code]));

    const existingRows = await trx("erp.variants").select("item_id", "size_id", "color_id").whereIn("item_id", sfgIds).whereNull("grade_id").whereNull("packing_type_id");
    const existingSet = new Set(existingRows.map((row) => buildSfgComboKey(row.item_id, row.size_id, row.color_id)));

    const sizeIds = [...new Set(usageRows.map((row) => row.size_id).filter(Boolean))];
    const colorIds = [...new Set(usageRows.map((row) => row.color_id).filter(Boolean))];
    const sizes = sizeIds.length ? await trx("erp.sizes").select("id", "name").whereIn("id", sizeIds) : [];
    const colors = colorIds.length ? await trx("erp.colors").select("id", "name").whereIn("id", colorIds) : [];
    const sizeMap = new Map(sizes.map((x) => [x.id, x.name]));
    const colorMap = new Map(colors.map((x) => [x.id, x.name]));

    for (const row of usageRows) {
      const comboKey = buildSfgComboKey(row.sfg_item_id, row.size_id, row.color_id);
      if (existingSet.has(comboKey)) continue;

      const [variant] = await trx("erp.variants")
        .insert({
          item_id: row.sfg_item_id,
          size_id: row.size_id || null,
          grade_id: null,
          color_id: row.color_id || null,
          packing_type_id: null,
          sale_rate: 0,
          is_active: true,
          created_by: userId || null,
          created_at: trx.fn.now(),
        })
        .returning("id");

      const sfgName = sfgNameMap.get(row.sfg_item_id) || "SFG";
      const sfgCode = sfgCodeMap.get(row.sfg_item_id) || "";
      const { base, suffix } = parseSfgNameParts(sfgName, sfgCode);
      const baseSku = buildSkuCode(base, [sizeMap.get(row.size_id), row.color_id ? colorMap.get(row.color_id) : null, suffix]);
      const sku_code = await ensureUniqueSku(trx, baseSku);
      await trx("erp.skus").insert({ variant_id: variant.id, sku_code, is_active: true });
    }
  });
};

const loadRows = async (filters = {}, itemType = "FG") => {
  let query = knex("erp.variants as v")
    .select("v.*", "i.code as item_code", "i.name as item_name", "i.name_ur as item_name_ur", "i.subgroup_id", "s.name as size_name", "s.name_ur as size_name_ur", "g.name as grade_name", "g.name_ur as grade_name_ur", "c.name as color_name", "c.name_ur as color_name_ur", "p.name as packing_name", "p.name_ur as packing_name_ur", "k.sku_code", "k.barcode", "k.is_active as sku_active", "ar.status as pending_approval_status", "u.username as created_by_name")
    .leftJoin("erp.items as i", "v.item_id", "i.id")
    .leftJoin("erp.sizes as s", "v.size_id", "s.id")
    .leftJoin("erp.grades as g", "v.grade_id", "g.id")
    .leftJoin("erp.colors as c", "v.color_id", "c.id")
    .leftJoin("erp.packing_types as p", "v.packing_type_id", "p.id")
    .leftJoin("erp.skus as k", "k.variant_id", "v.id")
    .leftJoin("erp.users as u", "v.created_by", "u.id")
    .leftJoin("erp.approval_request as ar", function () {
      this.on("ar.entity_id", "=", knex.raw("CAST(v.id AS TEXT)")).andOn("ar.entity_type", "=", knex.raw("'SKU'")).andOn("ar.status", "=", knex.raw("'PENDING'")).andOn("ar.request_type", "=", knex.raw("'MASTER_DATA_CHANGE'"));
    });

  query.where("i.item_type", itemType);

  // Status filter
  if (filters.status && filters.status !== "all") {
    query.where("k.is_active", filters.status === "active");
  }
  // Search filter
  if (filters.search && filters.search.trim()) {
    const search = `%${filters.search.trim().toLowerCase()}%`;
    query.where(function () {
      this.whereRaw("LOWER(k.sku_code) LIKE ?", [search]).orWhereRaw("LOWER(i.name) LIKE ?", [search]).orWhereRaw("LOWER(s.name) LIKE ?", [search]).orWhereRaw("LOWER(g.name) LIKE ?", [search]).orWhereRaw("LOWER(c.name) LIKE ?", [search]).orWhereRaw("LOWER(p.name) LIKE ?", [search]);
    });
  }
  if (filters.item_id) query.where("v.item_id", filters.item_id);
  if (filters.subgroup_id) query.where("i.subgroup_id", filters.subgroup_id);
  if (filters.created_by) query.where("u.username", filters.created_by);
  if (filters.created_at_start) query.where("v.created_at", ">=", filters.created_at_start);
  if (filters.created_at_end) query.where("v.created_at", "<=", filters.created_at_end + " 23:59:59");

  query.orderBy("i.name", "asc");
  query.orderBy("v.id", "desc");
  const result = await query;
  console.log(`[SKU SERVER DEBUG] Filters:`, filters, `Returned rows:`, result.length);
  return result;
};

const renderIndex = (req, res, payload) => {
  const basePath = `${req.baseUrl}`;
  return res.render("base/layouts/main", {
    title: res.locals.t("skus"),
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view: "../../master_data/products/skus/index",
    t: res.locals.t,
    basePath,
    ...payload,
  });
};

router.get("/config/:itemId", async (req, res, next) => {
  try {
    const itemId = req.params.itemId;
    if (!itemId) return res.json({ size_ids: [], grade_ids: [], color_ids: [], packing_type_ids: [], existing_combinations: [] });

    const variants = await knex("erp.variants").select("size_id", "grade_id", "color_id", "packing_type_id").where("item_id", itemId);

    const config = {
      size_ids: [...new Set(variants.map((v) => v.size_id).filter(Boolean))],
      grade_ids: [...new Set(variants.map((v) => v.grade_id).filter(Boolean))],
      color_ids: [...new Set(variants.map((v) => v.color_id).filter(Boolean))],
      packing_type_ids: [...new Set(variants.map((v) => v.packing_type_id).filter(Boolean))],
      existing_combinations: variants.map((v) => buildComboKey(v.size_id, v.grade_id, v.color_id, v.packing_type_id)),
    };

    res.json(config);
  } catch (err) {
    next(err);
  }
});

router.get("/item-variants/:itemId", async (req, res, next) => {
  try {
    const itemId = req.params.itemId;
    const variants = await knex("erp.variants as v").select("v.id", "v.sale_rate", "s.name as size", "g.name as grade", "c.name as color", "p.name as packing", "k.sku_code").leftJoin("erp.sizes as s", "v.size_id", "s.id").leftJoin("erp.grades as g", "v.grade_id", "g.id").leftJoin("erp.colors as c", "v.color_id", "c.id").leftJoin("erp.packing_types as p", "v.packing_type_id", "p.id").leftJoin("erp.skus as k", "k.variant_id", "v.id").where("v.item_id", itemId).orderBy("v.id", "asc");

    res.json(variants);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const itemType = req.query.item_type === "SFG" ? "SFG" : "FG";
    if (itemType === "SFG") {
      await syncSfgVariantsFromFinished(req.user ? req.user.id : null);
    }
    const [rows, options, users] = await Promise.all([loadRows(req.query, itemType), loadOptions(itemType), loadUsers()]);

    // ADDED: Pagination object generation to fix "0 of 0 entries"
    const pagination = {
      total: rows.length,
      from: rows.length > 0 ? 1 : 0,
      to: rows.length,
      per_page: rows.length, // Showing all on one page for now
      current_page: 1,
      last_page: 1,
    };

    renderIndex(req, res, {
      rows,
      pagination, // Pass to view
      ...options,
      users,
      itemType,
      error: null,
      modalOpen: false,
      modalMode: "create",
      filters: req.query,
      success: req.query.msg ? decodeURIComponent(req.query.msg) : req.query.success === "true" ? res.locals.t("saved_successfully") : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res) => {
  const values = { ...req.body };
  const itemType = req.query.item_type === "SFG" ? "SFG" : "FG";
  const viewQuery = `?item_type=${itemType}`;
  const basePath = `${req.baseUrl}`;

  try {
    const item_id = values.item_id ? Number(values.item_id) : null;
    const sizeIds = toArray(values.size_ids)
      .map(Number)
      .filter((v) => !Number.isNaN(v));
    const gradeIds = toArray(values.grade_ids)
      .map(Number)
      .filter((v) => !Number.isNaN(v));
    const colorIds = toArray(values.color_ids)
      .map(Number)
      .filter((v) => !Number.isNaN(v));
    const packingIds = toArray(values.packing_type_ids)
      .map(Number)
      .filter((v) => !Number.isNaN(v));
    const comboKeys = toArray(values.combo_keys);
    const comboRates = toArray(values.combo_rates);

    if (!item_id || !sizeIds.length || !gradeIds.length || !packingIds.length) {
      throw new Error("Missing required fields");
    }

    let rateMap = new Map();
    if (comboKeys.length) {
      comboKeys.forEach((key, idx) => {
        const rate = parseNumber(comboRates[idx]);
        if (rate !== null) rateMap.set(key, rate);
      });
    }

    if (rateMap.size === 0) throw new Error("No valid combinations generated.");

    await knex.transaction(async (trx) => {
      const isAuthorized = canManageMasterData(req.user);
      const item = await trx("erp.items").select("code", "name", "item_type").where({ id: item_id }).first();
      if (!item || item.item_type !== "FG") {
        throw new Error("Only finished products can be added from this screen.");
      }

      const sizes = await trx("erp.sizes").select("id", "name").whereIn("id", sizeIds);
      const grades = await trx("erp.grades").select("id", "name").whereIn("id", gradeIds);
      const colors = colorIds.length ? await trx("erp.colors").select("id", "name").whereIn("id", colorIds) : [];
      const packings = packingIds.length ? await trx("erp.packing_types").select("id", "name").whereIn("id", packingIds) : [];

      const linkedSfgRows = await trx("erp.item_usage").select("sfg_item_id").where({ fg_item_id: item_id });
      const linkedSfgIds = linkedSfgRows.map((row) => row.sfg_item_id);
      const linkedSfgItems = linkedSfgIds.length ? await trx("erp.items").select("id", "name", "code").whereIn("id", linkedSfgIds) : [];
      const sfgNameMap = new Map(linkedSfgItems.map((x) => [x.id, x.name]));
      const sfgCodeMap = new Map(linkedSfgItems.map((x) => [x.id, x.code]));

      const sizeMap = new Map(sizes.map((x) => [x.id, x.name]));
      const gradeMap = new Map(grades.map((x) => [x.id, x.name]));
      const colorMap = new Map(colors.map((x) => [x.id, x.name]));
      const packingMap = new Map(packings.map((x) => [x.id, x.name]));

      const colorList = colorIds.length ? colorIds : [null];
      const packingList = packingIds;

      let createdCount = 0;
      let pendingCount = 0;

      const createdSfgCombos = new Set();

      for (const size_id of sizeIds) {
        for (const grade_id of gradeIds) {
          for (const color_id of colorList) {
            for (const packing_type_id of packingList) {
              const key = buildComboKey(size_id, grade_id, color_id, packing_type_id);
              if (!rateMap.has(key)) continue;

              const appliedRate = rateMap.get(key);
              const existing = await trx("erp.variants").where({ item_id, size_id, grade_id, color_id, packing_type_id }).first();
              if (existing) continue;

              if (isAuthorized) {
                const [variant] = await trx("erp.variants")
                  .insert({
                    item_id,
                    size_id,
                    grade_id,
                    color_id,
                    packing_type_id,
                    sale_rate: appliedRate,
                    is_active: true,
                    created_by: req.user.id,
                    created_at: trx.fn.now(),
                  })
                  .returning("id");

                const baseSku = buildSkuCode(item.name, [sizeMap.get(size_id), packingMap.get(packing_type_id), gradeMap.get(grade_id), color_id ? colorMap.get(color_id) : null]);
                const sku_code = await ensureUniqueSku(trx, baseSku);
                await trx("erp.skus").insert({ variant_id: variant.id, sku_code, is_active: true });
                createdCount++;
              } else {
                const plannedVariant = {
                  item_id,
                  size_id,
                  grade_id,
                  color_id,
                  packing_type_id,
                  sale_rate: appliedRate,
                  _summary: `${item.name} ${sizeMap.get(size_id)} ${packingMap.get(packing_type_id)} ${gradeMap.get(grade_id)}`,
                };
                await trx("erp.approval_request").insert({
                  branch_id: req.branchId,
                  request_type: "MASTER_DATA_CHANGE",
                  entity_type: "SKU",
                  entity_id: "NEW",
                  summary: `New Variant: ${plannedVariant._summary}`,
                  new_value: plannedVariant,
                  status: "PENDING",
                  requested_by: req.user.id,
                  requested_at: trx.fn.now(),
                });
                pendingCount++;
              }

              if (linkedSfgIds.length) {
                for (const sfgItemId of linkedSfgIds) {
                  const sfgKey = [sfgItemId, size_id || 0, color_id || 0].join("|");
                  if (createdSfgCombos.has(sfgKey)) continue;
                  createdSfgCombos.add(sfgKey);

                  const existingSfg = await trx("erp.variants").where({ item_id: sfgItemId, size_id, color_id, grade_id: null, packing_type_id: null }).first();
                  if (existingSfg) continue;

                  if (isAuthorized) {
                    const [sfgVariant] = await trx("erp.variants")
                      .insert({
                        item_id: sfgItemId,
                        size_id,
                        grade_id: null,
                        color_id,
                        packing_type_id: null,
                        sale_rate: 0,
                        is_active: true,
                        created_by: req.user.id,
                        created_at: trx.fn.now(),
                      })
                      .returning("id");

                    const sfgName = sfgNameMap.get(sfgItemId) || "SFG";
                    const sfgCode = sfgCodeMap.get(sfgItemId) || "";
                    const { base, suffix } = parseSfgNameParts(sfgName, sfgCode);
                    const baseSfgSku = buildSkuCode(base, [sizeMap.get(size_id), color_id ? colorMap.get(color_id) : null, suffix]);
                    const sfgSkuCode = await ensureUniqueSku(trx, baseSfgSku);
                    await trx("erp.skus").insert({ variant_id: sfgVariant.id, sku_code: sfgSkuCode, is_active: true });
                  } else {
                    const sfgName = sfgNameMap.get(sfgItemId) || "SFG";
                    const sfgCode = sfgCodeMap.get(sfgItemId) || "";
                    const { base, suffix } = parseSfgNameParts(sfgName, sfgCode);
                    const plannedSfg = {
                      item_id: sfgItemId,
                      size_id,
                      grade_id: null,
                      color_id,
                      packing_type_id: null,
                      sale_rate: 0,
                      _summary: buildSkuCode(base, [sizeMap.get(size_id), color_id ? colorMap.get(color_id) : null, suffix]),
                    };
                    await trx("erp.approval_request").insert({
                      branch_id: req.branchId,
                      request_type: "MASTER_DATA_CHANGE",
                      entity_type: "SKU",
                      entity_id: "NEW",
                      summary: `New Variant: ${plannedSfg._summary}`,
                      new_value: plannedSfg,
                      status: "PENDING",
                      requested_by: req.user.id,
                      requested_at: trx.fn.now(),
                    });
                  }
                }
              }
            }
          }
        }
      }
      if (createdCount === 0 && pendingCount === 0) throw new Error("No new SKUs were created.");
    });

    const msg = canManageMasterData(req.user) ? res.locals.t("saved_successfully") : res.locals.t("variants_sent_approval");
    return res.redirect(basePath + viewQuery + "&success=true&msg=" + encodeURIComponent(msg));
  } catch (err) {
    const [rows, options, users] = await Promise.all([loadRows({}, itemType), loadOptions(itemType), loadUsers()]);
    return renderIndex(req, res, {
      rows,
      ...options,
      users,
      itemType,
      error: res.locals.t("error_unable_save") + ": " + err.message,
      modalOpen: true,
      modalMode: "create",
      values,
    });
  }
});

router.post("/bulk-update", async (req, res) => {
  const { variant_ids, new_rates } = req.body;
  const itemType = req.query.item_type === "SFG" ? "SFG" : "FG";
  const viewQuery = `?item_type=${itemType}`;
  const basePath = `${req.baseUrl}`;

  const ids = toArray(variant_ids);
  const rates = toArray(new_rates);

  if (!ids.length) return res.redirect(basePath + viewQuery);

  try {
    await knex.transaction(async (trx) => {
      for (let i = 0; i < ids.length; i++) {
        const id = Number(ids[i]);
        const rate = Number(rates[i]);
        if (id && !isNaN(rate)) {
          if (canManageMasterData(req.user)) {
            await trx("erp.variants").where({ id }).update({
              sale_rate: rate,
              updated_at: trx.fn.now(),
              updated_by: req.user.id,
            });
          }
        }
      }
    });
    return res.redirect(basePath + viewQuery + "&success=true&msg=Rates%20Updated");
  } catch (err) {
    const [rows, options, users] = await Promise.all([loadRows({}, itemType), loadOptions(itemType), loadUsers()]);
    return renderIndex(req, res, { rows, ...options, users, itemType, error: "Bulk Update Failed: " + err.message, modalOpen: false, modalMode: "create", values: {} });
  }
});

router.post("/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new HttpError(404, "Variant not found"));
  const itemType = req.query.item_type === "SFG" ? "SFG" : "FG";
  const viewQuery = `?item_type=${itemType}`;
  const basePath = `${req.baseUrl}`;
  try {
    await knex("erp.variants").where({ id }).update({
      sale_rate: req.body.sale_rate,
      updated_at: knex.fn.now(),
      updated_by: req.user.id,
    });
    return res.redirect(basePath + viewQuery + "&success=true");
  } catch (e) {
    next(e);
  }
});

router.post("/:id/toggle", async (req, res, next) => {
  const id = Number(req.params.id);
  const itemType = req.query.item_type === "SFG" ? "SFG" : "FG";
  const viewQuery = `?item_type=${itemType}`;
  const basePath = `${req.baseUrl}`;
  try {
    const current = await knex("erp.variants").select("is_active").where({ id }).first();
    await knex("erp.variants").where({ id }).update({
      is_active: !current.is_active,
      updated_at: knex.fn.now(),
      updated_by: req.user.id,
    });
    await knex("erp.skus").where({ variant_id: id }).update({ is_active: !current.is_active });
    return res.redirect(basePath + viewQuery);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/delete", async (req, res, next) => {
  const id = Number(req.params.id);
  const itemType = req.query.item_type === "SFG" ? "SFG" : "FG";
  const viewQuery = `?item_type=${itemType}`;
  const basePath = `${req.baseUrl}`;
  console.log(`[SKU DELETE] Request received for Variant ID: ${id}`);
  try {
    await knex("erp.skus").where({ variant_id: id }).del();
    await knex("erp.variants").where({ id }).del();
    console.log(`[SKU DELETE] Successfully deleted Variant ID: ${id}`);
    return res.redirect(basePath + viewQuery);
  } catch (err) {
    console.error(`[SKU DELETE ERROR] Variant ID: ${id}`, err);
    next(err);
  }
});

module.exports = router;
