const knex = require("../db/knex");

async function runTest() {
  console.log("🧪 Testing Permissions Module...");
  const trx = await knex.transaction();

  try {
    // 1. Check if scopes exist
    const scopeCount = await trx("erp.permission_scope_registry").count("* as c").first();
    console.log(`   📊 Total Scopes: ${scopeCount.c}`);

    if (Number(scopeCount.c) < 5) throw new Error("Scopes not seeded! Run seed script first.");

    // 2. Create Test Role
    const [role] = await trx("erp.role_templates").insert({ name: "PermTestRole" }).returning("*");
    console.log(`   👤 Created Role: ${role.name}`);

    // 3. Assign Permission
    const scope = await trx("erp.permission_scope_registry").first();
    await trx("erp.role_permissions").insert({
      role_id: role.id,
      scope_id: scope.id,
      can_navigate: true,
      can_view: true,
      can_create: true,
    });
    console.log(`   ✅ Assigned Navigate/View/Create to '${scope.scope_key}'`);

    // 4. Verify Fetch
    const perm = await trx("erp.role_permissions").where({ role_id: role.id, scope_id: scope.id }).first();

    if (!perm.can_view || !perm.can_create) throw new Error("Permission save failed");
    console.log("   ✅ Verification Successful");

    await trx.rollback();
    console.log("   🔄 Rollback complete.");
  } catch (err) {
    console.error("❌ Test Failed:", err);
    await trx.rollback();
  } finally {
    await knex.destroy();
  }
}

runTest();
