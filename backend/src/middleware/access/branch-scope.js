const knex = require("../../db/knex");
const { HttpError } = require("../errors/http-error");
const { setCookie } = require("../utils/cookies");

const toNumber = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
};

// Enforces branch-level access control so users can only see/act on assigned branches.
module.exports = async (req, res, next) => {
  if (!req.user) return next();
  if (req.path.startsWith("/auth")) return next();

  const isAdmin = Boolean(req.user.isAdmin);
  let branchIds = (req.user.branchIds || []).filter((id) => id != null);
  if (!branchIds.length && !isAdmin) {
    return next(new HttpError(403, "No branches assigned"));
  }

  const requested = toNumber(req.branchContext?.requestedBranchId);
  let activeBranch = requested || branchIds[0];

  const submittedBranch = toNumber(req.body?.branch_id || req.query?.branch_id);
  if (submittedBranch && !isAdmin && !branchIds.includes(submittedBranch)) {
    return next(new HttpError(403, "Branch not assigned"));
  }

  try {
    const branchRowsQuery = knex("erp.branches")
      .select("id", "code", "name")
      .orderBy("name", "asc");
    const branchRows = isAdmin
      ? await branchRowsQuery
      : await branchRowsQuery.whereIn("id", branchIds);

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

  setCookie(res, "active_branch_id", String(activeBranch), {
    path: "/",
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 30,
  });

  next();
};

