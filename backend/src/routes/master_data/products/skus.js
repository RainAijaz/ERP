const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");
const { sendMail } = require("../../../utils/email");

const router = express.Router();

// Helper to check permission
const canApproveRates = (user) => {
  return user && (user.isAdmin || (user.permissions && user.permissions.can_approve_rates));
};

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

const loadOptions = async () => {
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

const loadRows = async (filters = {}) => {
  let query = knex("erp.variants as v")
    .select("v.*", "i.code as item_code", "i.name as item_name", "i.name_ur as item_name_ur", "s.name as size_name", "s.name_ur as size_name_ur", "g.name as grade_name", "g.name_ur as grade_name_ur", "c.name as color_name", "c.name_ur as color_name_ur", "p.name as packing_name", "p.name_ur as packing_name_ur", "k.sku_code", "k.barcode", "k.is_active as sku_active", "u.username as created_by_name", "uu.username as updated_by_name", "ar.status as pending_approval_status")
    .leftJoin("erp.items as i", "v.item_id", "i.id")
    .leftJoin("erp.sizes as s", "v.size_id", "s.id")
    .leftJoin("erp.grades as g", "v.grade_id", "g.id")
    .leftJoin("erp.colors as c", "v.color_id", "c.id")
    .leftJoin("erp.packing_types as p", "v.packing_type_id", "p.id")
    .leftJoin("erp.skus as k", "k.variant_id", "v.id")
    .leftJoin("erp.users as u", "v.created_by", "u.id")
    .leftJoin("erp.users as uu", "v.approved_by", "uu.id")
    .leftJoin("erp.approval_request as ar", function () {
      this.on("ar.entity_id", "=", knex.raw("CAST(v.id AS TEXT)")).andOn("ar.entity_type", "=", knex.raw("'SKU'")).andOn("ar.status", "=", knex.raw("'PENDING'")).andOn("ar.request_type", "=", knex.raw("'MASTER_DATA_CHANGE'"));
    });

  if (filters.subgroup_id) query.where("i.subgroup_id", filters.subgroup_id);
  if (filters.created_by) query.where("u.username", filters.created_by);
  if (filters.created_at_start) query.where("v.created_at", ">=", filters.created_at_start);
  if (filters.created_at_end) query.where("v.created_at", "<=", filters.created_at_end + " 23:59:59");

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
    const [rows, options, users] = await Promise.all([loadRows(req.query), loadOptions(), loadUsers()]);
    renderIndex(req, res, {
      rows,
      ...options,
      users,
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

// ... [Imports and helpers remain same] ...
// ... [loadOptions, loadUsers, loadRows, renderIndex remain same] ...

// CREATE (Bulk Generator)
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

    // Combo Data (The separate rates)
    const comboKeys = toArray(values.combo_keys);
    const comboRates = toArray(values.combo_rates);

    // FIXED: Added packingIds.length check
    if (!item_id || !sizeIds.length || !gradeIds.length || !packingIds.length) {
      throw new Error("Missing required fields (Article, Size, Grade, or Packing Type)");
    }

    // Map combo keys to rates
    let rateMap = new Map();
    if (comboKeys.length) {
      comboKeys.forEach((key, idx) => {
        const rate = parseNumber(comboRates[idx]);
        // We only map keys that were actually submitted.
        // If a user deleted a row, its key won't be in values.combo_keys array.
        if (rate !== null) rateMap.set(key, rate);
      });
    }

    // Check if we actually have any combinations to process
    if (rateMap.size === 0) {
      throw new Error("No valid combinations generated. Please ensure you selected options and provided rates.");
    }

    await knex.transaction(async (trx) => {
      const item = await trx("erp.items").select("code").where({ id: item_id }).first();
      // ... [Fetching names for sizes/grades/etc - Keep this block] ...
      const sizes = await trx("erp.sizes").select("id", "name").whereIn("id", sizeIds);
      const grades = await trx("erp.grades").select("id", "name").whereIn("id", gradeIds);
      const colors = colorIds.length ? await trx("erp.colors").select("id", "name").whereIn("id", colorIds) : [];
      const packings = packingIds.length ? await trx("erp.packing_types").select("id", "name").whereIn("id", packingIds) : [];

      const sizeMap = new Map(sizes.map((x) => [x.id, x.name]));
      const gradeMap = new Map(grades.map((x) => [x.id, x.name]));
      const colorMap = new Map(colors.map((x) => [x.id, x.name]));
      const packingMap = new Map(packings.map((x) => [x.id, x.name]));

      const colorList = colorIds.length ? colorIds : [null];

      // FIXED: Packing list is now strictly from selection
      const packingList = packingIds;

      let createdCount = 0;

      for (const size_id of sizeIds) {
        for (const grade_id of gradeIds) {
          for (const color_id of colorList) {
            for (const packing_type_id of packingList) {
              // 1. GENERATE KEY
              const key = buildComboKey(size_id, grade_id, color_id, packing_type_id);

              // 2. CHECK IF USER KEPT THIS COMBINATION
              // If the user clicked "X" on the frontend, this key will NOT be in the rateMap.
              // We MUST skip it.
              if (!rateMap.has(key)) {
                continue;
              }

              const appliedRate = rateMap.get(key);

              const existing = await trx("erp.variants").where({ item_id, size_id, grade_id, color_id, packing_type_id }).first();

              let variantId;
              if (existing) {
                variantId = existing.id;
              } else {
                const [variant] = await trx("erp.variants")
                  .insert({
                    item_id,
                    size_id,
                    grade_id,
                    color_id,
                    packing_type_id,
                    sale_rate: appliedRate,
                    is_active: true,
                    created_by: req.user ? req.user.id : null,
                    created_at: trx.fn.now(),
                  })
                  .returning("id");
                variantId = variant.id || variant;
                createdCount++;
              }

              // Ensure SKU Entry
              const baseSku = buildSkuCode(item.code, [sizeMap.get(size_id), gradeMap.get(grade_id), color_id ? colorMap.get(color_id) : null, packing_type_id ? packingMap.get(packing_type_id) : null]);

              const existingSku = await trx("erp.skus").where({ variant_id: variantId }).first();
              if (!existingSku) {
                const sku_code = await ensureUniqueSku(trx, baseSku);
                await trx("erp.skus").insert({ variant_id: variantId, sku_code, is_active: true });
              }
            }
          }
        }
      }

      // FIXED: Throw error if nothing happened (fixes "silent failure")
      if (createdCount === 0) {
        throw new Error("No new SKUs were created. They may already exist.");
      }
    });
    return res.redirect(basePath + "?success=true");
  } catch (err) {
    const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
    return renderIndex(req, res, { rows, ...options, users, error: res.locals.t("error_unable_save") + ": " + err.message, modalOpen: true, modalMode: "create", values });
  }
});

// ... [Update/Toggle/Delete Routes remain the same] ...
// UPDATE (Single SKU - Restricted)
router.post("/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  const values = { ...req.body };
  const basePath = `${req.baseUrl}`;

  if (!id) return next(new HttpError(404, "Variant not found"));

  try {
    const current = await knex("erp.variants").join("erp.skus", "erp.variants.id", "erp.skus.variant_id").select("erp.variants.*", "erp.skus.sku_code", "erp.skus.barcode").where("erp.variants.id", id).first();

    if (!current) return next(new HttpError(404, "Variant not found"));

    // 1. IMMUTABILITY CHECK
    if (Number(values.item_id) !== current.item_id || Number(values.size_id) !== current.size_id || Number(values.grade_id) !== current.grade_id || (values.color_id && Number(values.color_id) !== (current.color_id || 0)) || (values.packing_type_id && Number(values.packing_type_id) !== (current.packing_type_id || 0))) {
      throw new HttpError(400, res.locals.t("error_immutable_field") || "Cannot edit physical variant properties. Create a new SKU instead.");
    }

    const newRate = Number(values.sale_rate);
    const oldRate = Number(current.sale_rate);
    const barcode = (values.barcode || "").trim() || null;
    const is_active = values.is_active !== "false";

    await knex.transaction(async (trx) => {
      // 2. RATE CHANGE APPROVAL LOGIC
      if (newRate !== oldRate) {
        if (canApproveRates(req.user)) {
          // Authorized: Update immediately
          await trx("erp.variants").where({ id }).update({
            sale_rate: newRate,
            updated_at: trx.fn.now(),
          });

          await trx("erp.activity_log").insert({
            branch_id: req.branchId,
            user_id: req.user.id,
            entity_type: "SKU",
            entity_id: String(id),
            action: "UPDATE",
            voucher_type_code: null,
          });
        } else {
          // Unauthorized: Create Approval Request
          await trx("erp.approval_request").insert({
            branch_id: req.branchId,
            request_type: "MASTER_DATA_CHANGE",
            entity_type: "SKU",
            entity_id: String(id),
            summary: `Rate Change for SKU: ${current.sku_code}`,
            old_value: { sale_rate: oldRate },
            new_value: { sale_rate: newRate },
            status: "PENDING",
            requested_by: req.user.id,
            requested_at: trx.fn.now(),
          });

          // Send Email to Admins
          try {
            const admins = await trx("erp.users").join("erp.role_templates", "erp.users.primary_role_id", "erp.role_templates.id").where("erp.role_templates.name", "Admin").select("email");

            for (const admin of admins) {
              if (admin.email) {
                await sendMail({
                  to: admin.email,
                  subject: "Pending Rate Approval",
                  text: `User ${req.user.username} requested a rate change for SKU ${current.sku_code} from ${oldRate} to ${newRate}.`,
                });
              }
            }
          } catch (emailErr) {
            console.error("Failed to send email:", emailErr);
          }
        }
      }

      // 3. STANDARD UPDATES
      await trx("erp.skus").where({ variant_id: id }).update({
        barcode: barcode,
        is_active: is_active,
      });

      if (is_active !== current.is_active) {
        await trx("erp.variants").where({ id }).update({ is_active });
      }
    });

    const pendingCreated = newRate !== oldRate && !canApproveRates(req.user);
    const successMsg = pendingCreated ? res.locals.t("rate_change_submitted") || "Rate change submitted for approval." : res.locals.t("saved_successfully") || "Saved successfully";

    return res.redirect(basePath + "?success=true&msg=" + encodeURIComponent(successMsg));
  } catch (err) {
    const [rows, options, users] = await Promise.all([loadRows(), loadOptions(), loadUsers()]);
    return renderIndex(req, res, {
      rows,
      ...options,
      users,
      error: err.message || res.locals.t("error_unable_save"),
      modalOpen: true,
      modalMode: "edit",
      values: { ...values, id },
    });
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
