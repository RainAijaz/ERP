const express = require("express");
const multer = require("multer");
const {
  requirePermission,
} = require("../../../middleware/access/role-permissions");
const {
  handleScreenApproval,
} = require("../../../middleware/approvals/screen-approval");
const { SCREEN_ENTITY_TYPES } = require("../../../utils/approval-entity-map");
const { queueAuditLog } = require("../../../utils/audit-log");
const { setCookie } = require("../../../middleware/utils/cookies");
const { UI_NOTICE_COOKIE } = require("../../../middleware/core/ui-notice");
const knex = require("../../../db/knex");
const {
  SUPPORTED_IMPORT_TARGETS,
  analyzeWorkbookImport,
  applyWorkbookImport,
  resolveSelectedTargetKeys,
} = require("../../../services/master-data/master-data-import-service");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
});

const toArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return [value];
};

const parseSelectedTargets = (body) =>
  resolveSelectedTargetKeys(
    toArray(body?.targets).map((entry) => String(entry || "").trim()),
  );

const ensureMasterDataImportEntityType = async (db) => {
  await db("erp.entity_type_registry")
    .insert({
      code: "MASTER_DATA_IMPORT",
      name: "Master Data Import",
      description: "Master data import audit activity",
    })
    .onConflict("code")
    .ignore();
};

const buildErrorMessage = (res, err) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return (
      res.locals.t("import_file_too_large") ||
      "The selected file is too large. Maximum allowed size is 20MB."
    );
  }
  return (
    err?.message ||
    res.locals.t("generic_error") ||
    "Something went wrong. Please try again."
  );
};

const renderPage = (req, res, data = {}) => {
  const selectedTargetKeys =
    data.selectedTargetKeys ||
    Object.keys(
      SUPPORTED_IMPORT_TARGETS.reduce((acc, entry) => {
        acc[entry.key] = true;
        return acc;
      }, {}),
    );

  return res.render("base/layouts/main", {
    title: res.locals.t("master_data_import") || "Master Data Import",
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    csrfToken: res.locals.csrfToken,
    view: "../../master_data/import/index",
    t: res.locals.t,
    can: res.locals.can,
    supportedTargets: SUPPORTED_IMPORT_TARGETS,
    selectedTargetKeys,
    importResult: data.importResult || null,
    error: data.error || null,
    lastFileName: data.lastFileName || "",
    applyRequested: Boolean(data.applyRequested),
    isAdminUser: Boolean(req.user?.isAdmin),
  });
};

router.get(
  "/",
  requirePermission("MODULE", "master_data", "navigate"),
  async (req, res) => {
    renderPage(req, res, {
      selectedTargetKeys: resolveSelectedTargetKeys(req.query.targets),
    });
  },
);

router.post(
  "/preview",
  requirePermission("MODULE", "master_data", "navigate"),
  (req, res, next) => {
    upload.single("import_file")(req, res, (err) => {
      if (err) {
        return renderPage(req, res, {
          error: buildErrorMessage(res, err),
          selectedTargetKeys: parseSelectedTargets(req.body),
        });
      }
      return next();
    });
  },
  async (req, res) => {
    try {
      const selectedTargetKeys = parseSelectedTargets(req.body);
      if (!req.file?.buffer) {
        return renderPage(req, res, {
          error:
            res.locals.t("import_file_required") ||
            "Please choose an Excel file before running preview.",
          selectedTargetKeys,
        });
      }

      const importResult = await analyzeWorkbookImport({
        db: knex,
        workbookBuffer: req.file.buffer,
        selectedTargets: selectedTargetKeys,
        actorId: req.user?.id || null,
      });

      return renderPage(req, res, {
        importResult,
        selectedTargetKeys,
        lastFileName: req.file.originalname || "",
      });
    } catch (err) {
      console.error("Error in MasterDataImportPreviewService:", err);
      return renderPage(req, res, {
        error: buildErrorMessage(res, err),
        selectedTargetKeys: parseSelectedTargets(req.body),
      });
    }
  },
);

router.post(
  "/apply",
  requirePermission("MODULE", "master_data", "navigate"),
  (req, res, next) => {
    upload.single("import_file")(req, res, (err) => {
      if (err) {
        return renderPage(req, res, {
          error: buildErrorMessage(res, err),
          selectedTargetKeys: parseSelectedTargets(req.body),
          applyRequested: true,
        });
      }
      return next();
    });
  },
  async (req, res) => {
    const selectedTargetKeys = parseSelectedTargets(req.body);
    const originalName = req.file?.originalname || "";

    try {
      await ensureMasterDataImportEntityType(knex);

      if (!req.file?.buffer) {
        return renderPage(req, res, {
          error:
            res.locals.t("import_file_required") ||
            "Please choose an Excel file before applying import.",
          selectedTargetKeys,
          applyRequested: true,
        });
      }

      const preview = await analyzeWorkbookImport({
        db: knex,
        workbookBuffer: req.file.buffer,
        selectedTargets: selectedTargetKeys,
        actorId: req.user?.id || null,
      });

      if (preview.summary.errorCount > 0) {
        return renderPage(req, res, {
          error:
            res.locals.t("import_fix_errors_first") ||
            "Please fix all validation errors in dry-run before applying import.",
          selectedTargetKeys,
          importResult: preview,
          lastFileName: originalName,
          applyRequested: true,
        });
      }

      if (!req.user?.isAdmin) {
        await handleScreenApproval({
          req,
          scopeKey: "master_data.import",
          action: "create",
          entityType:
            SCREEN_ENTITY_TYPES["master_data.import"] || "MASTER_DATA_IMPORT",
          entityId: "NEW",
          summary: `${res.locals.t("master_data_import") || "Master Data Import"}: ${originalName || "Excel"}`,
          oldValue: null,
          newValue: {
            _action: "import_master_data",
            file_name: originalName || null,
            selected_targets: selectedTargetKeys,
            summary: preview.summary,
            sample_errors: preview.errors.slice(0, 50),
          },
          t: res.locals.t,
          forceQueue: true,
        });
        return res.redirect("/master-data/import");
      }

      const applied = await applyWorkbookImport({
        db: knex,
        workbookBuffer: req.file.buffer,
        selectedTargets: selectedTargetKeys,
        actorId: req.user?.id || null,
        branchId: req.branchId || null,
        ipAddress: req.ip || null,
      });

      queueAuditLog(req, {
        entityType:
          SCREEN_ENTITY_TYPES["master_data.import"] || "MASTER_DATA_IMPORT",
        entityId: `IMPORT_${Date.now()}`,
        action: "CREATE",
        context: {
          file_name: originalName || null,
          selected_targets: selectedTargetKeys,
          summary: applied.summary,
        },
      });

      setCookie(
        res,
        UI_NOTICE_COOKIE,
        JSON.stringify({
          message:
            res.locals.t("import_apply_success") ||
            "Master data import applied successfully.",
          autoClose: true,
          sticky: false,
        }),
        { path: "/", maxAge: 30, sameSite: "Lax" },
      );

      return res.redirect("/master-data/import");
    } catch (err) {
      console.error("Error in MasterDataImportApplyService:", err);

      const analysis = err?.analysis || null;
      if (analysis) {
        return renderPage(req, res, {
          error:
            res.locals.t("import_fix_errors_first") ||
            "Please fix all validation errors in dry-run before applying import.",
          selectedTargetKeys,
          importResult: analysis,
          lastFileName: originalName,
          applyRequested: true,
        });
      }

      return renderPage(req, res, {
        error: buildErrorMessage(res, err),
        selectedTargetKeys,
        lastFileName: originalName,
        applyRequested: true,
      });
    }
  },
);

module.exports = router;
