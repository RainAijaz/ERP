const knex = require("../../db/knex");
const { HttpError } = require("../errors/http-error");
const { setCookie } = require("../utils/cookies");
const { parseCookies } = require("../utils/cookies");

const loadBranchRows = async ({ isAdmin, branchIds }) => {
  // Availability is an access decision. Read it on every request so a branch
  // deactivated by another session or worker cannot remain selectable.
  const branchRowsQuery = knex("erp.branches")
    .select("id", "code", "name")
    .where({ is_active: true })
    .orderBy("name", "asc");
  return isAdmin ? branchRowsQuery : branchRowsQuery.whereIn("id", branchIds);
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
    return next(new HttpError(403, res.locals.t("permission_denied")));
  }

  const requested = toNumber(req.branchContext?.requestedBranchId);
  let activeBranch = requested || branchIds[0];

  const submittedBranches = [
    ...toNumberList(req.get("x-branch-id")),
    ...toNumberList(req.query?.branch_id),
    ...toNumberList(req.body?.branch_id),
  ];

  try {
    const branchRows = await loadBranchRows({ isAdmin, branchIds });
    branchIds = branchRows.map((row) => Number(row.id));
    if (submittedBranches.some((branchId) => !branchIds.includes(branchId))) {
      return next(new HttpError(403, res.locals.t("permission_denied")));
    }

    // Administrators must still be able to reactivate branches when none remain.
    const canManageBranches = isAdmin && /^\/administration\/branches(?:\/|$)/.test(req.path);
    if (!branchIds.length && !canManageBranches) {
      return next(new HttpError(403, res.locals.t("permission_denied")));
    }
    if (
      requested &&
      !branchIds.includes(requested) &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !canManageBranches
    ) {
      // Never save a form opened in a deactivated branch into another branch.
      return next(new HttpError(403, res.locals.t("permission_denied")));
    }
    if (!branchIds.includes(activeBranch)) {
      // A cookie can outlive a deactivation or reassignment. Explicit query,
      // body and header selections were validated above; only cookies fall back.
      activeBranch = branchIds[0] || null;
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
    console.error("Error in BranchScopeService:", err);
    return next(new HttpError(500, res.locals.t("generic_error")));
  }

  req.applyBranchScope = (qb, column = "branch_id") => {
    if (!qb || typeof qb.whereIn !== "function") return qb;
    if (isAdmin) return qb;
    return qb.whereIn(column, branchIds);
  };

  const cookies = parseCookies(req);
  if (String(cookies.active_branch_id || "") !== String(activeBranch || "")) {
    setCookie(res, "active_branch_id", activeBranch ? String(activeBranch) : "", {
      path: "/",
      sameSite: "Lax",
      maxAge: activeBranch ? 60 * 60 * 24 * 30 : 0,
    });
  }

  next();
};
