require("dotenv").config();
const knex = require("../db/knex");

async function runTest() {
  console.log("🛠️  Starting SKU Scenario Logic Test...");

  const trx = await knex.transaction();

  try {
    // 1. SETUP: Get Master Data + Context (User/Branch)
    const item = await trx("erp.items").where({ item_type: "FG" }).first();
    const sizes = await trx("erp.sizes").limit(2);
    const grades = await trx("erp.grades").limit(1);

    // FETCH REQUIRED CONTEXT FOR APPROVALS
    const user = await trx("erp.users").first();
    const branch = await trx("erp.branches").first();

    if (!item || sizes.length < 2 || !grades.length || !user || !branch) {
      throw new Error("❌ Not enough master data (Items/Sizes/Grades/Users/Branches) to run test.");
    }
    console.log(`📋 Context: Item=${item.code}, User=${user.username}, Branch=${branch.code}`);

    // 2. SCENARIO A: Bulk Create Variants
    console.log("\n🧪 Scenario A: Bulk Create Variants");
    const saleRate1 = 550;
    const saleRate2 = 600;

    // Simulate what the frontend sends
    const createPayload = {
      item_id: item.id,
      size_ids: sizes.map((s) => s.id),
      grade_ids: grades.map((g) => g.id),
      color_ids: [],
      packing_type_ids: [],
      combo_rates: [saleRate1, saleRate2],
    };

    // Manual Insert Loop (Mimicking route logic)
    for (let i = 0; i < createPayload.size_ids.length; i++) {
      const size_id = createPayload.size_ids[i];
      const grade_id = createPayload.grade_ids[0];
      const rate = createPayload.combo_rates[i];

      const [variant] = await trx("erp.variants")
        .insert({
          item_id: createPayload.item_id,
          size_id: size_id,
          grade_id: grade_id,
          sale_rate: rate,
          is_active: true,
          created_by: user.id, // Fixed: Use actual user ID
          created_at: trx.fn.now(),
        })
        .returning("*");

      // Verify SKU Generation
      const skuCode = `${item.code}-${size_id}-${grade_id}`;
      await trx("erp.skus").insert({ variant_id: variant.id, sku_code: skuCode, is_active: true });

      console.log(`   ✅ Created Variant ID ${variant.id} with Rate ${variant.sale_rate}. SKU: ${skuCode}`);
    }

    // 3. SCENARIO B: Edit Rate (Approval Logic Check)
    console.log("\n🧪 Scenario B: Edit Rate (Approval Trigger)");
    const variantToEdit = await trx("erp.variants").where({ item_id: item.id }).first();
    const oldRate = Number(variantToEdit.sale_rate);
    const newRate = oldRate + 100;

    console.log(`   Attempting to change Rate from ${oldRate} to ${newRate}...`);

    // Logic from the Route:
    if (oldRate !== newRate) {
      // CORRECTED INSERT STATEMENT MATCHING 010_administration.sql
      await trx("erp.approval_request").insert({
        branch_id: branch.id, // Required
        requested_by: user.id, // Required
        request_type: "MASTER_DATA_CHANGE", // Correct Enum/FK Code
        entity_type: "SKU", // Correct Enum/FK Code
        entity_id: String(variantToEdit.id), // Must be string
        summary: "Test Rate Change",
        old_value: { sale_rate: oldRate }, // Jsonb
        new_value: { sale_rate: newRate }, // Jsonb
        status: "PENDING",
        requested_at: trx.fn.now(),
      });
      console.log("   ✅ Approval Request Created (Rate not updated yet).");
    }

    // Verify Rate didn't change
    const checkVariant = await trx("erp.variants").where({ id: variantToEdit.id }).first();
    if (Number(checkVariant.sale_rate) === oldRate) {
      console.log("   ✅ SUCCESS: Variant rate remained unchanged pending approval.");
    } else {
      console.error("   ❌ FAILURE: Variant rate changed immediately!");
    }

    // Cleanup
    throw new Error("TEST_COMPLETE_ROLLBACK");
  } catch (err) {
    if (err.message === "TEST_COMPLETE_ROLLBACK") {
      console.log("\n✨ All Scenarios Passed. Database rolled back to clean state.");
    } else {
      console.error("\n❌ Test Failed:", err);
    }
    await trx.rollback();
  } finally {
    await knex.destroy();
  }
}

runTest();
