const express = require("express");
const knex = require("../../../db/knex");
const { HttpError } = require("../../../middleware/errors/http-error");
const { requirePermission } = require("../../../middleware/access/role-permissions");
const { handleScreenApproval } = require("../../../middleware/approvals/screen-approval");
const { getBasicInfoEntityType } = require("../../../utils/approval-entity-map");
const { setCookie } = require("../../../middleware/utils/cookies");
const { friendlyErrorMessage } = require("../../../middleware/errors/friendly-error");

const router = express.Router();

// Pull conversion rows with human-friendly UOM labels.
const fetchRows = () =>
  knex({ c: "erp.uom_conversions" })
    .leftJoin({ uf: "erp.uom" }, "c.from_uom_id", "uf.id")
    .leftJoin({ ut: "erp.uom" }, "c.to_uom_id", "ut.id")
    .leftJoin({ u: "erp.users" }, "c.created_by", "u.id")
    .leftJoin({ uu: "erp.users" }, "c.updated_by", "uu.id")
    .select("c.id", "c.from_uom_id", "c.to_uom_id", "c.factor", "c.is_active", "c.created_at", "c.updated_at", "uf.code as from_code", "uf.name as from_name", "ut.code as to_code", "ut.name as to_name", "u.username as created_by_name", "uu.username as updated_by_name")
    .orderBy("c.id", "desc");

// Only active UOMs are selectable for new conversions.
const fetchUoms = () => knex("erp.uom").select("id", "code", "name").where({ is_active: true }).orderBy("code", "asc");

const renderPage = (req, res, data) =>
  res.render("base/layouts/main", {
    title: `${res.locals.t("uom_conversions")} - ${res.locals.t("basic_information")}`,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view: "../../master_data/basic-info/uom-conversions/index",
    t: res.locals.t,
    basePath: "/master-data/basic-info/uom-conversions",
    ...data,
  });

router.get("/", requirePermission("SCREEN", "master_data.basic_info.uom_conversions", "view"), async (req, res, next) => {
  try {
    const canBrowse = res.locals.can("SCREEN", "master_data.basic_info.uom_conversions", "navigate");
    const [rows, uoms] = await Promise.all([canBrowse ? fetchRows() : [], fetchUoms()]);
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
  const message = friendlyErrorMessage(error, res.locals.t);
  const shouldOpenModal = modalMode !== "delete";
  if (modalMode === "delete") {
    setCookie(res, "ui_error", JSON.stringify({ message }), {
      path: "/",
      maxAge: 30,
      sameSite: "Lax",
    });
  }
  const [rows, uoms] = await Promise.all([fetchRows(), fetchUoms()]);
  return renderPage(req, res, {
    rows,
    uoms,
    error: message,
    modalOpen: shouldOpenModal,
    modalMode: shouldOpenModal ? modalMode : "create",
  });
};

router.post("/", requirePermission("SCREEN", "master_data.basic_info.uom_conversions", "navigate"), async (req, res, next) => {
  const payload = normalizePayload(req.body || {});
  if (!payload.from_uom_id || !payload.to_uom_id || payload.factor <= 0) {
    return renderError(req, res, res.locals.t("error_required_fields"), "create");
  }

  try {
    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.basic_info.uom_conversions",
      action: "create",
      entityType: getBasicInfoEntityType("uom-conversions"),
      entityId: "NEW",
      summary: `${res.locals.t("create")} ${res.locals.t("uom_conversions")}`,
      oldValue: null,
      newValue: payload,
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }
    await knex("erp.uom_conversions").insert({
      ...payload,
      created_by: req.user ? req.user.id : null,
    });
    return res.redirect("/master-data/basic-info/uom-conversions");
  } catch (err) {
    return renderError(req, res, err?.message || res.locals.t("error_unable_save"), "create");
  }
});

router.post("/:id", requirePermission("SCREEN", "master_data.basic_info.uom_conversions", "navigate"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) {
    return next(new HttpError(404, res.locals.t("error_not_found")));
  }

  const payload = normalizePayload(req.body || {});
  if (!payload.from_uom_id || !payload.to_uom_id || payload.factor <= 0) {
    return renderError(req, res, res.locals.t("error_required_fields"), "edit");
  }

  try {
    const existing = await knex("erp.uom_conversions").where({ id }).first();
    if (!existing) {
      return renderError(req, res, res.locals.t("error_not_found"), "edit");
    }
    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.basic_info.uom_conversions",
      action: "edit",
      entityType: getBasicInfoEntityType("uom-conversions"),
      entityId: id,
      summary: `${res.locals.t("edit")} ${res.locals.t("uom_conversions")}`,
      oldValue: existing,
      newValue: payload,
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }
    await knex("erp.uom_conversions")
      .where({ id })
      .update({
        ...payload,
        updated_by: req.user ? req.user.id : null,
        updated_at: knex.fn.now(),
      });
    return res.redirect("/master-data/basic-info/uom-conversions");
  } catch (err) {
    return renderError(req, res, err?.message || res.locals.t("error_unable_save"), "edit");
  }
});

router.post("/:id/toggle", requirePermission("SCREEN", "master_data.basic_info.uom_conversions", "delete"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) {
    return next(new HttpError(404, res.locals.t("error_not_found")));
  }

  try {
    const current = await knex("erp.uom_conversions").select("is_active").where({ id }).first();
    if (!current) {
      return next(new HttpError(404, res.locals.t("error_not_found")));
    }
    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.basic_info.uom_conversions",
      action: "delete",
      entityType: getBasicInfoEntityType("uom-conversions"),
      entityId: id,
      summary: `${res.locals.t("deactivate")} ${res.locals.t("uom_conversions")}`,
      oldValue: current,
      newValue: { is_active: !current.is_active },
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }
    await knex("erp.uom_conversions")
      .where({ id })
      .update({
        is_active: !current.is_active,
        updated_by: req.user ? req.user.id : null,
        updated_at: knex.fn.now(),
      });
    return res.redirect("/master-data/basic-info/uom-conversions");
  } catch (err) {
    return renderError(req, res, err?.message || res.locals.t("error_update_status"), "delete");
  }
});

router.post("/:id/delete", requirePermission("SCREEN", "master_data.basic_info.uom_conversions", "hard_delete"), async (req, res, next) => {
  const id = Number(req.params.id);
  if (!id) {
    return next(new HttpError(404, res.locals.t("error_not_found")));
  }

  try {
    const existing = await knex("erp.uom_conversions").where({ id }).first();
    if (!existing) {
      return renderError(req, res, res.locals.t("error_not_found"), "delete");
    }
    const approval = await handleScreenApproval({
      req,
      scopeKey: "master_data.basic_info.uom_conversions",
      action: "delete",
      entityType: getBasicInfoEntityType("uom-conversions"),
      entityId: id,
      summary: `${res.locals.t("delete")} ${res.locals.t("uom_conversions")}`,
      oldValue: existing,
      newValue: null,
      t: res.locals.t,
    });

    if (approval.queued) {
      return res.redirect(req.get("referer") || basePath);
    }
    await knex("erp.uom_conversions").where({ id }).del();
    return res.redirect("/master-data/basic-info/uom-conversions");
  } catch (err) {
    return renderError(req, res, err?.message || res.locals.t("error_delete"), "delete");
  }
});

module.exports = router;
