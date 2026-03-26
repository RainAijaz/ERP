const express = require("express");
const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { requirePermission } = require("../../middleware/access/role-permissions");
const { handleScreenApproval } = require("../../middleware/approvals/screen-approval");
const { parseCookies, setCookie } = require("../../middleware/utils/cookies");
const { friendlyErrorMessage } = require("../../middleware/errors/friendly-error");
const { queueAuditLog } = require("../../utils/audit-log");
const { generateUniqueCode } = require("../../utils/entity-code");
const { buildAuditChangeSet } = require("../../utils/audit-diff");

const ACTIVE_OPTION_TABLES = new Set(["erp.branches", "erp.departments"]);

const hasField = (page, name) => page.fields.some((field) => field.name === name);
const parseList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === "object")
    return Object.values(value)
      .map((entry) => String(entry).trim())
      .filter(Boolean);
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};
const normalizeMode = (value) => (String(value || "").toLowerCase() === "exclude" ? "exclude" : "include");

const sanitizeFilterValues = (filterConfig, values) => {
  const rawValues = Array.isArray(values) ? values : [];
  if (!rawValues.length) return [];

  if (filterConfig?.valueType === "number") {
    return rawValues
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  return rawValues
    .map((value) => String(value || "").trim())
    .filter(Boolean);
};
const getAllowedBranchIds = (req) => {
  if (req?.user?.isAdmin) return [];
  return Array.isArray(req?.branchScope) ? req.branchScope.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0) : [];
};
const filterBranchOptionsByScope = (field, options, req) => {
  if (!Array.isArray(options)) return [];
  if (req?.user?.isAdmin) return options;
  const isBranchField = field?.optionsQuery?.table === "erp.branches" || field?.name === "branch_id" || field?.name === "branch_ids";
  if (!isBranchField) return options;
  const allowed = new Set(getAllowedBranchIds(req));
  return options.filter((option) => allowed.has(Number(option?.value)));
};
const normalizeValidationError = (validationError) => {
  if (!validationError) return null;
  if (typeof validationError === "string") {
    return { message: validationError, fieldErrors: {} };
  }
  if (typeof validationError === "object") {
    const message = validationError.message || "";
    const field = validationError.field || null;
    const fieldErrors = validationError.fieldErrors && typeof validationError.fieldErrors === "object" ? validationError.fieldErrors : {};
    if (field && message) fieldErrors[field] = message;
    return { message, fieldErrors };
  }
  return { message: String(validationError), fieldErrors: {} };
};
const isEmployeesDebugEnabled = (pageConfig) => process.env.DEBUG_HR_EMPLOYEES === "1" && pageConfig?.scopeKey === "hr_payroll.employees";
const logEmployeeDebug = (pageConfig, req, event, payload = {}) => {
  if (!isEmployeesDebugEnabled(pageConfig)) return;
  console.log("[hr-employees-debug]", {
    event,
    path: req?.originalUrl || req?.url || "",
    method: req?.method || "",
    userId: req?.user?.id || null,
    username: req?.user?.username || null,
    ...payload,
  });
};
const isLabourRatesSaveDebugEnabled = (pageConfig) => pageConfig?.scopeKey === "hr_payroll.labour_rates";
const logLabourRatesSaveDebug = (pageConfig, req, event, payload = {}) => {
  if (!isLabourRatesSaveDebugEnabled(pageConfig)) return;
  console.log("[hr-labour-rates-save-debug]", {
    event,
    path: req?.originalUrl || req?.url || "",
    method: req?.method || "",
    userId: req?.user?.id || null,
    username: req?.user?.username || null,
    ...payload,
  });
};
const isHrValidationDebugEnabled = () => process.env.DEBUG_HR_VALIDATION === "1";
const summarizeValueForLog = (value) => {
  if (Array.isArray(value)) return { type: "array", count: value.length };
  if (value === null || value === undefined || value === "") return { type: "empty" };
  if (typeof value === "string") return { type: "string", length: value.length };
  if (typeof value === "number") return { type: "number", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "object") return { type: "object", keys: Object.keys(value) };
  return { type: typeof value };
};
const summarizeFieldsForLog = (values, fieldNames = []) =>
  fieldNames.reduce((acc, name) => {
    acc[name] = summarizeValueForLog(values ? values[name] : undefined);
    return acc;
  }, {});
const logHrValidationDebug = (pageConfig, req, event, payload = {}) => {
  if (!isHrValidationDebugEnabled()) return;
  console.error("[hr-validation-debug]", {
    scopeKey: pageConfig?.scopeKey || null,
    event,
    path: req?.originalUrl || req?.url || "",
    method: req?.method || "",
    userId: req?.user?.id || null,
    username: req?.user?.username || null,
    ...payload,
  });
};

const hydratePage = async (pageConfig, locale, req = null) => {
  const fields = await Promise.all(
    pageConfig.fields.map(async (field) => {
      if (typeof field.optionsResolver === "function") {
        const resolved = await field.optionsResolver({
          knex,
          req,
          locale,
          pageConfig,
        });
        return {
          ...field,
          options: filterBranchOptionsByScope(field, Array.isArray(resolved) ? resolved : [], req),
        };
      }
      if (!field.optionsQuery) {
        return field;
      }
      const selectFields = field.optionsQuery.select || [field.optionsQuery.valueKey, field.optionsQuery.labelKey];
      let query = knex(field.optionsQuery.table).select(selectFields);
      if (Array.isArray(field.optionsQuery.joins)) {
        field.optionsQuery.joins.forEach((join) => {
          query = query.leftJoin(join.table, join.on[0], join.on[1]);
        });
      }
      if (field.optionsQuery.activeOnly !== false && ACTIVE_OPTION_TABLES.has(field.optionsQuery.table)) {
        query = query.where({ is_active: true });
      }
      if (field.optionsQuery.where) {
        query = query.where(field.optionsQuery.where);
      }
      if (field.optionsQuery.whereRaw) {
        if (Array.isArray(field.optionsQuery.whereRaw)) {
          query = query.whereRaw(field.optionsQuery.whereRaw[0], field.optionsQuery.whereRaw.slice(1));
        } else {
          query = query.whereRaw(field.optionsQuery.whereRaw);
        }
      }
      const rows = await query.orderBy(field.optionsQuery.orderBy || field.optionsQuery.labelKey);
      return {
        ...field,
        options: filterBranchOptionsByScope(
          field,
          rows.map((row) => {
            const labelRaw = field.labelFormat ? field.labelFormat(row, locale) : row[field.optionsQuery.labelKey];
            const labelUr = !field.labelFormat && locale === "ur" && row.name_ur ? row.name_ur : null;
            return {
              value: row[field.optionsQuery.valueKey],
              label: labelUr || labelRaw,
            };
          }),
          req,
        ),
      };
    }),
  );
  return { ...pageConfig, fields };
};

const applyAllowedBranchScopeToQuery = (query, pageConfig, allowedBranchIds) => {
  if (!Array.isArray(allowedBranchIds) || !allowedBranchIds.length) return query;
  if (pageConfig.branchScoped && pageConfig.branchMap) {
    return query.whereExists(function allowedBranchScope() {
      this.select(1)
        .from(pageConfig.branchMap.table)
        .whereRaw(`${pageConfig.branchMap.table}.${pageConfig.branchMap.key} = t.id`)
        .whereIn(`${pageConfig.branchMap.table}.${pageConfig.branchMap.branchKey}`, allowedBranchIds);
    });
  }
  if (pageConfig.branchFilter?.mapTable && pageConfig.branchFilter?.mapKey && pageConfig.branchFilter?.entityKey) {
    const { mapTable, mapKey, entityKey, branchKey = "branch_id" } = pageConfig.branchFilter;
    return query.whereExists(function allowedBranchScope() {
      this.select(1)
        .from(mapTable)
        .whereRaw(`${mapTable}.${mapKey} = t.${entityKey}`)
        .whereIn(`${mapTable}.${branchKey}`, allowedBranchIds);
    });
  }
  return query;
};

const fetchRows = (pageConfig, options = {}) => {
  let query = knex({ t: pageConfig.table });
  if (pageConfig.joins) {
    pageConfig.joins.forEach((join) => {
      query = query.leftJoin(join.table, join.on[0], join.on[1]);
    });
  }

  const allowedBranchIds = Array.isArray(options.allowedBranchIds) ? options.allowedBranchIds : [];
  query = applyAllowedBranchScopeToQuery(query, pageConfig, allowedBranchIds);

  if (pageConfig.branchScoped && options.branchId) {
    query = query.whereExists(function () {
      this.select(1).from(pageConfig.branchMap.table).whereRaw(`${pageConfig.branchMap.table}.${pageConfig.branchMap.key} = t.id`).andWhere(`${pageConfig.branchMap.table}.${pageConfig.branchMap.branchKey}`, options.branchId);
    });
  }

  const filters = options.filters || {};
  const primary = pageConfig.filterConfig?.primary;
  const secondary = pageConfig.filterConfig?.secondary;
  const tertiary = pageConfig.filterConfig?.tertiary;
  const primaryValues = sanitizeFilterValues(primary, filters.primaryValues);
  const secondaryValues = sanitizeFilterValues(secondary, filters.secondaryValues);
  const tertiaryValues = sanitizeFilterValues(tertiary, filters.tertiaryValues);
  const rawBranchIds = Array.isArray(filters.branchValues) ? filters.branchValues.map((value) => Number(value)).filter((value) => Number.isFinite(value)) : [];
  const allowedSet = allowedBranchIds.length ? new Set(allowedBranchIds) : null;
  const branchIds = allowedSet ? rawBranchIds.filter((id) => allowedSet.has(id)) : rawBranchIds;
  if (primary && primaryValues.length) {
    if (filters.primaryMode === "exclude") {
      query = query.whereNotIn(primary.dbColumn, primaryValues);
    } else {
      query = query.whereIn(primary.dbColumn, primaryValues);
    }
  }
  if (secondary && secondaryValues.length) {
    if (filters.secondaryMode === "exclude") {
      query = query.whereNotIn(secondary.dbColumn, secondaryValues);
    } else {
      query = query.whereIn(secondary.dbColumn, secondaryValues);
    }
  }
  if (tertiary && tertiaryValues.length) {
    if (filters.tertiaryMode === "exclude") {
      query = query.whereNotIn(tertiary.dbColumn, tertiaryValues);
    } else {
      query = query.whereIn(tertiary.dbColumn, tertiaryValues);
    }
  }
  if (branchIds.length) {
    if (pageConfig.branchScoped && pageConfig.branchMap) {
      if (filters.branchMode === "exclude") {
        query = query.whereNotExists(function () {
          this.select(1).from(pageConfig.branchMap.table).whereRaw(`${pageConfig.branchMap.table}.${pageConfig.branchMap.key} = t.id`).whereIn(`${pageConfig.branchMap.table}.${pageConfig.branchMap.branchKey}`, branchIds);
        });
      } else {
        query = query.whereExists(function () {
          this.select(1).from(pageConfig.branchMap.table).whereRaw(`${pageConfig.branchMap.table}.${pageConfig.branchMap.key} = t.id`).whereIn(`${pageConfig.branchMap.table}.${pageConfig.branchMap.branchKey}`, branchIds);
        });
      }
    } else if (pageConfig.branchFilter?.mapTable && pageConfig.branchFilter?.mapKey && pageConfig.branchFilter?.entityKey) {
      const { mapTable, mapKey, entityKey, branchKey = "branch_id" } = pageConfig.branchFilter;
      if (filters.branchMode === "exclude") {
        query = query.whereNotExists(function () {
          this.select(1).from(mapTable).whereRaw(`${mapTable}.${mapKey} = t.${entityKey}`).whereIn(`${mapTable}.${branchKey}`, branchIds);
        });
      } else {
        query = query.whereExists(function () {
          this.select(1).from(mapTable).whereRaw(`${mapTable}.${mapKey} = t.${entityKey}`).whereIn(`${mapTable}.${branchKey}`, branchIds);
        });
      }
    }
  }

  if (typeof pageConfig.applyExtraFilters === "function") {
    query = pageConfig.applyExtraFilters(query, {
      filters,
      knex,
      pageConfig,
      locale: options.locale || "en",
    });
  }

  const selects = ["t.*"];
  let extraSelect = pageConfig.extraSelect ? (typeof pageConfig.extraSelect === "function" ? pageConfig.extraSelect(options.locale || "en") : pageConfig.extraSelect) : [];
  if (!Array.isArray(extraSelect)) {
    extraSelect = [extraSelect];
  }
  if (extraSelect.length) {
    selects.push(...extraSelect);
  }
  const limitedQuery = query.select(selects).orderBy("t.id", "desc");
  const maxRows = Number(options.maxRows || 0);
  if (Number.isInteger(maxRows) && maxRows > 0) {
    return limitedQuery.limit(maxRows);
  }
  return limitedQuery;
};

const buildValues = (pageConfig, body) =>
  pageConfig.fields.reduce((acc, field) => {
    if (field.type === "checkbox") {
      acc[field.name] = body[field.name] === "on";
      return acc;
    }
    if (field.type === "multi-select" || field.type === "multi-checkbox") {
      const value = body[field.name];
      if (Array.isArray(value)) {
        acc[field.name] = value.map(String);
      } else if (value && typeof value === "object") {
        acc[field.name] = Object.values(value).map(String);
      } else {
        acc[field.name] = value ? [String(value)] : [];
      }
      return acc;
    }
    if (field.type === "select") {
      const rawValue = body[field.name];
      if (field.multiple === true) {
        if (Array.isArray(rawValue)) {
          acc[field.name] = rawValue.map((value) => String(value || "").trim()).filter(Boolean);
          return acc;
        }
        if (rawValue && typeof rawValue === "object") {
          acc[field.name] = Object.values(rawValue).map((value) => String(value || "").trim()).filter(Boolean);
          return acc;
        }
        const single = String(rawValue || "").trim();
        acc[field.name] = single ? [single] : [];
        return acc;
      }
      const value = String(rawValue || "").trim();
      acc[field.name] = value === "" ? null : value;
      return acc;
    }
    if (field.type === "number") {
      const value = (body[field.name] || "").trim();
      acc[field.name] = value === "" ? null : value;
      return acc;
    }
    acc[field.name] = (body[field.name] || "").trim();
    return acc;
  }, {});

const normalizeMultiMapValues = (pageConfig, values = {}) => {
  const multiMaps = Array.isArray(pageConfig.multiMaps) ? pageConfig.multiMaps : [];
  const persistedValues = { ...values };
  const mapValues = {};
  multiMaps.forEach((mapConfig) => {
    if (!mapConfig?.fieldName) return;
    const raw = values[mapConfig.fieldName];
    const entries = Array.isArray(raw) ? raw.map((entry) => String(entry).trim()).filter(Boolean) : [];
    mapValues[mapConfig.fieldName] = entries;
    delete persistedValues[mapConfig.fieldName];
  });
  return { persistedValues, mapValues };
};

const clearFlash = (res, cookieName, path) => {
  setCookie(res, cookieName, "", { path, maxAge: 0, sameSite: "Lax" });
};

const readFlash = (req, res, cookieName, path) => {
  const cookies = parseCookies(req);
  if (!cookies[cookieName]) return null;
  let payload = null;
  try {
    payload = JSON.parse(cookies[cookieName]);
  } catch (err) {
    payload = null;
  }
  clearFlash(res, cookieName, path);
  return payload;
};

const renderIndexError = async (req, res, values, error, modalMode, basePath, cookieName, fieldErrors = {}) => {
  const message = friendlyErrorMessage(error, res.locals.t);
  if (process.env.DEBUG_HR_VALIDATION === "1") {
    console.error("[hr-validation-debug]", {
      scopeKey: req.baseUrl || null,
      event: "render_index_error",
      path: req?.originalUrl || req?.url || "",
      method: req?.method || "",
      userId: req?.user?.id || null,
      username: req?.user?.username || null,
      modalMode,
      message,
      fieldErrorKeys: Object.keys(fieldErrors || {}),
      valueKeys: Object.keys(values || {}),
    });
  }
  const payload = { values, error: message, modalMode, fieldErrors };
  setCookie(res, cookieName, JSON.stringify(payload), {
    path: req.baseUrl,
    maxAge: 60,
    sameSite: "Lax",
  });
  if (modalMode === "delete") {
    setCookie(
      res,
      "ui_error",
      JSON.stringify({
        message,
      }),
      {
        path: "/",
        maxAge: 30,
        sameSite: "Lax",
      },
    );
  }
  return res.redirect(basePath);
};

const renderInfoScreen = (req, res, data) =>
  res.render("base/layouts/main", {
    title: `${res.locals.t(data.titleKey)} - ${res.locals.t("hr_payroll")}`,
    user: req.user,
    branchId: req.branchId,
    branchScope: req.branchScope,
    isAdmin: req.user?.isAdmin || false,
    csrfToken: res.locals.csrfToken,
    view: "../../hr_payroll/info",
    t: res.locals.t,
    info: data,
  });

const createHrMasterRouter = (pageConfig) => {
  const router = express.Router();
  const flashCookie = `hr_${pageConfig.scopeKey.replace(/\./g, "_")}_flash`;

  const renderPage = (req, res, hydrated, data) =>
    res.render("base/layouts/main", {
      title: `${res.locals.t(hydrated.titleKey)} - ${res.locals.t("hr_payroll")}`,
      user: req.user,
      branchId: req.branchId,
      branchScope: req.branchScope,
      isAdmin: req.user?.isAdmin || false,
      csrfToken: res.locals.csrfToken,
      view: "../../hr_payroll/index",
      t: res.locals.t,
      page: hydrated,
      ...data,
    });

  router.get("/", requirePermission("SCREEN", pageConfig.scopeKey, "view"), async (req, res, next) => {
    try {
      const hydrated = await hydratePage(pageConfig, req.locale, req);
      const flash = readFlash(req, res, flashCookie, req.baseUrl);
      const modalMode = flash ? flash.modalMode : "create";
      const modalOpen = flash ? ["create", "edit"].includes(modalMode) : false;
      const allowedBranchIds = getAllowedBranchIds(req);
      const allowedBranchSet = allowedBranchIds.length ? new Set(allowedBranchIds) : null;
      const fieldErrors = flash?.fieldErrors || {};
      const primaryValues = parseList(req.query.primary_value);
      const secondaryValues = parseList(req.query.secondary_value);
      const branchValues = parseList(req.query.branch_id).filter((value) => {
        if (!allowedBranchSet) return true;
        return allowedBranchSet.has(Number(value));
      });
      const tertiaryValues = parseList(req.query.tertiary_value);
      const applyOnValues = parseList(req.query.apply_on).map((value) => String(value || "").trim().toUpperCase()).filter(Boolean);
      const subgroupValues = parseList(req.query.subgroup_id);
      const groupValues = parseList(req.query.group_id);
      const articleTypeValues = parseList(req.query.article_type).map((value) => String(value || "").trim().toUpperCase()).filter(Boolean);
      const rateViewRaw = String(req.query.rate_view || "").trim().toUpperCase();
      const rateView = rateViewRaw === "PER_PAIR" ? "PER_PAIR" : "PER_DOZEN";
      const applyOnMode = normalizeMode(req.query.apply_on_mode);
      const subgroupMode = normalizeMode(req.query.subgroup_mode);
      const groupMode = normalizeMode(req.query.group_mode);
      const articleTypeMode = normalizeMode(req.query.article_type_mode);
      const primaryMode = normalizeMode(req.query.primary_mode);
      const secondaryMode = normalizeMode(req.query.secondary_mode);
      const branchMode = normalizeMode(req.query.branch_mode);
      const tertiaryMode = normalizeMode(req.query.tertiary_mode);
      const primaryFilter = pageConfig.filterConfig?.primary;
      const secondaryFilter = pageConfig.filterConfig?.secondary;
      const tertiaryFilter = pageConfig.filterConfig?.tertiary;
      const getOptionsForFilter = async (config) => {
        if (!config) return [];
        if (typeof config.optionsResolver === "function") {
          const resolved = await config.optionsResolver({
            knex,
            req,
            locale: req.locale,
            hydrated,
            pageConfig,
          });
          return Array.isArray(resolved) ? resolved : [];
        }
        if (Array.isArray(config.options)) return config.options;
        const field = hydrated.fields.find((entry) => entry.name === config.fieldName);
        return Array.isArray(field?.options) ? field.options : [];
      };
      const [primaryOptions, secondaryOptions, tertiaryOptions] = await Promise.all([getOptionsForFilter(primaryFilter), getOptionsForFilter(secondaryFilter), getOptionsForFilter(tertiaryFilter)]);
      const filterConfig = {
        primary: primaryFilter
          ? {
              key: primaryFilter.key,
              label: primaryFilter.label,
              options: primaryOptions,
            }
          : null,
        secondary: secondaryFilter
          ? {
              key: secondaryFilter.key,
              label: secondaryFilter.label,
              options: secondaryOptions,
            }
          : null,
        tertiary: tertiaryFilter
          ? {
              key: tertiaryFilter.key,
              label: tertiaryFilter.label,
              options: tertiaryOptions,
            }
          : null,
      };
      const canBrowse = res.locals.can("SCREEN", pageConfig.scopeKey, "navigate");
      const requiredFilters = Array.isArray(pageConfig.listScopeRequiredFilters) ? pageConfig.listScopeRequiredFilters : [];
      const missingRequiredFilters = requiredFilters.filter((required) => {
        if (required === "primary") return !primaryValues.length;
        if (required === "secondary") return !secondaryValues.length;
        if (required === "tertiary") return !tertiaryValues.length;
        if (required === "branch") return !branchValues.length;
        return false;
      });
      const rows =
        canBrowse && !missingRequiredFilters.length
          ? await fetchRows(hydrated, {
              branchId: req.user?.isAdmin ? null : req.branchId,
              allowedBranchIds,
              locale: req.locale,
              maxRows: hydrated.maxRows || 0,
              filters: {
                primaryValues,
                secondaryValues,
                branchValues,
                tertiaryValues,
                applyOnValues,
                subgroupValues,
                groupValues,
                articleTypeValues,
                applyOnMode,
                subgroupMode,
                groupMode,
                articleTypeMode,
                primaryMode,
                secondaryMode,
                branchMode,
                tertiaryMode,
              },
            })
          : [];
      const basePath = req.baseUrl;
      const defaults = { ...(hydrated.defaults || {}) };
      const listScopeMessage =
        missingRequiredFilters.length && pageConfig.listScopeRequiredMessageKey
          ? res.locals.t(pageConfig.listScopeRequiredMessageKey)
          : null;
      return renderPage(req, res, hydrated, {
        rows,
        branches: req.branchOptions || [],
        filterConfig,
        filters: {
          primary_value: primaryValues,
          primary_mode: primaryMode,
          secondary_value: secondaryValues,
          secondary_mode: secondaryMode,
          branch_id: branchValues,
          branch_mode: branchMode,
          tertiary_value: tertiaryValues,
          tertiary_mode: tertiaryMode,
          apply_on: applyOnValues,
          apply_on_mode: applyOnMode,
          subgroup_id: subgroupValues,
          subgroup_mode: subgroupMode,
          group_id: groupValues,
          group_mode: groupMode,
          article_type: articleTypeValues,
          article_type_mode: articleTypeMode,
          rate_view: rateView,
        },
        basePath,
        values: flash ? flash.values : defaults,
        error: flash ? flash.error : null,
        fieldErrors,
        modalOpen,
        modalMode,
        listScopeMessage,
        listScopeBlocked: missingRequiredFilters.length > 0,
      });
    } catch (err) {
      console.error("[hr-master:get]", { scopeKey: pageConfig.scopeKey, error: err.message });
      return next(err);
    }
  });

  router.post("/", requirePermission("SCREEN", pageConfig.scopeKey, "create"), async (req, res, next) => {
    const values = buildValues(pageConfig, req.body);
    const basePath = req.baseUrl;
    const sanitizedValues = pageConfig.sanitizeValues ? pageConfig.sanitizeValues(values, req) : values;
    logHrValidationDebug(pageConfig, req, "create:request_received", {
      bodyKeys: Object.keys(req.body || {}),
      valueKeys: Object.keys(sanitizedValues || {}),
    });
    const traceId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    logEmployeeDebug(pageConfig, req, "create:start", {
      traceId,
      bodyKeys: Object.keys(req.body || {}),
      valueKeys: Object.keys(sanitizedValues || {}),
    });
    if (pageConfig.disableCreate) {
      logEmployeeDebug(pageConfig, req, "create:disabled", { traceId });
      return renderIndexError(req, res, sanitizedValues, res.locals.t("error_action_not_allowed"), "create", basePath, flashCookie);
    }
    if (hasField(pageConfig, "status")) {
      sanitizedValues.status = "active";
    }

    if (!hasField(pageConfig, "code") && !pageConfig.autoCodeFromName) {
      delete sanitizedValues.code;
    }

    const missing = pageConfig.fields
      .filter((field) => field.required)
      .filter((field) => {
        const value = sanitizedValues[field.name];
        return value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length);
      });
    if (missing.length) {
      logHrValidationDebug(pageConfig, req, "create:missing_required", {
        missingFields: missing.map((f) => f.name),
        requiredFieldSummary: summarizeFieldsForLog(
          sanitizedValues,
          pageConfig.fields.filter((field) => field.required).map((field) => field.name),
        ),
      });
      logEmployeeDebug(pageConfig, req, "create:missing_required", {
        traceId,
        missing: missing.map((f) => f.name),
      });
      const missingMap = missing.reduce((acc, field) => {
        acc[field.name] = res.locals.t("error_required_fields");
        return acc;
      }, {});
      return renderIndexError(req, res, sanitizedValues, res.locals.t("error_required_fields"), "create", basePath, flashCookie, missingMap);
    }

    try {
      if (pageConfig.validateValues) {
        const validationError = await pageConfig.validateValues({ values: sanitizedValues, req, isUpdate: false, knex });
        if (validationError) {
          const normalized = normalizeValidationError(validationError);
          logHrValidationDebug(pageConfig, req, "create:validation_error", {
            validationMessage: normalized?.message || String(validationError || ""),
            fieldErrorKeys: Object.keys(normalized?.fieldErrors || {}),
            requiredFieldSummary: summarizeFieldsForLog(
              sanitizedValues,
              pageConfig.fields.filter((field) => field.required).map((field) => field.name),
            ),
          });
          logEmployeeDebug(pageConfig, req, "create:validation_error", {
            traceId,
            validationError,
          });
          return renderIndexError(req, res, sanitizedValues, normalized.message || validationError, "create", basePath, flashCookie, normalized.fieldErrors);
        }
      }

      if (hasField(pageConfig, "code") || pageConfig.autoCodeFromName) {
        sanitizedValues.code = await generateUniqueCode({
          name: sanitizedValues.name,
          prefix: pageConfig.codePrefix || pageConfig.entityType || "",
          maxLen: 50,
          knex,
          table: pageConfig.table,
        });
      }

      const codeValue = sanitizedValues.code || "";
      const nameValue = sanitizedValues.name || "";
      if (codeValue && (await knex(pageConfig.table).whereRaw("lower(code) = ?", [codeValue.toLowerCase()]).first())) {
        logEmployeeDebug(pageConfig, req, "create:duplicate_code", {
          traceId,
          codeValue,
        });
        return renderIndexError(req, res, sanitizedValues, res.locals.t("error_duplicate_code"), "create", basePath, flashCookie, {
          code: res.locals.t("error_duplicate_code"),
        });
      }
      if (nameValue && (await knex(pageConfig.table).whereRaw("lower(name) = ?", [nameValue.toLowerCase()]).first())) {
        logEmployeeDebug(pageConfig, req, "create:duplicate_name", {
          traceId,
          nameValue,
        });
        return renderIndexError(req, res, sanitizedValues, res.locals.t("error_duplicate_name"), "create", basePath, flashCookie, {
          name: res.locals.t("error_duplicate_name"),
        });
      }

      const branchIds = Array.isArray(sanitizedValues.branch_ids) ? sanitizedValues.branch_ids.map(String) : [];
      if (pageConfig.branchScoped && !branchIds.length) {
        logEmployeeDebug(pageConfig, req, "create:no_branch_selected", { traceId });
        return renderIndexError(req, res, sanitizedValues, res.locals.t("error_select_branch"), "create", basePath, flashCookie, {
          branch_ids: res.locals.t("error_select_branch"),
        });
      }
      if (pageConfig.branchScoped && !req.user?.isAdmin) {
        const allowed = new Set(getAllowedBranchIds(req).map(String));
        const invalid = branchIds.some((id) => !allowed.has(String(id)));
        if (invalid) {
          return renderIndexError(req, res, sanitizedValues, res.locals.t("error_branch_out_of_scope"), "create", basePath, flashCookie, {
            branch_ids: res.locals.t("error_branch_out_of_scope"),
          });
        }
      }

      const approval = await handleScreenApproval({
        req,
        scopeKey: pageConfig.scopeKey,
        action: "create",
        entityType: pageConfig.entityType,
        entityId: "NEW",
        summary: `${res.locals.t("create")} ${res.locals.t(pageConfig.titleKey)}`,
        oldValue: null,
        newValue: sanitizedValues,
        t: res.locals.t,
      });
      if (approval.queued) {
        logEmployeeDebug(pageConfig, req, "create:approval_queued", {
          traceId,
          requestId: approval.requestId || null,
          redirectTo: req.get("referer") || basePath,
        });
        return res.redirect(req.get("referer") || basePath);
      }

      const { branch_ids: branchIdsInsert = [], ...valuesWithoutBranch } = sanitizedValues;
      const { persistedValues: rest, mapValues } = normalizeMultiMapValues(pageConfig, valuesWithoutBranch);
      let createdEntityId = null;
      await knex.transaction(async (trx) => {
        const [row] = await trx(pageConfig.table)
          .insert({
            ...rest,
          })
          .returning("id");
        const entityId = row && row.id ? row.id : row;
        createdEntityId = entityId;
        if (pageConfig.branchScoped && branchIdsInsert.length) {
          await trx(pageConfig.branchMap.table).insert(
            branchIdsInsert.map((branchId) => ({
              [pageConfig.branchMap.key]: entityId,
              [pageConfig.branchMap.branchKey]: branchId,
            })),
          );
        }
        if (Array.isArray(pageConfig.multiMaps) && pageConfig.multiMaps.length) {
          for (const mapConfig of pageConfig.multiMaps) {
            const selected = mapValues[mapConfig.fieldName] || [];
            if (!selected.length) continue;
            await trx(mapConfig.table).insert(
              selected.map((selectedValue) => ({
                [mapConfig.key]: entityId,
                [mapConfig.valueKey]: selectedValue,
              })),
            );
          }
        }
        queueAuditLog(req, {
          entityType: pageConfig.entityType,
          entityId,
          action: "CREATE",
        });
      });
      logEmployeeDebug(pageConfig, req, "create:insert_success", {
        traceId,
        entityId: createdEntityId,
      });
      return res.redirect(basePath);
    } catch (err) {
      logEmployeeDebug(pageConfig, req, "create:exception", {
        traceId,
        error: err?.message || String(err),
      });
      console.error("[hr-master:create]", { scopeKey: pageConfig.scopeKey, error: err.message });
      return renderIndexError(req, res, sanitizedValues, err?.message || res.locals.t("error_unable_save"), "create", basePath, flashCookie);
    }
  });

  router.post("/:id", requirePermission("SCREEN", pageConfig.scopeKey, "edit"), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) {
      return next();
    }
    const traceId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    logLabourRatesSaveDebug(pageConfig, req, "edit:request_received", {
      traceId,
      id,
      bodyKeys: Object.keys(req.body || {}),
    });
    const values = buildValues(pageConfig, req.body);
    const basePath = req.baseUrl;
    const sanitizedValues = pageConfig.sanitizeValues ? pageConfig.sanitizeValues(values, req) : values;
    logHrValidationDebug(pageConfig, req, "edit:request_received", {
      id,
      bodyKeys: Object.keys(req.body || {}),
      valueKeys: Object.keys(sanitizedValues || {}),
    });

    if (!hasField(pageConfig, "code") && !pageConfig.autoCodeFromName) {
      delete sanitizedValues.code;
    }

    const missing = pageConfig.fields
      .filter((field) => field.required)
      .filter((field) => {
        const value = sanitizedValues[field.name];
        return value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length);
      });
    if (missing.length) {
      logHrValidationDebug(pageConfig, req, "edit:missing_required", {
        id,
        missingFields: missing.map((field) => field.name),
        requiredFieldSummary: summarizeFieldsForLog(
          sanitizedValues,
          pageConfig.fields.filter((field) => field.required).map((field) => field.name),
        ),
      });
      logLabourRatesSaveDebug(pageConfig, req, "edit:missing_required", {
        traceId,
        id,
        missing: missing.map((field) => field.name),
      });
      const missingMap = missing.reduce((acc, field) => {
        acc[field.name] = res.locals.t("error_required_fields");
        return acc;
      }, {});
      return renderIndexError(req, res, sanitizedValues, res.locals.t("error_required_fields"), "edit", basePath, flashCookie, missingMap);
    }

    try {
      const existing = await knex(pageConfig.table).where({ id }).first();
      if (!existing) {
        logLabourRatesSaveDebug(pageConfig, req, "edit:not_found", { traceId, id });
        return renderIndexError(req, res, sanitizedValues, res.locals.t("error_not_found"), "edit", basePath, flashCookie);
      }

      if (existing.code) {
        sanitizedValues.code = existing.code;
      } else if (hasField(pageConfig, "code") || pageConfig.autoCodeFromName) {
        sanitizedValues.code = await generateUniqueCode({
          name: sanitizedValues.name,
          prefix: pageConfig.codePrefix || pageConfig.entityType || "",
          maxLen: 50,
          knex,
          table: pageConfig.table,
          excludeId: id,
        });
      }

      if (pageConfig.validateValues) {
        const validationError = await pageConfig.validateValues({ values: sanitizedValues, req, isUpdate: true, id, knex });
        if (validationError) {
          const normalized = normalizeValidationError(validationError);
          logHrValidationDebug(pageConfig, req, "edit:validation_error", {
            id,
            validationMessage: normalized?.message || String(validationError || ""),
            fieldErrorKeys: Object.keys(normalized?.fieldErrors || {}),
            requiredFieldSummary: summarizeFieldsForLog(
              sanitizedValues,
              pageConfig.fields.filter((field) => field.required).map((field) => field.name),
            ),
          });
          logLabourRatesSaveDebug(pageConfig, req, "edit:validation_failed", {
            traceId,
            id,
            validationError,
          });
          return renderIndexError(req, res, sanitizedValues, normalized.message || validationError, "edit", basePath, flashCookie, normalized.fieldErrors);
        }
      }

      const codeValue = sanitizedValues.code || "";
      const nameValue = sanitizedValues.name || "";
      if (codeValue) {
        const codeExists = await knex(pageConfig.table).whereRaw("lower(code) = ?", [codeValue.toLowerCase()]).andWhereNot({ id }).first();
        if (codeExists) {
          logLabourRatesSaveDebug(pageConfig, req, "edit:duplicate_code", { traceId, id, codeValue });
          return renderIndexError(req, res, sanitizedValues, res.locals.t("error_duplicate_code"), "edit", basePath, flashCookie, {
            code: res.locals.t("error_duplicate_code"),
          });
        }
      }
      if (nameValue) {
        const nameExists = await knex(pageConfig.table).whereRaw("lower(name) = ?", [nameValue.toLowerCase()]).andWhereNot({ id }).first();
        if (nameExists) {
          logLabourRatesSaveDebug(pageConfig, req, "edit:duplicate_name", { traceId, id, nameValue });
          return renderIndexError(req, res, sanitizedValues, res.locals.t("error_duplicate_name"), "edit", basePath, flashCookie, {
            name: res.locals.t("error_duplicate_name"),
          });
        }
      }

      const branchIds = Array.isArray(sanitizedValues.branch_ids) ? sanitizedValues.branch_ids.map(String) : [];
      if (pageConfig.branchScoped && !branchIds.length) {
        logLabourRatesSaveDebug(pageConfig, req, "edit:no_branch_selected", { traceId, id });
        return renderIndexError(req, res, sanitizedValues, res.locals.t("error_select_branch"), "edit", basePath, flashCookie, {
          branch_ids: res.locals.t("error_select_branch"),
        });
      }
      if (pageConfig.branchScoped && !req.user?.isAdmin) {
        const allowed = new Set(getAllowedBranchIds(req).map(String));
        const invalid = branchIds.some((id) => !allowed.has(String(id)));
        if (invalid) {
          return renderIndexError(req, res, sanitizedValues, res.locals.t("error_branch_out_of_scope"), "edit", basePath, flashCookie, {
            branch_ids: res.locals.t("error_branch_out_of_scope"),
          });
        }
      }

      const approval = await handleScreenApproval({
        req,
        scopeKey: pageConfig.scopeKey,
        action: "edit",
        entityType: pageConfig.entityType,
        entityId: id,
        summary: `${res.locals.t("edit")} ${res.locals.t(pageConfig.titleKey)}`,
        oldValue: existing,
        newValue: sanitizedValues,
        t: res.locals.t,
      });
      if (approval.queued) {
        logLabourRatesSaveDebug(pageConfig, req, "edit:queued_for_approval", {
          traceId,
          id,
          requestId: approval.requestId || null,
        });
        return res.redirect(req.get("referer") || basePath);
      }

      const changeSet = buildAuditChangeSet({
        before: existing,
        after: sanitizedValues,
        includeKeys: pageConfig.fields.map((field) => field.name),
      });
      const { branch_ids: branchIdsUpdate = [], ...valuesWithoutBranch } = sanitizedValues;
      const { persistedValues: rest, mapValues } = normalizeMultiMapValues(pageConfig, valuesWithoutBranch);
      await knex.transaction(async (trx) => {
        await trx(pageConfig.table).where({ id }).update(rest);
        if (pageConfig.branchScoped) {
          await trx(pageConfig.branchMap.table)
            .where({ [pageConfig.branchMap.key]: id })
            .del();
          if (branchIdsUpdate.length) {
            await trx(pageConfig.branchMap.table).insert(
              branchIdsUpdate.map((branchId) => ({
                [pageConfig.branchMap.key]: id,
                [pageConfig.branchMap.branchKey]: branchId,
              })),
            );
          }
        }
        if (Array.isArray(pageConfig.multiMaps) && pageConfig.multiMaps.length) {
          for (const mapConfig of pageConfig.multiMaps) {
            await trx(mapConfig.table)
              .where({ [mapConfig.key]: id })
              .del();
            const selected = mapValues[mapConfig.fieldName] || [];
            if (!selected.length) continue;
            await trx(mapConfig.table).insert(
              selected.map((selectedValue) => ({
                [mapConfig.key]: id,
                [mapConfig.valueKey]: selectedValue,
              })),
            );
          }
        }
      });

      queueAuditLog(req, {
        entityType: pageConfig.entityType,
        entityId: id,
        action: "UPDATE",
        context: {
          source: "hr-master-update",
          ...changeSet,
        },
      });
      logLabourRatesSaveDebug(pageConfig, req, "edit:db_update_success", {
        traceId,
        id,
        changed: Array.isArray(changeSet?.changed) ? changeSet.changed.length : 0,
      });
      return res.redirect(basePath);
    } catch (err) {
      logLabourRatesSaveDebug(pageConfig, req, "edit:exception", {
        traceId,
        id,
        error: err?.message || String(err),
      });
      console.error("[hr-master:update]", { scopeKey: pageConfig.scopeKey, id, error: err.message });
      return renderIndexError(req, res, sanitizedValues, err?.message || res.locals.t("error_unable_save"), "edit", basePath, flashCookie);
    }
  });

  router.post("/:id/toggle", requirePermission("SCREEN", pageConfig.scopeKey, "delete"), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) {
      return next();
    }
    const basePath = req.baseUrl;

    try {
      const current = await knex(pageConfig.table).select("status").where({ id }).first();
      if (!current) {
        return next(new HttpError(404, res.locals.t("error_not_found")));
      }
      const nextStatus = (current.status || "").toLowerCase() === "active" ? "inactive" : "active";
      const approval = await handleScreenApproval({
        req,
        scopeKey: pageConfig.scopeKey,
        action: "delete",
        entityType: pageConfig.entityType,
        entityId: id,
        summary: `${res.locals.t("deactivate")} ${res.locals.t(pageConfig.titleKey)}`,
        oldValue: current,
        newValue: { status: nextStatus },
        t: res.locals.t,
      });
      if (approval.queued) {
        return res.redirect(req.get("referer") || basePath);
      }
      await knex(pageConfig.table).where({ id }).update({ status: nextStatus });
      queueAuditLog(req, {
        entityType: pageConfig.entityType,
        entityId: id,
        action: "DELETE",
      });
      return res.redirect(basePath);
    } catch (err) {
      console.error("[hr-master:toggle]", { scopeKey: pageConfig.scopeKey, id, error: err.message });
      return renderIndexError(req, res, {}, res.locals.t("error_update_status"), "delete", basePath, flashCookie);
    }
  });

  router.post("/:id/delete", requirePermission("SCREEN", pageConfig.scopeKey, "hard_delete"), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!id) {
      return next();
    }
    const basePath = req.baseUrl;

    try {
      const existing = await knex(pageConfig.table).where({ id }).first();
      if (!existing) {
        return renderIndexError(req, res, {}, res.locals.t("error_not_found"), "delete", basePath, flashCookie);
      }
      if (pageConfig.hasDependencies) {
        const blocked = await pageConfig.hasDependencies({ id, req, knex });
        if (blocked) {
          return renderIndexError(req, res, {}, res.locals.t("error_record_in_use"), "delete", basePath, flashCookie);
        }
      }
      const approval = await handleScreenApproval({
        req,
        scopeKey: pageConfig.scopeKey,
        action: "delete",
        entityType: pageConfig.entityType,
        entityId: id,
        summary: `${res.locals.t("delete")} ${res.locals.t(pageConfig.titleKey)}`,
        oldValue: existing,
        newValue: null,
        t: res.locals.t,
      });
      if (approval.queued) {
        return res.redirect(req.get("referer") || basePath);
      }
      await knex(pageConfig.table).where({ id }).del();
      queueAuditLog(req, {
        entityType: pageConfig.entityType,
        entityId: id,
        action: "DELETE",
      });
      return res.redirect(basePath);
    } catch (err) {
      console.error("[hr-master:hard-delete]", { scopeKey: pageConfig.scopeKey, id, error: err.message });
      return renderIndexError(req, res, {}, err?.message || res.locals.t("error_delete"), "delete", basePath, flashCookie);
    }
  });

  return router;
};

module.exports = {
  createHrMasterRouter,
  hydratePage,
  renderInfoScreen,
};
