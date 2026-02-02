const knex = require("../db/knex");
const bcrypt = require("bcrypt");

async function runTest() {
  console.log("🛠️  Starting Full Admin Setup Test (Roles, Users, Permissions)...");

  const trx = await knex.transaction();

  try {
    // 1. Setup Data: Create 2 Branches
    console.log("📍 Creating Test Branches...");
    const branches = await trx("erp.branches")
      .insert([
        { code: "TEST_A", name: "Branch A", city: "Test City", is_active: true },
        { code: "TEST_B", name: "Branch B", city: "Test City", is_active: true },
      ])
      .returning("id");
    const branchIds = branches.map((b) => b.id || b); // Handle PG version differences

    // 2. Create Role
    console.log("📍 Creating Test Role...");
    const [role] = await trx("erp.role_templates")
      .insert({
        name: "Test Supervisor",
        description: "Automated Test Role",
      })
      .returning("id");
    const roleId = role.id || role;

    // 3. Create User with Multiple Branches
    console.log("📍 Creating Test User...");
    const passwordHash = await bcrypt.hash("secret", 10);
    const [user] = await trx("erp.users")
      .insert({
        username: "test_user_multi",
        password_hash: passwordHash,
        email: "test@example.com",
        primary_role_id: roleId,
        status: "Active",
      })
      .returning("id");
    const userId = user.id || user;

    // 4. Link User to Both Branches
    console.log("📍 Linking User to Branches...");
    await trx("erp.user_branch").insert(branchIds.map((bid) => ({ user_id: userId, branch_id: bid })));

    // Verify Links
    const linkCount = await trx("erp.user_branch").where({ user_id: userId }).count("branch_id as c").first();
    if (Number(linkCount.c) !== 2) throw new Error("User branch linking failed!");
    console.log("   ✅ User linked to 2 branches.");

    // 5. Test Permissions
    console.log("📍 Testing Permissions...");
    // Ensure scope exists
    let scope = await trx("erp.permission_scope_registry").where({ scope_key: "users" }).first();
    if (!scope) {
      [scope] = await trx("erp.permission_scope_registry")
        .insert({
          scope_type: "MODULE",
          scope_key: "users",
          description: "User Module",
        })
        .returning("*");
    }

    // Assign Role Permission
    await trx("erp.role_permissions").insert({
      role_id: roleId,
      scope_id: scope.id,
      can_navigate: true,
      can_view: true,
      can_create: false, // Role CANNOT create
    });

    // Assign User Override (Allow Create)
    await trx("erp.user_permissions_override").insert({
      user_id: userId,
      scope_id: scope.id,
      can_create: true, // Override: User CAN create
    });

    console.log("   ✅ Permissions and Overrides set.");

    console.log("🎉 ALL TESTS PASSED. Rolling back...");
    await trx.rollback();
  } catch (error) {
    console.error("❌ TEST FAILED:", error.message);
    await trx.rollback();
    process.exit(1);
  } finally {
    await knex.destroy();
  }
}

runTest();
