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

  const branchIds = (req.user.branchIds || []).filter((id) => id != null);
  if (!branchIds.length) {
    return next(new HttpError(403, "No branches assigned"));
  }

  const requested = toNumber(req.branchContext?.requestedBranchId);
  const activeBranch = requested || branchIds[0];

  if (!branchIds.includes(activeBranch)) {
    return next(new HttpError(403, "Branch not assigned"));
  }

  const submittedBranch = toNumber(req.body?.branch_id || req.query?.branch_id);
  if (submittedBranch && !branchIds.includes(submittedBranch)) {
    return next(new HttpError(403, "Branch not assigned"));
  }

  try {
    const branchRows = await knex("erp.branches")
      .select("id", "code", "name")
      .whereIn("id", branchIds)
      .orderBy("name", "asc");

    const branchById = branchRows.reduce((acc, row) => {
      acc[Number(row.id)] = row;
      return acc;
    }, {});

    req.branchId = activeBranch;
    req.branchScope = branchIds;
    req.branchOptions = branchRows;
    res.locals.branchId = activeBranch;
    res.locals.branchScope = branchIds;
    res.locals.branchOptions = branchRows;
    res.locals.branchName = branchById[activeBranch]?.name || null;
  } catch (err) {
    return next(err);
  }

  req.applyBranchScope = (qb, column = "branch_id") => {
    if (!qb || typeof qb.whereIn !== "function") return qb;
    return qb.whereIn(column, branchIds);
  };

  setCookie(res, "active_branch_id", String(activeBranch), {
    path: "/",
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 30,
  });

  next();
};

