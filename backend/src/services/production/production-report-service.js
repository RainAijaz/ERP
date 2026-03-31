const knex = require("../../db/knex");
const { HttpError } = require("../../middleware/errors/http-error");
const { PRODUCTION_VOUCHER_TYPES, loadBomProfileBySkuTx } = require("./production-voucher-service");

const toPositiveInt = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const toDateOnly = (value) => {
  if (!value) return null;
  const text = String(value).trim();
  const m = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

const parseList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const getAllowedBranchIds = (req) => {
  if (req?.user?.isAdmin) return [];
  return Array.isArray(req?.branchScope)
    ? req.branchScope.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
    : [];
};

const loadBranchOptions = async (req) => {
  const allowed = getAllowedBranchIds(req);
  let query = knex("erp.branches")
    .select("id", "name")
    .where({ is_active: true })
    .orderBy("name", "asc");
  if (!req?.user?.isAdmin && allowed.length) {
    query = query.whereIn("id", allowed);
  }
  return query;
};

const normalizeBranchFilter = ({ req, input }) => {
  const parsed = [...new Set(
    parseList(input?.branch_ids || input?.branchIds)
      .map((entry) => Number(entry))
      .filter((entry) => Number.isInteger(entry) && entry > 0),
  )];
  if (req?.user?.isAdmin) {
    return parsed;
  }
  const allowed = getAllowedBranchIds(req);
  if (!allowed.length) return [];
  if (!parsed.length) return allowed;
  const allowedSet = new Set(allowed);
  return parsed.filter((id) => allowedSet.has(id));
};

const normalizePlanKind = (value) => {
  const kind = String(value || "ALL").trim().toUpperCase();
  if (kind === "FG" || kind === "SFG") return kind;
  return "ALL";
};

const loadApprovedPlanLines = async ({
  branchIds = [],
  fromDate = null,
  toDate = null,
  planKind = "ALL",
}) => {
  let query = knex("erp.voucher_header as vh")
    .join("erp.production_plan_header as pph", "pph.voucher_id", "vh.id")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
    .join("erp.production_plan_line as ppl", "ppl.voucher_line_id", "vl.id")
    .select(
      "vh.id as voucher_id",
      "vh.branch_id",
      "vh.voucher_no",
      "vh.voucher_date",
      "pph.plan_kind",
      "vl.sku_id",
      "ppl.total_pairs",
    )
    .where({
      "vh.voucher_type_code": PRODUCTION_VOUCHER_TYPES.productionPlan,
      "vh.status": "APPROVED",
      "vl.line_kind": "SKU",
    });

  if (branchIds.length) query = query.whereIn("vh.branch_id", branchIds);
  if (fromDate) query = query.where("vh.voucher_date", ">=", fromDate);
  if (toDate) query = query.where("vh.voucher_date", "<=", toDate);
  if (planKind !== "ALL") query = query.where("pph.plan_kind", planKind);

  return query.orderBy("vh.voucher_date", "asc").orderBy("vh.id", "asc");
};

const normalizeDateRange = (input = {}) => {
  const fromDate = toDateOnly(input?.from_date || input?.fromDate);
  const toDate = toDateOnly(input?.to_date || input?.toDate);
  return { fromDate, toDate };
};

const normalizeIdList = (value) => [...new Set(
  parseList(value)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0),
)];

const normalizeProductionType = (value) => {
  const normalized = String(value || "ALL").trim().toUpperCase();
  if (normalized === "FG" || normalized === "SFG") return normalized;
  return "ALL";
};

const normalizeSkuUnit = (value) => {
  const normalized = String(value || "ALL").trim().toUpperCase();
  if (normalized === "PAIR" || normalized === "DZN") return normalized;
  return "ALL";
};

const normalizeStageScope = (value) => {
  const normalized = String(value || "ALL").trim().toUpperCase();
  return normalized === "FINAL_ONLY" ? "FINAL_ONLY" : "ALL";
};

const normalizeProductionControlOrderBy = (value) => {
  const normalized = String(value || "voucher").trim().toLowerCase();
  if (["voucher", "sku", "department"].includes(normalized)) return normalized;
  return "voucher";
};

const normalizeReportType = (value) => {
  const normalized = String(value || "details").trim().toLowerCase();
  return normalized === "summary" ? "summary" : "details";
};

const getTodayDateOnly = () => new Date().toISOString().slice(0, 10);

const normalizeAsOfDate = (input = {}) => {
  const raw = String(input?.as_of_date || input?.asOfDate || "").trim();
  const parsed = toDateOnly(raw);
  return {
    asOfDate: parsed || getTodayDateOnly(),
    invalidFilterInput: Boolean(raw) && !parsed,
  };
};

const normalizeAgingBucket = (value) => {
  const normalized = String(value || "ALL").trim().toUpperCase();
  if (["ALL", "0_2", "3_7", "8_15", "15_PLUS"].includes(normalized)) return normalized;
  return "ALL";
};

const resolveAgingBucketByDays = (days) => {
  const n = Number(days || 0);
  if (!Number.isFinite(n) || n <= 2) return "0_2";
  if (n <= 7) return "3_7";
  if (n <= 15) return "8_15";
  return "15_PLUS";
};

const matchesAgingBucket = (selectedBucket, days) => {
  const bucket = normalizeAgingBucket(selectedBucket);
  if (bucket === "ALL") return true;
  return resolveAgingBucketByDays(days) === bucket;
};

const parseSourceSkuIdFromMeta = (meta) => {
  const raw = meta && typeof meta === "object" ? meta.source_sku_id : null;
  return toPositiveInt(raw);
};

const hasTableColumn = async (tableName, columnName) => {
  try {
    return knex.schema.withSchema("erp").hasColumn(tableName, columnName);
  } catch (_) {
    return false;
  }
};

const getProductionControlReportPageData = async ({ req, input = {} }) => {
  const branchOptionsPromise = loadBranchOptions(req);
  const departmentsPromise = knex("erp.departments")
    .select("id", "name")
    .where({ is_active: true, is_production: true })
    .orderBy("name", "asc");
  const laboursPromise = knex("erp.labours")
    .select("id", "name")
    .whereRaw("lower(coalesce(status, '')) = 'active'")
    .orderBy("name", "asc");
  const productGroupsPromise = knex("erp.product_groups")
    .select("id", "name")
    .where({ is_active: true })
    .orderBy("name", "asc");
  const productSubgroupsPromise = knex("erp.product_subgroups as sg")
    .select("sg.id", "sg.name", "sg.group_id")
    .where({ "sg.is_active": true })
    .whereExists(function whereSubgroupHasProductionItems() {
      this.select(1)
        .from("erp.items as i")
        .whereRaw("i.subgroup_id = sg.id")
        .andWhere("i.is_active", true)
        .whereIn("i.item_type", ["FG", "SFG"]);
    })
    .orderBy("sg.name", "asc");
  const articlesPromise = knex("erp.items as i")
    .select("i.id", "i.name")
    .where({ "i.is_active": true })
    .whereIn("i.item_type", ["FG", "SFG"])
    .whereExists(function whereItemHasActiveSku() {
      this.select(1)
        .from("erp.variants as v")
        .join("erp.skus as s", "s.variant_id", "v.id")
        .whereRaw("v.item_id = i.id")
        .andWhere("s.is_active", true);
    })
    .orderBy("i.name", "asc");

  const selectedBranchIds = normalizeBranchFilter({ req, input });
  const { fromDate, toDate } = normalizeDateRange(input);
  const selectedDeptIds = normalizeIdList(input?.department_ids || input?.departmentIds);
  const selectedLabourIds = normalizeIdList(input?.labour_ids || input?.labourIds);
  const selectedProductGroupIds = normalizeIdList(input?.product_group_ids || input?.productGroupIds);
  const selectedProductSubgroupIds = normalizeIdList(input?.product_subgroup_ids || input?.productSubgroupIds);
  const selectedArticleIds = normalizeIdList(input?.article_ids || input?.articleIds);
  const productionType = normalizeProductionType(input?.production_type || input?.productionType);
  const selectedSkuUnit = normalizeSkuUnit(input?.sku_unit || input?.skuUnit);
  const stageScope = normalizeStageScope(input?.stage_scope || input?.stageScope);
  const orderBy = normalizeProductionControlOrderBy(input?.order_by || input?.orderBy);
  const reportType = normalizeReportType(input?.report_type || input?.reportType);
  const reportLoaded = String(input?.load_report || input?.loadReport || "").trim() === "1";

  const [branchOptions, departments, labours, productGroups, productSubgroups, articles] = await Promise.all([
    branchOptionsPromise,
    departmentsPromise,
    laboursPromise,
    productGroupsPromise,
    productSubgroupsPromise,
    articlesPromise,
  ]);

  const filters = {
    reportLoaded,
    fromDate: fromDate || "",
    toDate: toDate || "",
    branchIds: selectedBranchIds,
    departmentIds: selectedDeptIds,
    labourIds: selectedLabourIds,
    productGroupIds: selectedProductGroupIds,
    productSubgroupIds: selectedProductSubgroupIds,
    articleIds: selectedArticleIds,
    productionType,
    skuUnit: selectedSkuUnit,
    stageScope,
    orderBy,
    reportType,
  };

  const options = {
    branches: branchOptions,
    departments,
    labours,
    productGroups,
    productSubgroups,
    articles,
    productionTypes: [
      { value: "ALL", labelKey: "all" },
      { value: "FG", labelKey: "finished" },
      { value: "SFG", labelKey: "semi_finished" },
    ],
    skuUnits: [
      { value: "ALL", labelKey: "all" },
      { value: "PAIR", labelKey: "unit_pair" },
      { value: "DZN", labelKey: "unit_dozen" },
    ],
    stageScopes: [
      { value: "ALL", labelKey: "all" },
      { value: "FINAL_ONLY", labelKey: "final_stage_only" },
    ],
  };

  if (!reportLoaded) {
    return {
      filters,
      options,
      reportData: {
        rows: [],
        groups: [],
        summaryRows: [],
        totals: { qty: 0, packedQty: 0, looseQty: 0, lineCount: 0, voucherCount: 0, branchCount: 0 },
      },
    };
  }

  if (fromDate && toDate && fromDate > toDate) {
    throw new HttpError(400, req?.res?.locals?.t?.("invalid_date_range") || "Invalid date range.");
  }

  const [
    voucherLineHasDeptId,
    voucherLineHasStageId,
    voucherLineHasLabourId,
    dcvHasDeptId,
    dcvHasStageId,
    dcvHasLabourId,
    productionLineHasStageId,
    productionLineHasIsPacked,
    lossLineHasDeptId,
    lossLineHasStageId,
    labourVoucherLineHasDeptId,
  ] = await Promise.all([
    hasTableColumn("voucher_line", "dept_id"),
    hasTableColumn("voucher_line", "stage_id"),
    hasTableColumn("voucher_line", "labour_id"),
    hasTableColumn("dcv_header", "dept_id"),
    hasTableColumn("dcv_header", "stage_id"),
    hasTableColumn("dcv_header", "labour_id"),
    hasTableColumn("production_line", "stage_id"),
    hasTableColumn("production_line", "is_packed"),
    hasTableColumn("abnormal_loss_line", "dept_id"),
    hasTableColumn("abnormal_loss_line", "stage_id"),
    hasTableColumn("labour_voucher_line", "dept_id"),
  ]);

  const deptExprParts = [];
  if (lossLineHasDeptId) deptExprParts.push("alln.dept_id");
  if (dcvHasDeptId) deptExprParts.push("dh.dept_id");
  if (labourVoucherLineHasDeptId) deptExprParts.push("lvl.dept_id");
  if (voucherLineHasDeptId) deptExprParts.push("vl.dept_id");
  const deptExpr = deptExprParts.length ? `coalesce(${deptExprParts.join(", ")})` : "null::bigint";

  const stageExprParts = [];
  if (lossLineHasStageId) stageExprParts.push("alln.stage_id");
  if (dcvHasStageId) stageExprParts.push("dh.stage_id");
  if (productionLineHasStageId) stageExprParts.push("pl.stage_id");
  if (voucherLineHasStageId) stageExprParts.push("vl.stage_id");
  const stageExpr = stageExprParts.length ? `coalesce(${stageExprParts.join(", ")})` : "null::bigint";

  const labourExprParts = [];
  if (voucherLineHasLabourId) labourExprParts.push("vl.labour_id");
  if (dcvHasLabourId) labourExprParts.push("dh.labour_id");
  const labourExpr = labourExprParts.length ? `coalesce(${labourExprParts.join(", ")})` : "null::bigint";

  let query = knex("erp.voucher_header as vh")
    .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id");

  if (dcvHasDeptId || dcvHasStageId || dcvHasLabourId) {
    query = query.leftJoin("erp.dcv_header as dh", "dh.voucher_id", "vh.id");
  }
  if (lossLineHasDeptId || lossLineHasStageId) {
    query = query.leftJoin("erp.abnormal_loss_line as alln", "alln.voucher_line_id", "vl.id");
  }
  if (labourVoucherLineHasDeptId) {
    query = query.leftJoin("erp.labour_voucher_line as lvl", "lvl.voucher_line_id", "vl.id");
  }
  if (productionLineHasStageId || productionLineHasIsPacked) {
    query = query.leftJoin("erp.production_line as pl", "pl.voucher_line_id", "vl.id");
  }

  query = query
    .leftJoin("erp.departments as d", "d.id", knex.raw(deptExpr))
    .leftJoin("erp.labours as l", "l.id", knex.raw(labourExpr))
    .leftJoin("erp.production_stages as ps", "ps.id", knex.raw(stageExpr))
    .leftJoin("erp.branches as b", "b.id", "vh.branch_id")
    .select(
      "vh.id as voucher_id",
      "vh.voucher_no",
      "vh.voucher_date",
      "vh.branch_id",
      "b.name as branch_name",
      "vh.remarks as header_remarks",
      "vl.id as line_id",
      "vl.line_no",
      "vl.line_kind",
      "vl.qty",
      "vl.sku_id",
      "vl.item_id",
      voucherLineHasLabourId ? "vl.labour_id" : knex.raw("null::bigint as labour_id"),
      "vl.meta",
      productionLineHasIsPacked ? "pl.is_packed as production_is_packed" : knex.raw("null::boolean as production_is_packed"),
      knex.raw(`${deptExpr} as effective_dept_id`),
      knex.raw(`${stageExpr} as effective_stage_id`),
      knex.raw(`${labourExpr} as effective_labour_id`),
      "d.name as dept_name",
      "l.name as labour_name",
      "ps.name as stage_name",
      "ps.code as stage_code",
    )
    .where({
      "vh.voucher_type_code": PRODUCTION_VOUCHER_TYPES.departmentCompletion,
      "vh.status": "APPROVED",
    });

  if (selectedBranchIds.length) query = query.whereIn("vh.branch_id", selectedBranchIds);
  if (fromDate) query = query.where("vh.voucher_date", ">=", fromDate);
  if (toDate) query = query.where("vh.voucher_date", "<=", toDate);
  if (selectedDeptIds.length) {
    if (deptExprParts.length) {
      query = query.whereIn(knex.raw(deptExpr), selectedDeptIds);
    } else {
      query = query.whereRaw("1 = 0");
    }
  }
  if (selectedLabourIds.length) {
    if (labourExprParts.length) {
      query = query.whereIn(knex.raw(labourExpr), selectedLabourIds);
    } else {
      query = query.whereRaw("1 = 0");
    }
  }

  const rawRows = await query
    .orderBy("vh.voucher_date", "asc")
    .orderBy("vh.voucher_no", "asc")
    .orderBy("vl.line_no", "asc");

  const explicitSkuIds = [...new Set(rawRows.map((row) => toPositiveInt(row.sku_id)).filter(Boolean))];
  const sourceSkuIds = [...new Set(rawRows.map((row) => parseSourceSkuIdFromMeta(row.meta)).filter(Boolean))];
  const allSkuIds = [...new Set([...explicitSkuIds, ...sourceSkuIds])];

  const skuRows = await (
    allSkuIds.length
      ? knex("erp.skus as s")
          .join("erp.variants as v", "v.id", "s.variant_id")
          .join("erp.items as i", "i.id", "v.item_id")
          .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
          .leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id")
          .select(
            "s.id as sku_id",
            "s.sku_code",
            "i.id as article_id",
            "i.name as item_name",
            "i.item_type",
            "i.group_id",
            "i.subgroup_id",
            "pg.name as group_name",
            "sg.name as subgroup_name",
          )
          .whereIn("s.id", allSkuIds)
      : Promise.resolve([])
  );

  const skuById = new Map(skuRows.map((row) => [Number(row.sku_id), row]));

  let mappedRows = rawRows
    .map((row) => {
      const explicitSkuId = toPositiveInt(row.sku_id);
      const sourceSkuId = parseSourceSkuIdFromMeta(row.meta);
      const effectiveSkuId = explicitSkuId || sourceSkuId;
      const sku = effectiveSkuId ? skuById.get(Number(effectiveSkuId)) : null;
      const effectiveProductionType = String(sku?.item_type || "").trim().toUpperCase();
      const effectiveGroupId = toPositiveInt(sku?.group_id);
      const effectiveSubgroupId = toPositiveInt(sku?.subgroup_id);
      const lineMeta = row?.meta && typeof row.meta === "object" ? row.meta : {};
      const lineUnitCode = String(lineMeta.unit || lineMeta.entry_unit || "").trim().toUpperCase();
      const lineStatus = String(lineMeta.status || lineMeta.row_status || "").trim().toUpperCase();
      const unitFromMeta = lineUnitCode === "PAIR" || lineUnitCode === "DZN" ? lineUnitCode : "";
      const unitFromStatus = lineStatus === "PACKED" ? "DZN" : lineStatus === "LOOSE" ? "PAIR" : "";
      const unitFromProductionExt = row.production_is_packed === true ? "DZN" : row.production_is_packed === false ? "PAIR" : "";
      const skuUnit = unitFromMeta || unitFromStatus || unitFromProductionExt || "PAIR";

      return {
        voucher_id: Number(row.voucher_id),
        line_id: Number(row.line_id),
        date: row.voucher_date,
        voucher_no: Number(row.voucher_no || 0),
        branch_name: String(row.branch_name || "-"),
        department_name: String(row.dept_name || "-"),
        labour_name: String(row.labour_name || "-"),
        stage_name: String(row.stage_name || row.stage_code || "-"),
        effective_sku_id: toPositiveInt(effectiveSkuId),
        effective_stage_id: toPositiveInt(row.effective_stage_id),
        line_kind: String(row.line_kind || "").trim().toUpperCase(),
        sku_code: String(sku?.sku_code || ""),
        sku_unit: skuUnit,
        article_id: toPositiveInt(sku?.article_id),
        production_type: effectiveProductionType === "FG" || effectiveProductionType === "SFG" ? effectiveProductionType : "",
        product_group_id: effectiveGroupId,
        product_group_name: String(sku?.group_name || "-"),
        product_subgroup_id: effectiveSubgroupId,
        product_subgroup_name: String(sku?.subgroup_name || "-"),
        qty: Number(Number(row.qty || 0).toFixed(3)),
      };
    });

  if (stageScope === "FINAL_ONLY") {
    const skuIdsForStageFilter = [...new Set(mappedRows.map((row) => toPositiveInt(row.effective_sku_id)).filter(Boolean))];
    const finalStageBySkuId = new Map();

    await Promise.all(
      skuIdsForStageFilter.map(async (skuId) => {
        try {
          const bomProfile = await loadBomProfileBySkuTx({ trx: knex, skuId });
          const stageRoutes = Array.isArray(bomProfile?.stageRoutes) ? bomProfile.stageRoutes : [];
          if (!stageRoutes.length) return;

          const requiredRoutes = stageRoutes
            .filter((route) => route.is_required !== false)
            .filter((route) => toPositiveInt(route?.stage_id));
          const candidateRoutes = requiredRoutes.length
            ? requiredRoutes
            : stageRoutes.filter((route) => toPositiveInt(route?.stage_id));
          if (!candidateRoutes.length) return;

          const finalRoute = [...candidateRoutes].sort((a, b) => Number(b.sequence_no || 0) - Number(a.sequence_no || 0))[0];
          const finalStageId = toPositiveInt(finalRoute?.stage_id);
          if (finalStageId) {
            finalStageBySkuId.set(Number(skuId), Number(finalStageId));
          }
        } catch (err) {
          console.error("Error in ProductionControlReportService:", err);
        }
      }),
    );

    mappedRows = mappedRows.filter((row) => {
      const skuId = toPositiveInt(row.effective_sku_id);
      const stageId = toPositiveInt(row.effective_stage_id);
      if (!skuId || !stageId) return false;
      const finalStageId = finalStageBySkuId.get(Number(skuId));
      if (!finalStageId) return false;
      return Number(stageId) === Number(finalStageId);
    });
  }

  const rows = mappedRows
    .filter((row) => {
      if (productionType !== "ALL" && row.production_type !== productionType) return false;
      if (selectedSkuUnit !== "ALL" && String(row.sku_unit || "").toUpperCase() !== selectedSkuUnit) return false;
      if (selectedArticleIds.length && (!row.article_id || !selectedArticleIds.includes(Number(row.article_id)))) return false;
      if (selectedProductGroupIds.length && (!row.product_group_id || !selectedProductGroupIds.includes(Number(row.product_group_id)))) return false;
      if (selectedProductSubgroupIds.length && (!row.product_subgroup_id || !selectedProductSubgroupIds.includes(Number(row.product_subgroup_id)))) return false;
      return true;
    });

  const compareText = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true });
  const summarizeNameSet = (valueSet = new Set()) => {
    const values = Array.from(valueSet.values())
      .map((value) => String(value || "").trim())
      .filter((value) => value && value !== "-")
      .sort((a, b) => compareText(a, b));
    if (!values.length) return "-";
    if (values.length <= 2) return values.join(", ");
    return `${values.slice(0, 2).join(", ")} +${values.length - 2}`;
  };
  const sortedRows = [...rows].sort((a, b) => {
    if (orderBy === "voucher") {
      const byVoucher = Number(a.voucher_no || 0) - Number(b.voucher_no || 0);
      if (byVoucher) return byVoucher;
      const byDate = compareText(a.date, b.date);
      if (byDate) return byDate;
      return Number(a.line_id || 0) - Number(b.line_id || 0);
    }
    if (orderBy === "sku") {
      const bySku = compareText(a.sku_code, b.sku_code);
      if (bySku) return bySku;
    } else if (orderBy === "department") {
      const byDept = compareText(a.department_name, b.department_name);
      if (byDept) return byDept;
    }
    const byDate = compareText(a.date, b.date);
    if (byDate) return byDate;
    const byVoucher = Number(a.voucher_no || 0) - Number(b.voucher_no || 0);
    if (byVoucher) return byVoucher;
    return Number(a.line_id || 0) - Number(b.line_id || 0);
  });

  const resolveGroupIdentity = (row) => {
    if (orderBy === "voucher") {
      const voucherId = Number(row.voucher_id || 0);
      const voucherNo = Number(row.voucher_no || 0);
      return { key: `voucher:${voucherId || voucherNo}`, label: voucherNo ? String(voucherNo) : "-" };
    }
    if (orderBy === "sku") return { key: `sku:${String(row.sku_code || "-").trim() || "-"}`, label: String(row.sku_code || "-") };
    if (orderBy === "department") return { key: `department:${String(row.department_name || "-").trim() || "-"}`, label: String(row.department_name || "-") };
    return { key: `voucher:${Number(row.voucher_id || 0)}`, label: String(row.voucher_no || "-") };
  };

  const detailGroupMap = new Map();
  sortedRows.forEach((row) => {
    const identity = resolveGroupIdentity(row);
    const existing = detailGroupMap.get(identity.key) || {
      key: identity.key,
      label: identity.label,
      rows: [],
      line_count: 0,
      voucher_ids: new Set(),
      department_names: new Set(),
      labour_names: new Set(),
      stage_names: new Set(),
      production_type_names: new Set(),
      unit_names: new Set(),
      product_group_names: new Set(),
      branch_names: new Set(),
      qty: 0,
      packed_qty: 0,
      loose_qty: 0,
    };
    existing.rows.push(row);
    existing.line_count += 1;
    existing.voucher_ids.add(Number(row.voucher_id || 0));
    if (String(row.department_name || "").trim()) existing.department_names.add(String(row.department_name || "").trim());
    if (String(row.labour_name || "").trim()) existing.labour_names.add(String(row.labour_name || "").trim());
    if (String(row.stage_name || "").trim()) existing.stage_names.add(String(row.stage_name || "").trim());
    if (String(row.production_type || "").trim()) existing.production_type_names.add(String(row.production_type || "").trim().toUpperCase());
    if (String(row.sku_unit || "").trim()) existing.unit_names.add(String(row.sku_unit || "").trim().toUpperCase());
    if (String(row.product_group_name || "").trim()) existing.product_group_names.add(String(row.product_group_name || "").trim());
    if (String(row.branch_name || "").trim()) existing.branch_names.add(String(row.branch_name || "").trim());
    existing.qty = Number(existing.qty || 0) + Number(row.qty || 0);
    if (String(row.sku_unit || "").trim().toUpperCase() === "DZN") {
      existing.packed_qty = Number(existing.packed_qty || 0) + Number(row.qty || 0);
    } else if (String(row.sku_unit || "").trim().toUpperCase() === "PAIR") {
      existing.loose_qty = Number(existing.loose_qty || 0) + Number(row.qty || 0);
    }
    detailGroupMap.set(identity.key, existing);
  });

  const groups = Array.from(detailGroupMap.values()).map((group) => ({
    key: group.key,
    label: group.label,
    rows: group.rows,
    line_count: Number(group.line_count || 0),
    voucher_count: group.voucher_ids.size,
    department_label: summarizeNameSet(group.department_names),
    labour_label: summarizeNameSet(group.labour_names),
    stage_label: summarizeNameSet(group.stage_names),
    production_type_label: summarizeNameSet(group.production_type_names),
    unit_label: summarizeNameSet(group.unit_names),
    product_group_label: summarizeNameSet(group.product_group_names),
    branch_label: summarizeNameSet(group.branch_names),
    qty: Number(Number(group.qty || 0).toFixed(3)),
    packed_qty: Number(Number(group.packed_qty || 0).toFixed(3)),
    loose_qty: Number(Number(group.loose_qty || 0).toFixed(3)),
  }))
    .sort((a, b) => {
      if (orderBy === "voucher") {
        const aNo = Number(a.label || 0);
        const bNo = Number(b.label || 0);
        if (Number.isFinite(aNo) && Number.isFinite(bNo) && aNo !== bNo) return aNo - bNo;
      }
      return compareText(a.label, b.label);
    });

  const summaryMap = new Map();
  sortedRows.forEach((row) => {
    const identity = resolveGroupIdentity(row);
    const existing = summaryMap.get(identity.key) || {
      group_key: identity.key,
      group_label: identity.label,
      voucher_ids: new Set(),
      branch_names: new Set(),
      department_names: new Set(),
      labour_names: new Set(),
      production_type_names: new Set(),
      unit_names: new Set(),
      product_group_names: new Set(),
      sku_codes: new Set(),
      first_date: null,
      last_date: null,
      qty: 0,
      packed_qty: 0,
      loose_qty: 0,
    };
    existing.voucher_ids.add(Number(row.voucher_id || 0));
    if (String(row.branch_name || "").trim() && String(row.branch_name || "").trim() !== "-") {
      existing.branch_names.add(String(row.branch_name || "").trim());
    }
    if (String(row.department_name || "").trim() && String(row.department_name || "").trim() !== "-") {
      existing.department_names.add(String(row.department_name || "").trim());
    }
    if (String(row.labour_name || "").trim() && String(row.labour_name || "").trim() !== "-") {
      existing.labour_names.add(String(row.labour_name || "").trim());
    }
    if (String(row.production_type || "").trim()) {
      existing.production_type_names.add(String(row.production_type || "").trim().toUpperCase());
    }
    if (String(row.sku_unit || "").trim()) {
      existing.unit_names.add(String(row.sku_unit || "").trim().toUpperCase());
    }
    if (String(row.product_group_name || "").trim() && String(row.product_group_name || "").trim() !== "-") {
      existing.product_group_names.add(String(row.product_group_name || "").trim());
    }
    if (String(row.sku_code || "").trim()) {
      existing.sku_codes.add(String(row.sku_code || "").trim());
    }
    const rowDate = String(row.date || "").trim();
    if (rowDate) {
      if (!existing.first_date || rowDate < existing.first_date) existing.first_date = rowDate;
      if (!existing.last_date || rowDate > existing.last_date) existing.last_date = rowDate;
    }
    existing.qty = Number(existing.qty || 0) + Number(row.qty || 0);
    if (String(row.sku_unit || "").trim().toUpperCase() === "DZN") {
      existing.packed_qty = Number(existing.packed_qty || 0) + Number(row.qty || 0);
    } else if (String(row.sku_unit || "").trim().toUpperCase() === "PAIR") {
      existing.loose_qty = Number(existing.loose_qty || 0) + Number(row.qty || 0);
    }
    summaryMap.set(identity.key, existing);
  });

  const summaryRows = Array.from(summaryMap.values())
    .map((row) => ({
      group_key: row.group_key,
      group_label: row.group_label,
      voucher_count: row.voucher_ids.size,
      branch_count: row.branch_names.size,
      branch_label: (() => {
        const names = Array.from(row.branch_names.values()).sort((a, b) => compareText(a, b));
        if (!names.length) return "-";
        if (names.length <= 2) return names.join(", ");
        return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
      })(),
      department_label: summarizeNameSet(row.department_names),
      labour_label: summarizeNameSet(row.labour_names),
      production_type_label: summarizeNameSet(row.production_type_names),
      unit_label: summarizeNameSet(row.unit_names),
      product_group_label: summarizeNameSet(row.product_group_names),
      sku_label: summarizeNameSet(row.sku_codes),
      date_from: row.first_date || null,
      date_to: row.last_date || null,
      qty: Number(Number(row.qty || 0).toFixed(3)),
      packed_qty: Number(Number(row.packed_qty || 0).toFixed(3)),
      loose_qty: Number(Number(row.loose_qty || 0).toFixed(3)),
    }))
    .sort((a, b) => {
      if (orderBy === "voucher") {
        const aNo = Number(a.group_label || 0);
        const bNo = Number(b.group_label || 0);
        if (Number.isFinite(aNo) && Number.isFinite(bNo) && aNo !== bNo) return aNo - bNo;
      }
      return compareText(a.group_label, b.group_label);
    });

  const totals = {
    qty: Number(sortedRows.reduce((acc, row) => acc + Number(row.qty || 0), 0).toFixed(3)),
    packedQty: Number(sortedRows.reduce((acc, row) => acc + (String(row.sku_unit || "").trim().toUpperCase() === "DZN" ? Number(row.qty || 0) : 0), 0).toFixed(3)),
    looseQty: Number(sortedRows.reduce((acc, row) => acc + (String(row.sku_unit || "").trim().toUpperCase() === "PAIR" ? Number(row.qty || 0) : 0), 0).toFixed(3)),
    lineCount: sortedRows.length,
    voucherCount: new Set(sortedRows.map((row) => Number(row.voucher_id || 0))).size,
    branchCount: new Set(
      sortedRows
        .map((row) => String(row.branch_name || "").trim())
        .filter((name) => name && name !== "-"),
    ).size,
  };

  return {
    filters,
    options,
    reportData: {
      rows: sortedRows,
      groups,
      summaryRows,
      totals,
    },
  };
};

const getProductionDepartmentWipReportPageData = async ({ req, input = {} }) => {
  const branchOptionsPromise = loadBranchOptions(req);
  const productGroupsPromise = knex("erp.product_groups")
    .select("id", "name")
    .where({ is_active: true })
    .orderBy("name", "asc");
  const productSubgroupsPromise = knex("erp.product_subgroups as sg")
    .select("sg.id", "sg.name", "sg.group_id")
    .where({ "sg.is_active": true })
    .whereExists(function whereSubgroupHasProductionItems() {
      this.select(1)
        .from("erp.items as i")
        .whereRaw("i.subgroup_id = sg.id")
        .andWhere("i.is_active", true)
        .whereIn("i.item_type", ["FG", "SFG"]);
    })
    .orderBy("sg.name", "asc");
  const articlesPromise = knex("erp.items as i")
    .select("i.id", "i.name")
    .where({ "i.is_active": true })
    .whereIn("i.item_type", ["FG", "SFG"])
    .whereExists(function whereItemHasActiveSku() {
      this.select(1)
        .from("erp.variants as v")
        .join("erp.skus as s", "s.variant_id", "v.id")
        .whereRaw("v.item_id = i.id")
        .andWhere("s.is_active", true);
    })
    .orderBy("i.name", "asc");

  const selectedBranchIds = normalizeBranchFilter({ req, input });
  const { asOfDate, invalidFilterInput } = normalizeAsOfDate(input);
  const selectedProductGroupIds = normalizeIdList(input?.product_group_ids || input?.productGroupIds);
  const selectedProductSubgroupIds = normalizeIdList(input?.product_subgroup_ids || input?.productSubgroupIds);
  const selectedArticleIds = normalizeIdList(input?.article_ids || input?.articleIds);
  const agingBucket = normalizeAgingBucket(input?.aging_bucket || input?.agingBucket);
  const reportType = normalizeReportType(input?.report_type || input?.reportType);
  const reportLoaded = String(input?.load_report || input?.loadReport || "").trim() === "1";

  const [branchOptions, productGroups, productSubgroups, articles] = await Promise.all([
    branchOptionsPromise,
    productGroupsPromise,
    productSubgroupsPromise,
    articlesPromise,
  ]);

  const filters = {
    reportLoaded,
    invalidFilterInput,
    asOfDate,
    branchIds: selectedBranchIds,
    productGroupIds: selectedProductGroupIds,
    productSubgroupIds: selectedProductSubgroupIds,
    articleIds: selectedArticleIds,
    agingBucket,
    reportType,
  };

  const options = {
    branches: branchOptions,
    productGroups,
    productSubgroups,
    articles,
    agingBuckets: [
      { value: "ALL", labelKey: "all", label: "All" },
      { value: "0_2", label: "0-2" },
      { value: "3_7", label: "3-7" },
      { value: "8_15", label: "8-15" },
      { value: "15_PLUS", label: "15+" },
    ],
    reportTypes: [
      { value: "details", labelKey: "details" },
      { value: "summary", labelKey: "summary" },
    ],
  };

  if (!reportLoaded) {
    return {
      filters,
      options,
      reportData: {
        detailRows: [],
        summaryRows: [],
        totals: {
          pendingPairs: 0,
          pendingDozen: 0,
          articleCount: 0,
          departmentCount: 0,
        },
      },
    };
  }

  let ledgerQuery = knex("erp.wip_dept_ledger as wl")
    .join("erp.skus as s", "s.id", "wl.sku_id")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
    .leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id")
    .leftJoin("erp.branches as b", "b.id", "wl.branch_id")
    .select(
      "wl.branch_id",
      "wl.dept_id",
      "wl.sku_id",
      "wl.txn_date",
      "wl.direction",
      "wl.qty_pairs",
      "b.name as branch_name",
      "s.sku_code",
      "i.id as article_id",
      "i.name as article_name",
      "i.item_type",
      "i.group_id",
      "i.subgroup_id",
      "pg.name as group_name",
      "sg.name as subgroup_name",
    )
    .whereIn("i.item_type", ["FG", "SFG"])
    .where("wl.txn_date", "<=", asOfDate);

  if (selectedBranchIds.length) {
    ledgerQuery = ledgerQuery.whereIn("wl.branch_id", selectedBranchIds);
  }

  if (selectedProductGroupIds.length) {
    ledgerQuery = ledgerQuery.whereIn("i.group_id", selectedProductGroupIds);
  }
  if (selectedProductSubgroupIds.length) {
    ledgerQuery = ledgerQuery.whereIn("i.subgroup_id", selectedProductSubgroupIds);
  }
  if (selectedArticleIds.length) {
    ledgerQuery = ledgerQuery.whereIn("i.id", selectedArticleIds);
  }

  const rawLedgerRows = await ledgerQuery
    .orderBy("wl.branch_id", "asc")
    .orderBy("wl.sku_id", "asc")
    .orderBy("wl.dept_id", "asc")
    .orderBy("wl.txn_date", "asc")
    .orderBy("wl.id", "asc");

  const skuById = new Map();
  const stageStats = new Map();
  const branchSkuKeys = new Set();

  rawLedgerRows.forEach((row) => {
    const branchId = toPositiveInt(row.branch_id);
    const skuId = toPositiveInt(row.sku_id);
    const deptId = toPositiveInt(row.dept_id);
    if (!branchId || !skuId || !deptId) return;

    const qtyPairs = Number(Number(row.qty_pairs || 0).toFixed(3));
    if (!(qtyPairs > 0)) return;

    const direction = Number(row.direction || 0) === 1 ? 1 : -1;
    const signedPairs = Number((direction === 1 ? qtyPairs : -qtyPairs).toFixed(3));
    const txnDate = toDateOnly(row.txn_date);
    const key = `${branchId}:${skuId}:${deptId}`;
    const existing = stageStats.get(key) || {
      closing_pairs: 0,
      last_in_date: null,
      branch_name: String(row.branch_name || "-"),
    };
    existing.closing_pairs = Number((Number(existing.closing_pairs || 0) + signedPairs).toFixed(3));
    if (direction === 1 && txnDate && (!existing.last_in_date || txnDate > existing.last_in_date)) {
      existing.last_in_date = txnDate;
    }
    stageStats.set(key, existing);
    branchSkuKeys.add(`${branchId}:${skuId}`);

    if (!skuById.has(Number(skuId))) {
      skuById.set(Number(skuId), {
        sku_id: Number(skuId),
        sku_code: String(row.sku_code || "-"),
        article_id: toPositiveInt(row.article_id),
        article_name: String(row.article_name || "-"),
        item_type: String(row.item_type || "").trim().toUpperCase(),
        group_id: toPositiveInt(row.group_id),
        subgroup_id: toPositiveInt(row.subgroup_id),
        group_name: String(row.group_name || "-"),
        subgroup_name: String(row.subgroup_name || "-"),
      });
    }
  });

  if (!branchSkuKeys.size) {
    return {
      filters,
      options,
      reportData: {
        detailRows: [],
        summaryRows: [],
        totals: {
          pendingPairs: 0,
          pendingDozen: 0,
          articleCount: 0,
          departmentCount: 0,
        },
      },
    };
  }

  const skuIds = [...new Set(Array.from(branchSkuKeys.values()).map((entry) => Number(String(entry).split(":")[1])).filter(Boolean))];
  const routeChainBySku = new Map();
  await Promise.all(
    skuIds.map(async (skuId) => {
      try {
        const profile = await loadBomProfileBySkuTx({ trx: knex, skuId });
        const stageRoutes = Array.isArray(profile?.stageRoutes) ? profile.stageRoutes : [];
        if (!stageRoutes.length) return;
        const requiredRoutes = stageRoutes
          .filter((route) => route.is_required !== false)
          .filter((route) => toPositiveInt(route?.stage_id));
        const effectiveRoutes = requiredRoutes.length
          ? requiredRoutes
          : stageRoutes.filter((route) => toPositiveInt(route?.stage_id));
        if (effectiveRoutes.length < 2) return;
        routeChainBySku.set(
          Number(skuId),
          [...effectiveRoutes]
            .sort((a, b) => Number(a.sequence_no || 0) - Number(b.sequence_no || 0))
            .map((route) => ({
              stage_id: Number(route.stage_id),
              sequence_no: Number(route.sequence_no || 0),
              dept_id: toPositiveInt(route.dept_id) || toPositiveInt(route.stage_id),
              stage_name: String(route.stage_name || ""),
            })),
        );
      } catch (err) {
        console.error("Error in ProductionDepartmentWipReportService:", err);
      }
    }),
  );

  const deptIds = [...new Set(
    Array.from(routeChainBySku.values())
      .flatMap((routes) => routes.map((route) => toPositiveInt(route.dept_id)))
      .filter(Boolean),
  )];
  const deptRows = deptIds.length
    ? await knex("erp.departments").select("id", "name").whereIn("id", deptIds)
    : [];
  const deptNameById = new Map(deptRows.map((row) => [Number(row.id), String(row.name || "-")]));

  const dayMs = 24 * 60 * 60 * 1000;
  const asOfTs = Date.parse(asOfDate);

  const detailRows = [];
  Array.from(branchSkuKeys.values()).forEach((entry) => {
    const [branchIdRaw, skuIdRaw] = String(entry).split(":");
    const branchId = Number(branchIdRaw || 0);
    const skuId = Number(skuIdRaw || 0);
    if (!branchId || !skuId) return;

    const routes = routeChainBySku.get(Number(skuId));
    if (!Array.isArray(routes) || routes.length < 2) return;
    const sku = skuById.get(Number(skuId));
    for (let i = 1; i < routes.length; i += 1) {
      const previousRoute = routes[i - 1];
      const currentRoute = routes[i];
      const previousDeptId = toPositiveInt(previousRoute.dept_id);
      const currentDeptId = toPositiveInt(currentRoute.dept_id);
      if (!previousDeptId || !currentDeptId) continue;

      // Pending for next department is predecessor's net closing WIP balance.
      // This automatically excludes abnormal loss/consumption/conversion that already moved OUT.
      const previousStats = stageStats.get(`${branchId}:${skuId}:${Number(previousDeptId)}`);
      const pendingPairs = Number(Number(previousStats?.closing_pairs || 0).toFixed(3));
      if (!(pendingPairs > 0)) continue;

      let agingDays = 0;
      const referenceDate = previousStats?.last_in_date || null;
      if (referenceDate && Number.isFinite(asOfTs)) {
        const refTs = Date.parse(referenceDate);
        if (Number.isFinite(refTs)) {
          agingDays = Math.max(0, Math.floor((asOfTs - refTs) / dayMs));
        }
      }
      if (!matchesAgingBucket(agingBucket, agingDays)) continue;

      const departmentName = currentDeptId
        ? (deptNameById.get(Number(currentDeptId)) || "-")
        : "-";
      const pendingDozen = Number((pendingPairs / 12).toFixed(3));
      const rowBucket = resolveAgingBucketByDays(agingDays);

      detailRows.push({
        department_id: Number(currentDeptId),
        department_name: departmentName,
        stage_id: Number(currentRoute.stage_id),
        stage_name: String(currentRoute.stage_name || "-"),
        sku_id: Number(skuId),
        sku_code: String(sku?.sku_code || "-"),
        article_id: toPositiveInt(sku?.article_id),
        article_name: String(sku?.article_name || "-"),
        product_group_name: String(sku?.group_name || "-"),
        production_type: String(sku?.item_type || "").trim().toUpperCase() || "-",
        branch_id: Number(branchId),
        branch_name: String(previousStats?.branch_name || "-"),
        pending_pairs: pendingPairs,
        pending_dozen: pendingDozen,
        aging_days: Number(agingDays || 0),
        aging_bucket: rowBucket,
      });
    }
  });

  detailRows.sort((a, b) => {
    const byDept = String(a.department_name || "").localeCompare(String(b.department_name || ""));
    if (byDept) return byDept;
    const byPending = Number(b.pending_pairs || 0) - Number(a.pending_pairs || 0);
    if (byPending) return byPending;
    const byAging = Number(b.aging_days || 0) - Number(a.aging_days || 0);
    if (byAging) return byAging;
    const bySku = String(a.sku_code || "").localeCompare(String(b.sku_code || ""));
    if (bySku) return bySku;
    return String(a.branch_name || "").localeCompare(String(b.branch_name || ""));
  });

  const summaryMap = new Map();
  detailRows.forEach((row) => {
    const key = row.department_id ? `dept:${Number(row.department_id)}` : `dept:${String(row.department_name || "-")}`;
    const existing = summaryMap.get(key) || {
      department_id: row.department_id || null,
      department_name: row.department_name || "-",
      article_ids: new Set(),
      branch_names: new Set(),
      pending_pairs: 0,
      aging_sum: 0,
      aging_max: 0,
      row_count: 0,
    };
    if (row.article_id) existing.article_ids.add(Number(row.article_id));
    if (String(row.branch_name || "").trim() && String(row.branch_name || "").trim() !== "-") {
      existing.branch_names.add(String(row.branch_name || "").trim());
    }
    existing.pending_pairs = Number(existing.pending_pairs || 0) + Number(row.pending_pairs || 0);
    existing.aging_sum = Number(existing.aging_sum || 0) + Number(row.aging_days || 0);
    existing.aging_max = Math.max(Number(existing.aging_max || 0), Number(row.aging_days || 0));
    existing.row_count += 1;
    summaryMap.set(key, existing);
  });

  const summaryRows = Array.from(summaryMap.values())
    .map((row) => ({
      department_id: row.department_id,
      department_name: row.department_name,
      pending_articles: row.article_ids.size,
      avg_aging_days: row.row_count > 0 ? Number((Number(row.aging_sum || 0) / Number(row.row_count || 1)).toFixed(2)) : 0,
      max_aging_days: Number(row.aging_max || 0),
      pending_pairs: Number(Number(row.pending_pairs || 0).toFixed(3)),
      pending_dozen: Number((Number(row.pending_pairs || 0) / 12).toFixed(3)),
      branch_label: (() => {
        const names = Array.from(row.branch_names.values()).sort((a, b) => String(a).localeCompare(String(b)));
        if (!names.length) return "-";
        if (names.length <= 2) return names.join(", ");
        return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
      })(),
    }))
    .sort((a, b) => {
      const byPending = Number(b.pending_pairs || 0) - Number(a.pending_pairs || 0);
      if (byPending) return byPending;
      return String(a.department_name || "").localeCompare(String(b.department_name || ""));
    });

  const totals = {
    pendingPairs: Number(detailRows.reduce((sum, row) => sum + Number(row.pending_pairs || 0), 0).toFixed(3)),
    pendingDozen: Number(detailRows.reduce((sum, row) => sum + Number(row.pending_dozen || 0), 0).toFixed(3)),
    articleCount: new Set(detailRows.map((row) => Number(row.article_id || 0)).filter(Boolean)).size,
    departmentCount: new Set(detailRows.map((row) => String(row.department_name || "").trim()).filter(Boolean)).size,
  };

  return {
    filters,
    options,
    reportData: {
      detailRows,
      summaryRows,
      totals,
    },
  };
};

const getProductionDepartmentWipLedgerReportPageData = async ({
  req,
  input = {},
}) => {
  const branchOptionsPromise = loadBranchOptions(req);
  const departmentsPromise = knex("erp.departments")
    .select("id", "name")
    .where({ is_active: true, is_production: true })
    .orderBy("name", "asc");
  const skusPromise = knex("erp.skus as s")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .select("s.id", "s.sku_code", "i.name as article_name")
    .where({ "s.is_active": true, "i.is_active": true })
    .whereIn("i.item_type", ["FG", "SFG"])
    .orderBy("s.sku_code", "asc");

  const selectedBranchIds = normalizeBranchFilter({ req, input });
  const rawFromDate = String(input?.from_date || input?.fromDate || "").trim();
  const rawToDate = String(input?.to_date || input?.toDate || "").trim();
  const fromDate = toDateOnly(rawFromDate);
  const toDate = toDateOnly(rawToDate);
  const invalidFilterInput =
    (Boolean(rawFromDate) && !fromDate) || (Boolean(rawToDate) && !toDate);
  const selectedDepartmentId = toPositiveInt(
    input?.department_id || input?.departmentId,
  );
  const selectedSkuId = toPositiveInt(input?.sku_id || input?.skuId);
  const reportType = normalizeReportType(input?.report_type || input?.reportType);
  const reportLoaded =
    String(input?.load_report || input?.loadReport || "").trim() === "1";

  const [branchOptions, departments, skus] = await Promise.all([
    branchOptionsPromise,
    departmentsPromise,
    skusPromise,
  ]);

  const validDepartmentId = selectedDepartmentId &&
    departments.some((row) => Number(row.id) === Number(selectedDepartmentId))
    ? Number(selectedDepartmentId)
    : null;
  const validSkuId = selectedSkuId &&
    skus.some((row) => Number(row.id) === Number(selectedSkuId))
    ? Number(selectedSkuId)
    : null;
  const missingRequiredFilters = reportLoaded && (!validDepartmentId || !validSkuId);

  const filters = {
    reportLoaded,
    invalidFilterInput,
    missingRequiredFilters,
    fromDate: fromDate || "",
    toDate: toDate || "",
    branchIds: selectedBranchIds,
    departmentId: validDepartmentId,
    skuId: validSkuId,
    reportType,
  };

  const options = {
    branches: branchOptions,
    departments,
    skus,
    reportTypes: [
      { value: "details", labelKey: "details" },
      { value: "summary", labelKey: "summary" },
    ],
  };

  if (!reportLoaded || missingRequiredFilters) {
    return {
      filters,
      options,
      reportData: {
        detailGroups: [],
        summaryRows: [],
        totals: {
          openingPairs: 0,
          inPairs: 0,
          outPairs: 0,
          closingPairs: 0,
          closingDozen: 0,
          skuCount: 0,
          departmentCount: 0,
        },
      },
    };
  }

  if (fromDate && toDate && fromDate > toDate) {
    throw new HttpError(
      400,
      req?.res?.locals?.t?.("invalid_date_range") || "Invalid date range.",
    );
  }
  const effectiveToDate = toDate || getTodayDateOnly();

  let query = knex("erp.wip_dept_ledger as wl")
    .join("erp.departments as d", "d.id", "wl.dept_id")
    .join("erp.skus as s", "s.id", "wl.sku_id")
    .join("erp.variants as v", "v.id", "s.variant_id")
    .join("erp.items as i", "i.id", "v.item_id")
    .leftJoin("erp.product_groups as pg", "pg.id", "i.group_id")
    .leftJoin("erp.product_subgroups as sg", "sg.id", "i.subgroup_id")
    .leftJoin("erp.branches as b", "b.id", "wl.branch_id")
    .leftJoin("erp.voucher_header as vh", "vh.id", "wl.source_voucher_id")
    .select(
      "wl.id",
      "wl.branch_id",
      "wl.dept_id",
      "wl.sku_id",
      "wl.txn_date",
      "wl.direction",
      "wl.qty_pairs",
      "wl.source_voucher_id",
      "vh.voucher_no",
      "vh.voucher_type_code",
      "vh.status as source_voucher_status",
      "d.name as department_name",
      "b.name as branch_name",
      "s.sku_code",
      "i.id as article_id",
      "i.name as article_name",
      "i.item_type",
      "i.group_id",
      "i.subgroup_id",
      "pg.name as group_name",
      "sg.name as subgroup_name",
    )
    .whereIn("i.item_type", ["FG", "SFG"])
    .where("wl.dept_id", Number(validDepartmentId))
    .where("wl.sku_id", Number(validSkuId))
    .where("wl.txn_date", "<=", effectiveToDate);

  if (selectedBranchIds.length) {
    query = query.whereIn("wl.branch_id", selectedBranchIds);
  }

  const rawRows = await query
    .orderBy("wl.branch_id", "asc")
    .orderBy("wl.dept_id", "asc")
    .orderBy("wl.sku_id", "asc")
    .orderBy("wl.txn_date", "asc")
    .orderBy("wl.id", "asc");

  const asOfDate = effectiveToDate;
  const asOfTs = Date.parse(asOfDate);
  const dayMs = 24 * 60 * 60 * 1000;
  const groupMap = new Map();

  rawRows.forEach((row) => {
    const branchId = toPositiveInt(row.branch_id);
    const deptId = toPositiveInt(row.dept_id);
    const skuId = toPositiveInt(row.sku_id);
    if (!branchId || !deptId || !skuId) return;

    const key = `${branchId}:${deptId}:${skuId}`;
    const group = groupMap.get(key) || {
      key,
      branch_id: Number(branchId),
      branch_name: String(row.branch_name || "-"),
      department_id: Number(deptId),
      department_name: String(row.department_name || "-"),
      sku_id: Number(skuId),
      sku_code: String(row.sku_code || "-"),
      article_id: toPositiveInt(row.article_id),
      article_name: String(row.article_name || "-"),
      product_group_id: toPositiveInt(row.group_id),
      product_group_name: String(row.group_name || "-"),
      product_subgroup_id: toPositiveInt(row.subgroup_id),
      product_subgroup_name: String(row.subgroup_name || "-"),
      production_type:
        String(row.item_type || "").trim().toUpperCase() || "-",
      opening_pairs: 0,
      in_pairs: 0,
      out_pairs: 0,
      closing_pairs: 0,
      last_in_date: null,
      transactions: [],
    };

    const txnDate = toDateOnly(row.txn_date);
    const qtyPairs = Number(Number(row.qty_pairs || 0).toFixed(3));
    if (!(qtyPairs > 0)) {
      groupMap.set(key, group);
      return;
    }

    const direction = Number(row.direction || 0) === 1 ? 1 : -1;
    const signedPairs = Number((direction === 1 ? qtyPairs : -qtyPairs).toFixed(3));
    if (direction === 1 && txnDate && (!group.last_in_date || txnDate > group.last_in_date)) {
      group.last_in_date = txnDate;
    }

    if (fromDate && txnDate && txnDate < fromDate) {
      group.opening_pairs = Number(
        (Number(group.opening_pairs || 0) + signedPairs).toFixed(3),
      );
      groupMap.set(key, group);
      return;
    }

    if (direction === 1) {
      group.in_pairs = Number(
        (Number(group.in_pairs || 0) + qtyPairs).toFixed(3),
      );
    } else {
      group.out_pairs = Number(
        (Number(group.out_pairs || 0) + qtyPairs).toFixed(3),
      );
    }

    group.transactions.push({
      id: Number(row.id || 0),
      txn_date: txnDate,
      direction,
      qty_pairs: qtyPairs,
      in_pairs: direction === 1 ? qtyPairs : 0,
      out_pairs: direction === -1 ? qtyPairs : 0,
      signed_pairs: signedPairs,
      source_voucher_id: toPositiveInt(row.source_voucher_id),
      voucher_no: toPositiveInt(row.voucher_no),
      voucher_type_code: String(row.voucher_type_code || "").trim().toUpperCase(),
      source_voucher_status: String(row.source_voucher_status || "").trim().toUpperCase(),
    });
    groupMap.set(key, group);
  });

  const detailGroups = [];
  groupMap.forEach((group) => {
    const openingPairs = Number(Number(group.opening_pairs || 0).toFixed(3));
    let runningPairs = openingPairs;
    const transactionRows = (group.transactions || []).map((row) => {
      runningPairs = Number((runningPairs + Number(row.signed_pairs || 0)).toFixed(3));
      return {
        ...row,
        balance_pairs: Number(runningPairs),
        balance_dozen: Number((runningPairs / 12).toFixed(3)),
      };
    });

    const closingPairs = Number(runningPairs.toFixed(3));
    if (!(closingPairs > 0)) return;

    let agingDays = 0;
    if (group.last_in_date && Number.isFinite(asOfTs)) {
      const refTs = Date.parse(group.last_in_date);
      if (Number.isFinite(refTs)) {
        agingDays = Math.max(0, Math.floor((asOfTs - refTs) / dayMs));
      }
    }

    detailGroups.push({
      key: group.key,
      branch_id: group.branch_id,
      branch_name: group.branch_name,
      department_id: group.department_id,
      department_name: group.department_name,
      sku_id: group.sku_id,
      sku_code: group.sku_code,
      article_id: group.article_id,
      article_name: group.article_name,
      product_group_id: group.product_group_id,
      product_group_name: group.product_group_name,
      product_subgroup_id: group.product_subgroup_id,
      product_subgroup_name: group.product_subgroup_name,
      production_type: group.production_type,
      aging_days: Number(agingDays || 0),
      opening_pairs: openingPairs,
      opening_dozen: Number((openingPairs / 12).toFixed(3)),
      in_pairs: Number(Number(group.in_pairs || 0).toFixed(3)),
      out_pairs: Number(Number(group.out_pairs || 0).toFixed(3)),
      closing_pairs: closingPairs,
      closing_dozen: Number((closingPairs / 12).toFixed(3)),
      last_in_date: group.last_in_date || null,
      rows: transactionRows,
    });
  });

  detailGroups.sort((a, b) => {
    const byDept = String(a.department_name || "").localeCompare(
      String(b.department_name || ""),
    );
    if (byDept) return byDept;
    const bySku = String(a.sku_code || "").localeCompare(String(b.sku_code || ""));
    if (bySku) return bySku;
    return String(a.branch_name || "").localeCompare(String(b.branch_name || ""));
  });

  const summaryRows = detailGroups.map((group) => ({
    branch_name: group.branch_name,
    department_name: group.department_name,
    article_name: group.article_name,
    sku_code: group.sku_code,
    product_group_name: group.product_group_name,
    production_type: group.production_type,
    aging_days: Number(group.aging_days || 0),
    opening_pairs: Number(group.opening_pairs || 0),
    opening_dozen: Number(group.opening_dozen || 0),
    in_pairs: Number(group.in_pairs || 0),
    out_pairs: Number(group.out_pairs || 0),
    closing_pairs: Number(group.closing_pairs || 0),
    closing_dozen: Number(group.closing_dozen || 0),
  }));

  const totals = detailGroups.reduce(
    (acc, group) => ({
      openingPairs: Number(
        (Number(acc.openingPairs || 0) + Number(group.opening_pairs || 0)).toFixed(3),
      ),
      inPairs: Number(
        (Number(acc.inPairs || 0) + Number(group.in_pairs || 0)).toFixed(3),
      ),
      outPairs: Number(
        (Number(acc.outPairs || 0) + Number(group.out_pairs || 0)).toFixed(3),
      ),
      closingPairs: Number(
        (Number(acc.closingPairs || 0) + Number(group.closing_pairs || 0)).toFixed(3),
      ),
      closingDozen: Number(
        (Number(acc.closingDozen || 0) + Number(group.closing_dozen || 0)).toFixed(3),
      ),
      skuCount: Number(acc.skuCount || 0) + 1,
      departmentSet: (() => {
        const next = acc.departmentSet || new Set();
        next.add(String(group.department_name || "").trim());
        return next;
      })(),
    }),
    {
      openingPairs: 0,
      inPairs: 0,
      outPairs: 0,
      closingPairs: 0,
      closingDozen: 0,
      skuCount: 0,
      departmentSet: new Set(),
    },
  );

  return {
    filters,
    options,
    reportData: {
      detailGroups,
      summaryRows,
      totals: {
        openingPairs: Number(totals.openingPairs || 0),
        inPairs: Number(totals.inPairs || 0),
        outPairs: Number(totals.outPairs || 0),
        closingPairs: Number(totals.closingPairs || 0),
        closingDozen: Number(totals.closingDozen || 0),
        skuCount: Number(totals.skuCount || 0),
        departmentCount: Number((totals.departmentSet || new Set()).size),
      },
    },
  };
};

const getProductionPlannedConsumptionReportPageData = async ({ req, input = {} }) => {
  const branchOptions = await loadBranchOptions(req);
  const selectedBranchIds = normalizeBranchFilter({ req, input });
  const fromDate = toDateOnly(input?.from_date || input?.fromDate);
  const toDate = toDateOnly(input?.to_date || input?.toDate);
  const planKind = normalizePlanKind(input?.plan_kind || input?.planKind);
  const reportLoaded = String(input?.load_report || input?.loadReport || "").trim() === "1";

  const filters = {
    reportLoaded,
    fromDate: fromDate || "",
    toDate: toDate || "",
    branchIds: selectedBranchIds,
    planKind,
  };

  const options = {
    branches: branchOptions,
    planKinds: [
      { value: "ALL", labelKey: "all" },
      { value: "FG", labelKey: "finished" },
      { value: "SFG", labelKey: "semi_finished" },
    ],
  };

  if (!reportLoaded) {
    return {
      filters,
      options,
      reportData: {
        rows: [],
        totals: {
          plannedQty: 0,
          availableQty: 0,
          shortQty: 0,
        },
      },
    };
  }

  if (fromDate && toDate && fromDate > toDate) {
    throw new HttpError(400, req?.res?.locals?.t?.("invalid_date_range") || "Invalid date range.");
  }

  const planLines = await loadApprovedPlanLines({
    branchIds: selectedBranchIds,
    fromDate,
    toDate,
    planKind,
  });

  const skuIds = [...new Set(planLines.map((row) => toPositiveInt(row?.sku_id)).filter(Boolean))];
  const bomBySku = new Map();

  await Promise.all(
    skuIds.map(async (skuId) => {
      const profile = await loadBomProfileBySkuTx({ trx: knex, skuId });
      if (profile) bomBySku.set(Number(skuId), profile);
    }),
  );

  const plannedByItem = new Map();
  const addPlanned = (itemId, uomId, qty) => {
    const key = `${Number(itemId)}:${Number(uomId || 0)}`;
    const row = plannedByItem.get(key) || {
      item_id: Number(itemId),
      uom_id: toPositiveInt(uomId),
      planned_qty: 0,
    };
    row.planned_qty = Number(row.planned_qty || 0) + Number(qty || 0);
    plannedByItem.set(key, row);
  };

  for (const line of planLines) {
    const skuId = Number(line?.sku_id || 0);
    const totalPairs = Number(line?.total_pairs || 0);
    if (!skuId || !Number.isFinite(totalPairs) || totalPairs <= 0) continue;
    const bom = bomBySku.get(skuId);
    if (!bom) continue;

    const outputQtyInPairs = Number((Number(bom.outputQty || 0) * Number(bom.outputUomFactorToPair || 0)).toFixed(6));
    if (!Number.isFinite(outputQtyInPairs) || outputQtyInPairs <= 0) continue;
    const ratio = Number((totalPairs / outputQtyInPairs).toFixed(12));

    for (const rmLine of Array.isArray(bom.rmLines) ? bom.rmLines : []) {
      const override = bom?.skuOverrideByRmDept?.get(`${Number(rmLine.rm_item_id)}:${Number(rmLine.dept_id)}`) || null;
      if (override?.is_excluded === true) continue;
      const hasOverrideQty = Number.isFinite(Number(override?.override_qty)) && Number(override?.override_qty) >= 0;
      const baseQty = hasOverrideQty ? Number(override.override_qty) : Number(rmLine.qty || 0);
      if (baseQty <= 0) continue;
      const lossFactor = 1 + (Number(rmLine.normal_loss_pct || 0) / 100);
      const plannedQty = Number((baseQty * ratio * lossFactor).toFixed(3));
      if (!(plannedQty > 0)) continue;
      const replacementItemId = toPositiveInt(override?.replacement_rm_item_id);
      const itemId = replacementItemId || Number(rmLine.rm_item_id);
      const uomId = toPositiveInt(override?.override_uom_id) || toPositiveInt(rmLine.uom_id);
      addPlanned(itemId, uomId, plannedQty);
    }
  }

  const plannedRows = [...plannedByItem.values()];
  const itemIds = [...new Set(plannedRows.map((row) => Number(row.item_id)).filter(Boolean))];
  const uomIds = [...new Set(plannedRows.map((row) => toPositiveInt(row.uom_id)).filter(Boolean))];

  const [itemRows, uomRows, availableRows] = await Promise.all([
    itemIds.length
      ? knex("erp.items")
          .select("id", "name")
          .whereIn("id", itemIds)
      : Promise.resolve([]),
    uomIds.length
      ? knex("erp.uom")
          .select("id", "code")
          .whereIn("id", uomIds)
      : Promise.resolve([]),
    itemIds.length
      ? knex("erp.stock_balance_rm as sb")
          .select("sb.item_id")
          .sum({ qty: knex.raw("COALESCE(sb.qty, 0)") })
          .where({ "sb.stock_state": "ON_HAND" })
          .modify((query) => {
            if (selectedBranchIds.length) query.whereIn("sb.branch_id", selectedBranchIds);
          })
          .whereIn("sb.item_id", itemIds)
          .groupBy("sb.item_id")
      : Promise.resolve([]),
  ]);

  const itemNameById = new Map(itemRows.map((row) => [Number(row.id), String(row.name || `#${row.id}`)]));
  const uomCodeById = new Map(uomRows.map((row) => [Number(row.id), String(row.code || "")]));
  const availableByItem = new Map(availableRows.map((row) => [Number(row.item_id), Number(row.qty || 0)]));

  const rows = plannedRows
    .map((row) => {
      const plannedQty = Number(Number(row.planned_qty || 0).toFixed(3));
      const availableQty = Number(Number(availableByItem.get(Number(row.item_id)) || 0).toFixed(3));
      const shortQty = Number(Math.max(0, plannedQty - availableQty).toFixed(3));
      const coveragePct = plannedQty > 0
        ? Number((Math.min(100, (availableQty / plannedQty) * 100)).toFixed(2))
        : 0;
      return {
        item_id: Number(row.item_id),
        item_name: itemNameById.get(Number(row.item_id)) || `#${row.item_id}`,
        uom_code: uomCodeById.get(Number(row.uom_id)) || "",
        planned_qty: plannedQty,
        available_qty: availableQty,
        short_qty: shortQty,
        coverage_pct: coveragePct,
      };
    })
    .sort((a, b) => String(a.item_name).localeCompare(String(b.item_name)));

  const totals = rows.reduce(
    (acc, row) => ({
      plannedQty: Number((acc.plannedQty + Number(row.planned_qty || 0)).toFixed(3)),
      availableQty: Number((acc.availableQty + Number(row.available_qty || 0)).toFixed(3)),
      shortQty: Number((acc.shortQty + Number(row.short_qty || 0)).toFixed(3)),
    }),
    { plannedQty: 0, availableQty: 0, shortQty: 0 },
  );

  return {
    filters,
    options,
    reportData: {
      rows,
      totals,
      planLinesCount: Number(planLines.length || 0),
    },
  };
};

module.exports = {
  getProductionPlannedConsumptionReportPageData,
  getProductionControlReportPageData,
  getProductionDepartmentWipReportPageData,
  getProductionDepartmentWipLedgerReportPageData,
};
