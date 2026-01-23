const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");

const router = express.Router();

// Pull conversion rows with human-friendly UOM labels.
const fetchRows = () =>
  knex({ c: "erp.uom_conversions" })
    .leftJoin({ uf: "erp.uom" }, "c.from_uom_id", "uf.id")
    .leftJoin({ ut: "erp.uom" }, "c.to_uom_id", "ut.id")
    .leftJoin({ u: "erp.users" }, "c.created_by", "u.id")
    .leftJoin({ uu: "erp.users" }, "c.updated_by", "uu.id")
    .select(
      "c.id",
      "c.from_uom_id",
      "c.to_uom_id",
      "c.factor",
      "c.is_active",
      "c.created_at",
      "c.updated_at",
      "uf.code as from_code",
      "uf.name as from_name",
      "ut.code as to_code",
      "ut.name as to_name",
      "u.username as created_by_name",
      "uu.username as updated_by_name"
    )
    .orderBy("c.id", "desc");

// Only active UOMs are selectable for new conversions.
const fetchUoms = () =>
  knex("erp.uom")
    .select("id", "code", "name")
    .where({ is_active: true })
    .orderBy("code", "asc");

const renderPage = (req, res, data) =>
  res.render("base/layouts/main", {
    title: `${res.locals.t("uom_conversions")} - Basic Info`,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view: "../../master_data/basic-info/uom-conversions/index",
    t: res.locals.t,
    basePath: "/master-data/basic-info/uom-conversions",
    ...data,
  });

router.get("/", async (req, res, next) => {
  try {
    const [rows, uoms] = await Promise.all([fetchRows(), fetchUoms()]);
    return renderPage(req, res, {
      rows,
      uoms,
      error: null,
      modalOpen: false,
      modalMode: "create",
    });
  } catch (err) {
    return next(err);
  }
});

// Normalize POST payloads and ensure numeric types.
const normalizePayload = (body) => {
  const from_uom_id = Number(body.from_uom_id || 0);
  const to_uom_id = Number(body.to_uom_id || 0);
  const factor = Number(body.factor || 0);
  return { from_uom_id, to_uom_id, factor };
};

const renderError = async (req, res, error, modalMode) => {
  const [rows, uoms] = await Promise.all([fetchRows(), fetchUoms()]);
  return renderPage(req, res, {
    rows,
    uoms,
    error,
    modalOpen: true,
    modalMode,
  });
};

router.post("/", async (req, res, next) => {
  const payload = normalizePayload(req.body || {});
  if (!payload.from_uom_id || !payload.to_uom_id || payload.factor <= 0) {
    return renderError(req, res, "Please select both units and enter a valid factor.", "create");
  }

  try {
    await knex("erp.uom_conversions").insert({
      ...payload,
      created_by: req.user ? req.user.id : null,
    });
    return res.redirect("/master-data/basic-info/uom-conversions");
  } catch (err) {
    return renderError(req, res, "Unable to save conversion. Check for duplicates.", "create");
  }
});

router.post("/:id", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) {
    return next(new HttpError(404, "Conversion not found"));
  }

  const payload = normalizePayload(req.body || {});
  if (!payload.from_uom_id || !payload.to_uom_id || payload.factor <= 0) {
    return renderError(req, res, "Please select both units and enter a valid factor.", "edit");
  }

  try {
    await knex("erp.uom_conversions").where({ id }).update({
      ...payload,
      updated_by: req.user ? req.user.id : null,
      updated_at: knex.fn.now(),
    });
    return res.redirect("/master-data/basic-info/uom-conversions");
  } catch (err) {
    return renderError(req, res, "Unable to update conversion. Check for duplicates.", "edit");
  }
});

router.post("/:id/toggle", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) {
    return next(new HttpError(404, "Conversion not found"));
  }

  try {
    const current = await knex("erp.uom_conversions").select("is_active").where({ id }).first();
    if (!current) {
      return next(new HttpError(404, "Conversion not found"));
    }
    await knex("erp.uom_conversions").where({ id }).update({
      is_active: !current.is_active,
      updated_by: req.user ? req.user.id : null,
      updated_at: knex.fn.now(),
    });
    return res.redirect("/master-data/basic-info/uom-conversions");
  } catch (err) {
    return renderError(req, res, "Unable to update conversion. It may be in use.", "delete");
  }
});

router.post("/:id/delete", async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) {
    return next(new HttpError(404, "Conversion not found"));
  }

  try {
    await knex("erp.uom_conversions").where({ id }).del();
    return res.redirect("/master-data/basic-info/uom-conversions");
  } catch (err) {
    return renderError(req, res, "Unable to delete conversion.", "delete");
  }
});

module.exports = router;
