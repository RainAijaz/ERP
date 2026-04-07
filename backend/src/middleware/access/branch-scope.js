const knex = require("../../db/knex");
const { HttpError } = require("../errors/http-error");
const { setCookie } = require("../utils/cookies");
const { parseCookies } = require("../utils/cookies");

const BRANCH_OPTIONS_CACHE_TTL_MS = Number(
  process.env.BRANCH_OPTIONS_CACHE_TTL_MS || 60000,
);
const branchOptionsCache = new Map();

const getBranchCacheKey = (isAdmin, branchIds = []) => {
  if (isAdmin) return "admin:all";
  return `user:${[...branchIds].sort((a, b) => a - b).join(",")}`;
};

const cloneRows = (rows = []) => rows.map((row) => ({ ...row }));

const loadBranchRowsCached = async ({ isAdmin, branchIds }) => {
  const cacheKey = getBranchCacheKey(isAdmin, branchIds);
  const cached = branchOptionsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cloneRows(cached.rows);
  }

  const branchRowsQuery = knex("erp.branches")
    .select("id", "code", "name")
    .orderBy("name", "asc");
  const rows = isAdmin
    ? await branchRowsQuery
    : await branchRowsQuery.whereIn("id", branchIds);

  branchOptionsCache.set(cacheKey, {
    rows: cloneRows(rows),
    expiresAt: Date.now() + BRANCH_OPTIONS_CACHE_TTL_MS,
  });
  return rows;
};

const toNumber = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const toNumberList = (value) => {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry || "").split(","))
      .map((entry) => toNumber(String(entry || "").trim()))
      .filter((entry) => Number.isInteger(entry) && entry > 0);
  }
  const text = String(value || "").trim();
  if (!text) return [];
  return text
    .split(",")
    .map((entry) => toNumber(String(entry || "").trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
};

// Enforces branch-level access control so users can only see/act on assigned branches.
module.exports = async (req, res, next) => {
  if (!req.user) return next();
  if (req.path.startsWith("/auth")) return next();

  const isAdmin = Boolean(req.user.isAdmin);
  let branchIds = (req.user.branchIds || [])
    .map((id) => toNumber(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!branchIds.length && !isAdmin) {
    return next(new HttpError(403, "No branches assigned"));
  }

  const requested = toNumber(req.branchContext?.requestedBranchId);
  let activeBranch = requested || branchIds[0];

  const submittedBranches = [
    ...toNumberList(req.query?.branch_id),
    ...toNumberList(req.body?.branch_id),
  ];
  if (
    submittedBranches.length &&
    !isAdmin &&
    submittedBranches.some((branchId) => !branchIds.includes(branchId))
  ) {
    return next(new HttpError(403, "Branch not assigned"));
  }

  try {
    const branchRows = await loadBranchRowsCached({ isAdmin, branchIds });

    if (isAdmin) {
      branchIds = branchRows.map((row) => Number(row.id));
      if (requested && branchIds.length && !branchIds.includes(requested)) {
        return next(new HttpError(403, "Branch not assigned"));
      }
      if (!activeBranch && branchIds.length) {
        activeBranch = branchIds[0];
      }
    }

    if (!isAdmin && activeBranch && !branchIds.includes(activeBranch)) {
      // Ignore stale branch cookie/query and fall back to first allowed branch.
      activeBranch = branchIds[0];
    }

    const branchById = branchRows.reduce((acc, row) => {
      acc[Number(row.id)] = row;
      return acc;
    }, {});

    req.branchId = activeBranch;
    req.branchScope = branchIds;
    req.branchOptions = branchRows;
    req.isAdmin = isAdmin;
    res.locals.branchId = activeBranch;
    res.locals.branchScope = branchIds;
    res.locals.branchOptions = branchRows;
    res.locals.branchName = branchById[activeBranch]?.name || null;
  } catch (err) {
    return next(err);
  }

  req.applyBranchScope = (qb, column = "branch_id") => {
    if (!qb || typeof qb.whereIn !== "function") return qb;
    if (isAdmin) return qb;
    return qb.whereIn(column, branchIds);
  };

  const cookies = parseCookies(req);
  if (String(cookies.active_branch_id || "") !== String(activeBranch || "")) {
    setCookie(res, "active_branch_id", String(activeBranch), {
      path: "/",
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  next();
};
