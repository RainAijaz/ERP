const express = require("express");
const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");

const router = express.Router();

const BASIC_INFO_PAGES = {
  units: {
    titleKey: "units",
    description: "Define the units of measure used across items, vouchers, and stock.",
    table: "erp.uom",
    translateMode: "translate",
    columns: [
      { key: "id", label: "ID" },
      { key: "code", label: "Code" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "code",
        label: "Code",
        placeholder: "PCS, DOZEN, KG",
        required: true,
      },
      {
        name: "name",
        label: "Name",
        placeholder: "Pieces, Dozen, Kilogram",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
    ],
  },
  sizes: {
    titleKey: "sizes",
    description: "Size labels used in variants (e.g., 7/10, 9/10).",
    table: "erp.sizes",
    translateMode: "translate",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "name",
        label: "Size",
        placeholder: "7/10, 40, 41",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
    ],
  },
  colors: {
    titleKey: "colors",
    description: "Color options for raw materials and finished variants.",
    table: "erp.colors",
    translateMode: "translate",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "name",
        label: "Color",
        placeholder: "Black, White, Mix",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
    ],
  },
  grades: {
    titleKey: "grades",
    description: "Quality grades for product variants.",
    table: "erp.grades",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "name",
        label: "Grade",
        placeholder: "A, B, C",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
    ],
  },
  "packing-types": {
    titleKey: "packing_types",
    description: "Packaging types for packed stock and variant rules.",
    table: "erp.packing_types",
    translateMode: "transliterate",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "name_ur", label: "Name (Urdu)" },
      { key: "is_active", label: "Active", type: "boolean" },
      { key: "created_by_name", label: "Created By" },
      { key: "created_at", label: "Created At" },
    ],
    fields: [
      {
        name: "name",
        label: "Packing Type",
        placeholder: "Thaili, Box, Carton",
        required: true,
      },
      {
        name: "name_ur",
        label: "Name (Urdu)",
        placeholder: "Urdu name",
        required: true,
      },
    ],
  },
};

const getPageConfig = (key) => BASIC_INFO_PAGES[key];

const renderPage = (req, res, view, page, extra = {}) =>
  res.render("base/layouts/main", {
    title: `${res.locals.t(page.titleKey)} - Basic Info`,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view,
    t: res.locals.t,
    page,
    ...extra,
  });

const fetchRows = (page) =>
  knex({ t: page.table })
    .leftJoin({ u: "erp.users" }, "t.created_by", "u.id")
    .leftJoin({ uu: "erp.users" }, "t.updated_by", "uu.id")
    .select("t.*", "u.username as created_by_name", "uu.username as updated_by_name")
    .orderBy("t.id", "desc");

router.get("/:type", async (req, res, next) => {
  const page = getPageConfig(req.params.type);
  if (!page) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  try {
    const rows = await fetchRows(page);
    return renderPage(req, res, "../../master_data/basic-info/index", page, {
      rows,
      basePath: `/master-data/basic-information/${req.params.type}`,
      values: page.defaults || {},
      error: null,
      modalOpen: false,
      modalMode: "create",
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:type/new", (req, res, next) => {
  const page = getPageConfig(req.params.type);
  if (!page) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  return renderPage(req, res, "../../master_data/basic-info/form", page, {
    basePath: `/master-data/basic-information/${req.params.type}`,
    values: page.defaults || {},
    error: null,
  });
});

const buildValues = (page, body) =>
  page.fields.reduce((acc, field) => {
    if (field.type === "checkbox") {
      acc[field.name] = body[field.name] === "on";
      return acc;
    }
    acc[field.name] = (body[field.name] || "").trim();
    return acc;
  }, {});

const renderIndexError = async (req, res, page, values, error, modalMode) => {
  const rows = await fetchRows(page);
  return res.status(400).render("base/layouts/main", {
    title: `${res.locals.t(page.titleKey)} - Basic Info`,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view: "../../master_data/basic-info/index",
    t: res.locals.t,
    page,
    basePath: `/master-data/basic-information/${req.params.type}`,
    values,
    rows,
    error,
    modalOpen: true,
    modalMode,
  });
};

router.post("/:type", async (req, res, next) => {
  const page = getPageConfig(req.params.type);
  if (!page) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  const values = buildValues(page, req.body);
  const missing = page.fields.filter((field) => field.required).filter((field) => !values[field.name]);

  if (missing.length) {
    return renderIndexError(req, res, page, values, res.locals.t("error_required_fields"), "create");
  }

  try {
    const insertValues = {
      ...values,
      created_by: req.user ? req.user.id : null,
    };
    await knex(page.table).insert(insertValues);
    return res.redirect(`/master-data/basic-information/${req.params.type}`);
  } catch (err) {
    return renderIndexError(
      req,
      res,
      page,
      values,
      res.locals.t("error_unable_save"),
      "create"
    );
  }
});

router.post("/:type/:id", async (req, res, next) => {
  const page = getPageConfig(req.params.type);
  const id = Number(req.params.id);
  if (!page || !id) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  const values = buildValues(page, req.body);
  const missing = page.fields.filter((field) => field.required).filter((field) => !values[field.name]);

  if (missing.length) {
    return renderIndexError(req, res, page, values, res.locals.t("error_required_fields"), "edit");
  }

  try {
    if (page.table === "erp.uom") {
      const existing = await knex(page.table).select("code").where({ id }).first();
      if (existing && existing.code !== values.code) {
        const usedInItems = await knex("erp.items").where({ base_uom_id: id }).first();
        const usedInConversions = await knex("erp.uom_conversions")
          .where({ from_uom_id: id })
          .orWhere({ to_uom_id: id })
          .first();
        if (usedInItems || usedInConversions) {
          return renderIndexError(
            req,
            res,
            page,
            values,
            res.locals.t("error_unit_code_locked"),
            "edit"
          );
        }
      }
    }

    await knex(page.table).where({ id }).update({
      ...values,
      updated_by: req.user ? req.user.id : null,
      updated_at: knex.fn.now(),
    });
    return res.redirect(`/master-data/basic-information/${req.params.type}`);
  } catch (err) {
    return renderIndexError(
      req,
      res,
      page,
      values,
      res.locals.t("error_unable_save"),
      "edit"
    );
  }
});

router.post("/:type/:id/toggle", async (req, res, next) => {
  const page = getPageConfig(req.params.type);
  const id = Number(req.params.id);
  if (!page || !id) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  try {
    const current = await knex(page.table).select("is_active").where({ id }).first();
    if (!current) {
      return next(new HttpError(404, "Record not found"));
    }
    await knex(page.table).where({ id }).update({
      is_active: !current.is_active,
      updated_by: req.user ? req.user.id : null,
      updated_at: knex.fn.now(),
    });
    return res.redirect(`/master-data/basic-information/${req.params.type}`);
  } catch (err) {
    return renderIndexError(req, res, page, {}, res.locals.t("error_update_status"), "delete");
  }
});

router.post("/:type/:id/delete", async (req, res, next) => {
  const page = getPageConfig(req.params.type);
  const id = Number(req.params.id);
  if (!page || !id) {
    return next(new HttpError(404, "Basic information page not found"));
  }

  try {
    await knex(page.table).where({ id }).del();
    return res.redirect(`/master-data/basic-information/${req.params.type}`);
  } catch (err) {
    return renderIndexError(req, res, page, {}, res.locals.t("error_delete"), "delete");
  }
});

module.exports = router;
