const express = require("express");
const knex = require("../../db/knex");
const approvalRequired = require("../../middleware/approvals/approval-required");
const { HttpError } = require("../../middleware/errors/http-error");

const router = express.Router();

const normalizeLines = (lines = []) =>
  lines.map((line, index) => ({
    line_no: line.line_no || index + 1,
    line_kind: line.line_kind,
    item_id: line.item_id || null,
    sku_id: line.sku_id || null,
    account_id: line.account_id || null,
    party_id: line.party_id || null,
    labour_id: line.labour_id || null,
    employee_id: line.employee_id || null,
    uom_id: line.uom_id || null,
    qty: line.qty || 0,
    rate: line.rate || 0,
    amount: line.amount || 0,
    meta: line.meta || {},
  }));

router.post("/", async (req, res, next) => {
  const { voucher_type_code, voucher_no, voucher_date, book_no, remarks } =
    req.body || {};

  if (!voucher_type_code || !voucher_no || !voucher_date) {
    return next(new HttpError(400, "Missing required voucher fields"));
  }

  const lines = normalizeLines(req.body?.lines || []);
  if (!lines.length) {
    return next(new HttpError(400, "Voucher lines are required"));
  }

  try {
    const voucherType = await knex("erp.voucher_type")
      .select("requires_approval")
      .where({ code: voucher_type_code })
      .first();

    if (!voucherType) {
      return next(new HttpError(400, "Invalid voucher_type_code"));
    }

    const status = voucherType.requires_approval ? "PENDING" : "APPROVED";

    const result = await knex.transaction(async (trx) => {
      const [header] = await trx("erp.voucher_header")
        .insert({
          voucher_type_code,
          voucher_no,
          branch_id: req.branchId,
          voucher_date,
          book_no: book_no || null,
          status,
          created_by: req.user.id,
          approved_by: voucherType.requires_approval ? null : req.user.id,
          approved_at: voucherType.requires_approval ? null : trx.fn.now(),
          remarks: remarks || null,
        })
        .returning(["id", "status"]);

      const lineRows = lines.map((line) => ({
        ...line,
        voucher_header_id: header.id,
      }));
      await trx("erp.voucher_line").insert(lineRows);

      return header;
    });

    req.setAuditContext({
      entityType: "VOUCHER",
      entityId: result.id,
      action: "CREATE",
      voucherTypeCode: voucher_type_code,
    });

    res.status(201).json({ id: result.id, status: result.status });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/submit", async (req, res, next) => {
  const voucherId = Number(req.params.id);
  if (!voucherId) {
    return next(new HttpError(400, "Invalid voucher id"));
  }

  try {
    const voucher = await knex("erp.voucher_header")
      .select("id", "voucher_type_code", "status", "created_by", "branch_id")
      .where({ id: voucherId })
      .first();

    if (!voucher) {
      return next(new HttpError(404, "Voucher not found"));
    }

    if (voucher.created_by !== req.user.id) {
      return next(new HttpError(403, "Only creator can submit voucher"));
    }

    if (voucher.status !== "PENDING") {
      return next(new HttpError(400, "Voucher is not pending"));
    }

    req.approvalRequest = {
      branchId: voucher.branch_id,
      requestType: "VOUCHER",
      entityType: "VOUCHER",
      entityId: voucher.id,
      summary: `Voucher ${voucher.voucher_type_code} submitted`,
      block: true,
    };

    req.setAuditContext({
      entityType: "VOUCHER",
      entityId: voucher.id,
      action: "SUBMIT",
      voucherTypeCode: voucher.voucher_type_code,
    });

    next();
  } catch (err) {
    next(err);
  }
}, approvalRequired);

module.exports = router;
