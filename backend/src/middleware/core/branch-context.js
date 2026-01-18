const { parseCookies } = require("../utils/cookies");

// Resolves active branch from session/header for downstream logic.
module.exports = (req, res, next) => {
  const headerBranch = req.get("x-branch-id");
  const queryBranch = req.query && req.query.branch_id;
  const bodyBranch = req.body && req.body.branch_id;
  const cookies = parseCookies(req);
  const cookieBranch = cookies.active_branch_id;

  const requested = headerBranch || queryBranch || bodyBranch || cookieBranch;

  req.branchContext = {
    requestedBranchId: requested ? Number(requested) : null,
  };

  next();
};

