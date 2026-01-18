const knex = require("../../db/knex");
const { HttpError } = require("../errors/http-error");

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const resolveVoucherDate = (req) =>
  req.body?.voucher_date ||
  req.body?.voucherDate ||
  req.body?.date ||
  req.body?.period_date ||
  null;

// Blocks create/edit/delete when a branch period is locked or audit-frozen.
module.exports = async (req, res, next) => {
  if (!WRITE_METHODS.has(req.method)) return next();
  if (!req.user) return next();

  const voucherDate = resolveVoucherDate(req);
  if (!voucherDate) return next();

  const branchId = req.branchId || req.body?.branch_id;
  if (!branchId) return next();

  if (req.user.isAdmin) return next();

  const date = new Date(voucherDate);
  if (!date.getTime()) return next(new HttpError(400, "Invalid voucher date"));

  const periodYear = date.getUTCFullYear();
  const periodMonth = date.getUTCMonth() + 1;

  try {
    const row = await knex("erp.period_control")
      .select("status")
      .where({
        branch_id: branchId,
        period_year: periodYear,
        period_month: periodMonth,
      })
      .first();

    if (row && (row.status === "LOCKED" || row.status === "FROZEN")) {
      return next(
        new HttpError(403, "Period is locked or frozen", {
          status: row.status,
          periodYear,
          periodMonth,
        })
      );
    }

    next();
  } catch (err) {
    next(err);
  }
};

