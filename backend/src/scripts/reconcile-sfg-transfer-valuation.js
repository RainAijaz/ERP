// Preview by default. Apply requires a reviewed baseline hash and a real ERP
// actor, whose role/permissions are loaded through the shared auth service.
const knex = require("../db/knex");
const { loadUserContext } = require("../middleware/core/auth");
const { canAccessScope } = require("../middleware/access/role-permissions");
const { resolveTranslation } = require("../middleware/core/locale");
const { previewSfgValuation, reconcileSfgValuation } = require("../services/inventory/sfg-valuation-reconciliation-service");
const readArg = (name) => process.argv.find((arg)=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const main = async () => {
  const rawIds = readArg("sku-ids") || readArg("sku-id");
  const skuIds = rawIds ? rawIds.split(",").map(Number) : [];
  if (skuIds.some((n)=>!Number.isSafeInteger(n)||n<=0)) throw Error("Invalid SKU filter");
  const apply = process.argv.includes("--apply");
  if (!apply) {
    const plan = await previewSfgValuation({skuIds,eligibleOnly:process.argv.includes("--eligible")});
    console.log(JSON.stringify({mode:"PREVIEW",hash:plan.hash,skuIds:plan.skuIds,stockEntries:plan.changes.length,
      productionWipEntries:plan.wipChanges.length,transferLines:plan.lineChanges.length,stockBalances:plan.balanceChanges.length,
      wipBalances:plan.wipBalanceChanges.length,valueOnlyAdjustments:plan.adjustments.length,
      blocked:plan.blockers,skipped:plan.skipped||[],quantityShortages:plan.shortages},null,2));
    return;
  }
  const actorId=Number(readArg("actor-user-id")),expectedHash=readArg("expect");
  if (!Number.isSafeInteger(actorId)||actorId<=0||!expectedHash||!skuIds.length)
    throw Error("Apply requires --actor-user-id, explicit --sku-ids and the preview --expect hash");
  const user=await loadUserContext(actorId);
  const req={user,locale:"en",branchId:user.branchIds?.[0]||null,ip:null};
  req.res={locals:{t:(key)=>resolveTranslation("en",key),can:(type,key,action)=>canAccessScope(req,type,key,action)}};
  console.log(JSON.stringify(await reconcileSfgValuation({req,skuIds,expectedHash}),null,2));
};
if(require.main===module)main().catch((err)=>{console.error("Valuation reconciliation failed:",err.message);process.exitCode=1;}).finally(()=>knex.destroy());
module.exports={main};