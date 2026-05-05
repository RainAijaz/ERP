require("dotenv").config();

const knex = require("../db/knex");
const {
  getBomVersionHistoryReportPageData,
  getBomLifecycleStatusReportPageData,
  getBomApprovalQueueAgingReportPageData,
  getBomChangeLogReportPageData,
  getBomCostBreakdownReportPageData,
} = require("../services/bom/bom-report-service");

const toDateOnly = (date) => {
  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const buildReq = async () => {
  const anyUser = await knex("erp.users").select("id").orderBy("id", "asc").first();
  return {
    user: {
      id: Number(anyUser?.id || 1),
      isAdmin: true,
    },
    branchScope: [],
    res: {
      locals: {
        t: (key) => key,
      },
    },
  };
};

const resolveSampleItemIds = async () => {
  const approved = await knex("erp.bom_header")
    .distinct("item_id")
    .where("status", "APPROVED")
    .orderBy("item_id", "asc")
    .limit(3);
  const approvedIds = approved
    .map((row) => Number(row.item_id || 0))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (approvedIds.length) return approvedIds;

  const anyBom = await knex("erp.bom_header")
    .distinct("item_id")
    .orderBy("item_id", "asc")
    .limit(3);
  return anyBom
    .map((row) => Number(row.item_id || 0))
    .filter((id) => Number.isInteger(id) && id > 0);
};

const run = async () => {
  const req = await buildReq();
  const itemIds = await resolveSampleItemIds();
  const itemIdsCsv = itemIds.join(",");

  const today = new Date();
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - 30);
  const fromDateText = toDateOnly(fromDate);
  const toDateText = toDateOnly(today);

  const checks = [
    {
      name: "Version History",
      fn: () =>
        getBomVersionHistoryReportPageData({
          req,
          input: {
            load_report: "1",
            item_ids: itemIdsCsv,
            from_date: fromDateText,
            to_date: toDateText,
          },
        }),
      rows: (data) => Number(data?.reportData?.rows?.length || 0),
    },
    {
      name: "Lifecycle Status",
      fn: () =>
        getBomLifecycleStatusReportPageData({
          req,
          input: {
            load_report: "1",
            from_date: fromDateText,
            to_date: toDateText,
          },
        }),
      rows: (data) => Number(data?.reportData?.rows?.length || 0),
    },
    {
      name: "Approval Queue Aging",
      fn: () =>
        getBomApprovalQueueAgingReportPageData({
          req,
          input: {
            load_report: "1",
            request_status: "PENDING",
            from_date: fromDateText,
            to_date: toDateText,
          },
        }),
      rows: (data) => Number(data?.reportData?.rows?.length || 0),
    },
    {
      name: "Change Log",
      fn: () =>
        getBomChangeLogReportPageData({
          req,
          input: {
            load_report: "1",
            item_ids: itemIdsCsv,
            limit: 25,
          },
        }),
      rows: (data) => Number(data?.reportData?.rows?.length || 0),
    },
    {
      name: "Cost Breakdown (Direct)",
      fn: () =>
        getBomCostBreakdownReportPageData({
          req,
          input: {
            load_report: "1",
            item_ids: itemIdsCsv,
            explosion_mode: "DIRECT",
            valuation_mode: "WAC_FALLBACK_PURCHASE",
            labour_aggregation: "AVG",
          },
        }),
      rows: (data) => Number(data?.reportData?.summaryRows?.length || 0),
    },
    {
      name: "Cost Breakdown (Exploded)",
      fn: () =>
        getBomCostBreakdownReportPageData({
          req,
          input: {
            load_report: "1",
            item_ids: itemIdsCsv,
            explosion_mode: "EXPLODED",
            valuation_mode: "WAC_FALLBACK_PURCHASE",
            labour_aggregation: "AVG",
          },
        }),
      rows: (data) => Number(data?.reportData?.summaryRows?.length || 0),
    },
  ];

  if (!itemIds.length) {
    throw new Error("No BOM items found in erp.bom_header; cannot run BOM ledger reports.");
  }

  console.log("BOM report DB smoke run started");
  console.log(`Sample item IDs: ${itemIdsCsv}`);
  console.log(`Window: ${fromDateText} -> ${toDateText}`);

  for (const check of checks) {
    const startedAt = Date.now();
    const payload = await check.fn();
    const rowCount = check.rows(payload);
    const elapsed = Date.now() - startedAt;
    console.log(`[PASS] ${check.name}: rows=${rowCount}, elapsedMs=${elapsed}`);
  }

  console.log("BOM report DB smoke run completed successfully.");
};

run()
  .catch((err) => {
    console.error("BOM report DB smoke run failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await knex.destroy();
    } catch (err) {
      // no-op
    }
  });
