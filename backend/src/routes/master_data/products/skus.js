const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");

const router = express.Router();

const normalizeSkuPart = (value) =>
  (value || "")
    .toString()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-\/]+/g, "")
    .replace(/\//g, "-")
    .toUpperCase();

const buildSkuCode = (itemCode, parts) => {
  const cleanParts = parts.filter(Boolean).map(normalizeSkuPart);
  return [normalizeSkuPart(itemCode), ...cleanParts].filter(Boolean).join("-");
};

const ensureUniqueSku = async (trx, baseCode) => {
  let candidate = baseCode;
  let counter = 2;
  while (await trx("erp.skus").where({ sku_code: candidate }).first()) {
    candidate = `${baseCode}-${counter}`;
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

const findVariant = async (trx, values) => {
  const query = trx("erp.variants").where({
    item_id: values.item_id,
    size_id: values.size_id,
    grade_id: values.grade_id,
  });
  if (values.color_id === null) {
    query.whereNull("color_id");
  } else {
    query.where("color_id", values.color_id);
  }
  if (values.packing_type_id === null) {
    query.whereNull("packing_type_id");
  } else {
    query.where("packing_type_id", values.packing_type_id);
  }
  return query.first();
};

const loadOptions = async () => {
  // FIX: Added 'subgroups' to the list
  const [items, sizes, grades, colors, packings, subgroups] = await Promise.all([
    knex("erp.items").select("id", "code", "name", "name_ur").where({ item_type: "FG", is_active: true }).orderBy("name"),
    knex("erp.sizes as s").select("s.id", "s.name", "s.name_ur").join("erp.size_item_types as sit", "sit.size_id", "s.id").where("sit.item_type", "FG").andWhere("s.is_active", true).orderBy("s.name"),
    knex("erp.grades").select("id", "name", "name_ur").where("is_active", true).orderBy("name"),
    knex("erp.colors").select("id", "name", "name_ur").where("is_active", true).orderBy("name"),
    knex("erp.packing_types").select("id", "name", "name_ur").where("is_active", true).orderBy("name"),
    knex("erp.product_subgroups").select("id", "name", "name_ur").where("is_active", true).orderBy("name"),
  ]);
  return { items, sizes, grades, colors, packings, subgroups };
};

const loadUsers = async () => knex("erp.users").select("id", "username").orderBy("username");

// FIX: Added 'filters' argument
const loadRows = async (filters = {}) => {
  let query = knex("erp.variants as v")
    .select("v.*", "i.code as item_code", "i.name as item_name", "i.name_ur as item_name_ur", "s.name as size_name", "s.name_ur as size_name_ur", "g.name as grade_name", "g.name_ur as grade_name_ur", "c.name as color_name", "c.name_ur as color_name_ur", "p.name as packing_name", "p.name_ur as packing_name_ur", "k.sku_code", "k.barcode", "k.is_active as sku_active", "u.username as created_by_name", "uu.username as updated_by_name")
    .leftJoin("erp.items as i", "v.item_id", "i.id")
    .leftJoin("erp.sizes as s", "v.size_id", "s.id")
    .leftJoin("erp.grades as g", "v.grade_id", "g.id")
    .leftJoin("erp.colors as c", "v.color_id", "c.id")
    .leftJoin("erp.packing_types as p", "v.packing_type_id", "p.id")
    .leftJoin("erp.skus as k", "k.variant_id", "v.id")
    .leftJoin("erp.users as u", "v.created_by", "u.id")
    .leftJoin("erp.users as uu", "v.approved_by", "uu.id");

  // --- FILTERS ---
  if (filters.subgroup_id) {
    // SKUs don't have subgroup_id directly, so we filter by the Parent Item's subgroup
    query.where("i.subgroup_id", filters.subgroup_id);
  }
  if (filters.created_by) {
    query.where("u.username", filters.created_by);
  }
  if (filters.created_at_start) {
    query.where("v.created_at", ">=", filters.created_at_start);
  }
  if (filters.created_at_end) {
    query.where("v.created_at", "<=", filters.created_at_end + " 23:59:59");
  }
  // ----------------

  query.orderBy("v.id", "desc");
  return query;
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

router.get("/", async (req, res, next) => {
  try {
    // FIX: Passed req.query to loadRows
    const [rows, options, users] = await Promise.all([loadRows(req.query), loadOptions(), loadUsers()]);
    // FIX: Passed filters: req.query
    renderIndex(req, res, {
      rows,
      ...options,
      users,
      error: null,
      modalOpen: false,
      modalMode: "create",
      filters: req.query,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res) => {
  const values = { ...req.body };
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
    const sale_rate = parseNumber(values.sale_rate) || 0;
    const comboKeys = toArray(values.combo_keys)
      .map((v) => String(v || ""))
      .filter(Boolean);
    const comboRates = toArray(values.combo_rates);
    const barcode = (values.barcode || "").trim() || null;
    const is_active = values.is_active !== "false";

    if (!item_id || !sizeIds.length || !gradeIds.length) {
      const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
      return renderIndex(req, res, {
        rows,
        ...options,
        users,
        error: res.locals.t("error_required_fields"),
        modalOpen: true,
        modalMode: "create",
        values,
      });
    }

    let rateMap = null;
    if (comboKeys.length) {
      rateMap = new Map();
      let hasMissing = false;
      comboKeys.forEach((key, idx) => {
        const rate = parseNumber(comboRates[idx]);
        if (rate === null) {
          hasMissing = true;
          return;
        }
        rateMap.set(key, rate);
      });
      if (hasMissing || rateMap.size !== comboKeys.length) {
        const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
        return renderIndex(req, res, {
          rows,
          ...options,
          users,
          error: res.locals.t("error_required_fields"),
          modalOpen: true,
          modalMode: "create",
          values,
        });
      }
    }

    await knex.transaction(async (trx) => {
      const item = await trx("erp.items").select("code").where({ id: item_id }).first();
      const sizeMap = new Map((await trx("erp.sizes").select("id", "name").whereIn("id", sizeIds)).map((row) => [row.id, row.name]));
      const gradeMap = new Map((await trx("erp.grades").select("id", "name").whereIn("id", gradeIds)).map((row) => [row.id, row.name]));
      const colorList = colorIds.length ? colorIds : [null];
      const packingList = packingIds.length ? packingIds : [null];
      const colorMap = new Map(colorIds.length ? (await trx("erp.colors").select("id", "name").whereIn("id", colorIds)).map((row) => [row.id, row.name]) : []);
      const packingMap = new Map(packingIds.length ? (await trx("erp.packing_types").select("id", "name").whereIn("id", packingIds)).map((row) => [row.id, row.name]) : []);

      for (const size_id of sizeIds) {
        for (const grade_id of gradeIds) {
          for (const color_id of colorList) {
            for (const packing_type_id of packingList) {
              const comboKey = buildComboKey(size_id, grade_id, color_id, packing_type_id);
              const resolvedRate = rateMap && rateMap.has(comboKey) ? rateMap.get(comboKey) : sale_rate || 0;
              const existing = await findVariant(trx, { item_id, size_id, grade_id, color_id, packing_type_id });

              let variantId = existing ? existing.id : null;
              if (!variantId) {
                const [variant] = await trx("erp.variants")
                  .insert({
                    item_id,
                    size_id,
                    grade_id,
                    color_id: color_id || null,
                    packing_type_id: packing_type_id || null,
                    sale_rate: resolvedRate,
                    is_active,
                    created_by: req.user ? req.user.id : null,
                    created_at: trx.fn.now(),
                  })
                  .returning("id");
                variantId = variant.id || variant;
              } else if (resolvedRate !== null && resolvedRate !== undefined) {
                await trx("erp.variants").where({ id: variantId }).update({ sale_rate: resolvedRate });
              }

              const baseSku = buildSkuCode(item ? item.code : "", [sizeMap.get(size_id), gradeMap.get(grade_id), color_id ? colorMap.get(color_id) : null, packing_type_id ? packingMap.get(packing_type_id) : null]);
              const sku_code = await ensureUniqueSku(trx, baseSku || `SKU-${variantId}`);

              const existingSku = await trx("erp.skus").where({ variant_id: variantId }).first();
              if (existingSku) {
                await trx("erp.skus").where({ variant_id: variantId }).update({ barcode, is_active });
              } else {
                await trx("erp.skus").insert({ variant_id: variantId, sku_code, barcode, is_active });
              }
            }
          }
        }
      }
    });

    return res.redirect(basePath);
  } catch (err) {
    const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
    return renderIndex(req, res, { rows, ...options, users, error: res.locals.t("error_unable_save"), modalOpen: true, modalMode: "create", values });
  }
});

router.post("/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  const values = { ...req.body };
  const basePath = `${req.baseUrl}`;
  if (!id) return next(new HttpError(404, "Variant not found"));

  try {
    const item_id = values.item_id ? Number(values.item_id) : null;
    const sizeIds = toArray(values.size_ids).filter(Boolean);
    const gradeIds = toArray(values.grade_ids).filter(Boolean);
    const colorIds = toArray(values.color_ids).filter(Boolean);
    const packingIds = toArray(values.packing_type_ids).filter(Boolean);
    const size_id = sizeIds.length ? Number(sizeIds[0]) : null;
    const grade_id = gradeIds.length ? Number(gradeIds[0]) : null;
    const color_id = colorIds.length ? Number(colorIds[0]) : null;
    const packing_type_id = packingIds.length ? Number(packingIds[0]) : null;
    const sale_rate = parseNumber(values.sale_rate) || 0;
    const barcode = (values.barcode || "").trim() || null;
    const is_active = values.is_active !== "false";

    if (!item_id || !size_id || !grade_id) {
      const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
      return renderIndex(req, res, {
        rows,
        ...options,
        users,
        error: res.locals.t("error_required_fields"),
        modalOpen: true,
        modalMode: "edit",
        values: { ...values, id },
      });
    }

    await knex.transaction(async (trx) => {
      await trx("erp.variants")
        .where({ id })
        .update({
          item_id,
          size_id,
          grade_id,
          color_id: color_id || null,
          packing_type_id: packing_type_id || null,
          sale_rate: Number.isNaN(sale_rate) ? 0 : sale_rate,
          is_active,
        });

      const item = await trx("erp.items").select("code").where({ id: item_id }).first();
      const size = await trx("erp.sizes").select("name").where({ id: size_id }).first();
      const grade = await trx("erp.grades").select("name").where({ id: grade_id }).first();
      const color = color_id ? await trx("erp.colors").select("name").where({ id: color_id }).first() : null;
      const packing = packing_type_id ? await trx("erp.packing_types").select("name").where({ id: packing_type_id }).first() : null;

      const baseSku = buildSkuCode(item ? item.code : "", [size && size.name, grade && grade.name, color && color.name, packing && packing.name]);
      const sku_code = await ensureUniqueSku(trx, baseSku || `SKU-${id}`);

      const existingSku = await trx("erp.skus").where({ variant_id: id }).first();
      if (existingSku) {
        await trx("erp.skus").where({ variant_id: id }).update({ sku_code, barcode, is_active });
      } else {
        await trx("erp.skus").insert({ variant_id: id, sku_code, barcode, is_active });
      }
    });

    return res.redirect(basePath);
  } catch (err) {
    const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
    return renderIndex(req, res, { rows, ...options, users, error: res.locals.t("error_unable_save"), modalOpen: true, modalMode: "edit", values: { ...values, id } });
  }
});

router.post("/:id/toggle", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new HttpError(404, "Variant not found"));
  const basePath = `${req.baseUrl}`;
  try {
    const current = await knex("erp.variants").select("is_active").where({ id }).first();
    if (!current) return next(new HttpError(404, "Variant not found"));
    await knex("erp.variants").where({ id }).update({ is_active: !current.is_active });
    await knex("erp.skus").where({ variant_id: id }).update({ is_active: !current.is_active });
    return res.redirect(basePath);
  } catch (err) {
    const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
    return renderIndex(req, res, { rows, ...options, users, error: res.locals.t("error_update_status"), modalOpen: false, modalMode: "create" });
  }
});

router.post("/:id/delete", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) return next(new HttpError(404, "Variant not found"));
  const basePath = `${req.baseUrl}`;
  try {
    await knex("erp.variants").where({ id }).del();
    return res.redirect(basePath);
  } catch (err) {
    const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
    return renderIndex(req, res, { rows, ...options, users, error: res.locals.t("error_delete"), modalOpen: false, modalMode: "create" });
  }
});

module.exports = router;
