const { insertActivityLog } = require("../../utils/audit-log");

const VARIANT_ID = 1548;
const OLD_CODE = "P01 7/10 KIDS UPPER";
const NEW_CODE = "P01 7/10 GENT UPPER";

exports.up = async function up(knex) {
  try {
    await knex.transaction(async (trx) => {
      const row = await trx("erp.variants as v")
        .join("erp.skus as k", "k.variant_id", "v.id")
        .join("erp.items as i", "i.id", "v.item_id")
        .join("erp.sizes as s", "s.id", "v.size_id")
        .select("k.id as sku_id", "k.sku_code", "i.code as item_code",
          "i.item_type", "s.name as size_name")
        .where("v.id", VARIANT_ID)
        .forUpdate("k")
        .first();

      // Other installations may not have this SKU.
      if (!row) return;
      if (String(row.item_code || "").toLowerCase() !== "p01_upper" ||
          row.item_type !== "SFG" || row.size_name !== "7/10 GENT") {
        throw new Error("P01 upper SKU identity or size differs from the verified repair target");
      }
      if (row.sku_code === NEW_CODE) return;
      if (row.sku_code !== OLD_CODE) {
        throw new Error("P01 upper SKU code differs from the verified repair target");
      }
      const conflict = await trx("erp.skus")
        .select("id")
        .where({ sku_code: NEW_CODE })
        .whereNot({ id: row.sku_id })
        .first();
      if (conflict) throw new Error("P01 upper target SKU code already exists");

      const updated = await trx("erp.skus")
        .where({ id: row.sku_id, sku_code: OLD_CODE })
        .update({ sku_code: NEW_CODE });
      if (updated !== 1) throw new Error("P01 upper SKU changed during repair");
      await insertActivityLog(trx, {
        entityType: "SKU",
        entityId: String(VARIANT_ID),
        action: "UPDATE",
        context: {
          source: "size-rename-data-repair",
          old_sku_code: OLD_CODE,
          new_sku_code: NEW_CODE,
          size_name: "7/10 GENT",
        },
      });
    });
  } catch (err) {
    console.error("Error in P01GentUpperSkuMigration:", err);
    throw err;
  }
};

// This corrects an existing identifier; rolling back schema should not revive it.
exports.down = async function down() {};
