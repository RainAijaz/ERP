const knex = require("../db/knex");

// ==========================================
// CONFIGURATION
// ==========================================
const TEST_ROLE_NAME = "QA_Auto_AdminMaster_Role";
const TEST_USER_NAME = "qa_auto_tester";
const TEST_BRANCH_CODE = "QA_AUTO";

// All scopes in "Administration" and "Master Data" groups
// Sourced from src/scripts/seed-permission-scopes.js
const TEST_SCOPES = [
  // --- ADMINISTRATION ---
  "setup:branches",
  "setup:users",
  "setup:roles",
  "setup:approvals",
  "setup:audit",

  // --- MASTER DATA ---
  "master:accounts",
  "master:parties",
  "master:products",
  "master:bom",
  "master:rates",
];

// ==========================================
// HELPER FUNCTIONS
// ==========================================

async function cleanUp(trx) {
  process.stdout.write("🧹 Cleaning up old data... ");
  await trx("erp.users").where({ username: TEST_USER_NAME }).del();
  await trx("erp.role_templates").where({ name: TEST_ROLE_NAME }).del();
  await trx("erp.branches").where({ code: TEST_BRANCH_CODE }).del();
  console.log("Done.");
}

async function setupTestData(trx) {
  console.log("🏗️  Creating Test User, Role, and Branch...");

  const [branch] = await trx("erp.branches").insert({ code: TEST_BRANCH_CODE, name: "QA Automation Branch" }).returning("*");

  const [role] = await trx("erp.role_templates").insert({ name: TEST_ROLE_NAME, description: "Automated Testing Role" }).returning("*");

  const [user] = await trx("erp.users")
    .insert({
      username: TEST_USER_NAME,
      password_hash: "$2b$10$LongDummyPasswordForSecurityConstraint", // >20 chars
      primary_role_id: role.id,
      status: "Active",
    })
    .returning("*");

  await trx("erp.user_branch").insert({ user_id: user.id, branch_id: branch.id });

  return { user, role };
}

// Fetch permissions exactly how the middleware/UI would receive them
async function fetchPermissions(trx, userId, roleId) {
  const permissions = {};

  const rows = await trx("erp.permission_scope_registry as s")
    .select("s.scope_type", "s.scope_key", trx.raw("COALESCE(uo.can_navigate, rp.can_navigate, false) as can_navigate"), trx.raw("COALESCE(uo.can_view, rp.can_view, false) as can_view"), trx.raw("COALESCE(uo.can_create, rp.can_create, false) as can_create"), trx.raw("COALESCE(uo.can_edit, rp.can_edit, false) as can_edit"), trx.raw("COALESCE(uo.can_delete, rp.can_delete, false) as can_delete"))
    .leftJoin("erp.role_permissions as rp", function () {
      this.on("rp.scope_id", "=", "s.id").andOn("rp.role_id", "=", trx.raw("?", [roleId]));
    })
    .leftJoin("erp.user_permissions_override as uo", function () {
      this.on("uo.scope_id", "=", "s.id").andOn("uo.user_id", "=", trx.raw("?", [userId]));
    });

  for (const row of rows) {
    const key = `${row.scope_type}:${row.scope_key}`;
    permissions[key] = {
      can_navigate: !!row.can_navigate,
      can_view: !!row.can_view,
      can_create: !!row.can_create,
      can_edit: !!row.can_edit,
      can_delete: !!row.can_delete,
    };
  }
  return permissions;
}

// Update database permissions for a role
async function setRolePerms(trx, roleId, scopeKey, rights) {
  const scope = await trx("erp.permission_scope_registry").where({ scope_key: scopeKey }).first();
  if (!scope) {
    console.warn(`⚠️ Warning: Scope '${scopeKey}' not found in DB. Skipping.`);
    return;
  }
  await trx("erp.role_permissions")
    .insert({ role_id: roleId, scope_id: scope.id, ...rights })
    .onConflict(["role_id", "scope_id"])
    .merge(rights);
}

// ==========================================
// CORE TEST LOGIC
// ==========================================

async function runTest() {
  console.log("\n🧪 STARTING COMPREHENSIVE PERMISSION TEST\n");
  console.log(`🎯 Targets: [${TEST_SCOPES.join(", ")}]\n`);

  const trx = await knex.transaction();

  try {
    await cleanUp(trx);
    const { user, role } = await setupTestData(trx);

    // ---------------------------------------------------------
    // TEST PHASE 1: VIEW ONLY (The "Read-Only" Test)
    // Goal: Verify that giving View/Navigate does NOT allow Edit/Create/Delete
    // ---------------------------------------------------------
    console.log("\n📋 PHASE 1: Testing 'View Only' Isolation");

    for (const scopeKey of TEST_SCOPES) {
      // 1. Grant View Only
      await setRolePerms(trx, role.id, scopeKey, {
        can_navigate: true,
        can_view: true,
        can_create: false,
        can_edit: false,
        can_delete: false,
      });
    }

    let perms = await fetchPermissions(trx, user.id, role.id);
    let phase1Errors = 0;

    for (const scopeKey of TEST_SCOPES) {
      const p = perms[`SCREEN:${scopeKey}`] || perms[`MODULE:${scopeKey}`]; // Handle type dynamically if needed

      if (!p) {
        console.error(`   ❌ Missing scope data for ${scopeKey}`);
        continue;
      }

      // POSITIVE CHECK
      if (!p.can_view) {
        console.error(`   ❌ ${scopeKey}: Expected VIEW=true, got false`);
        phase1Errors++;
      }

      // NEGATIVE CHECKS (The Independence Test)
      if (p.can_create) {
        console.error(`   ❌ ${scopeKey}: FAILURE! View granted Create automatically.`);
        phase1Errors++;
      }
      if (p.can_edit) {
        console.error(`   ❌ ${scopeKey}: FAILURE! View granted Edit automatically.`);
        phase1Errors++;
      }
      if (p.can_delete) {
        console.error(`   ❌ ${scopeKey}: FAILURE! View granted Delete automatically.`);
        phase1Errors++;
      }
    }

    if (phase1Errors === 0) console.log("   ✅ Success: 'View Only' strictly restricts other actions for all pages.");

    // ---------------------------------------------------------
    // TEST PHASE 2: CREATE WITHOUT DELETE (The "Clerk" Test)
    // Goal: Verify that giving Create does NOT allow Delete
    // ---------------------------------------------------------
    console.log("\n📋 PHASE 2: Testing 'Create' Isolation (No Delete)");

    for (const scopeKey of TEST_SCOPES) {
      // Grant View + Create (but NO Delete)
      await setRolePerms(trx, role.id, scopeKey, {
        can_navigate: true,
        can_view: true,
        can_create: true,
        can_edit: true,
        can_delete: false, // Explicitly false
      });
    }

    perms = await fetchPermissions(trx, user.id, role.id);
    let phase2Errors = 0;

    for (const scopeKey of TEST_SCOPES) {
      const p = perms[`SCREEN:${scopeKey}`];
      if (!p) continue;

      // POSITIVE CHECK
      if (!p.can_create) {
        console.error(`   ❌ ${scopeKey}: Expected CREATE=true, got false`);
        phase2Errors++;
      }

      // NEGATIVE CHECK (Independence)
      if (p.can_delete) {
        console.error(`   ❌ ${scopeKey}: FAILURE! Create/Edit automatically allowed Delete.`);
        phase2Errors++;
      }
    }

    if (phase2Errors === 0) console.log("   ✅ Success: 'Create/Edit' strictly blocked 'Delete' for all pages.");

    // ---------------------------------------------------------
    // TEST PHASE 3: TOTAL REVOCATION
    // Goal: Verify removing permissions kills access completely
    // ---------------------------------------------------------
    console.log("\n📋 PHASE 3: Testing Full Revocation");

    for (const scopeKey of TEST_SCOPES) {
      await setRolePerms(trx, role.id, scopeKey, {
        can_navigate: false,
        can_view: false,
        can_create: false,
        can_edit: false,
        can_delete: false,
      });
    }

    perms = await fetchPermissions(trx, user.id, role.id);
    let phase3Errors = 0;

    for (const scopeKey of TEST_SCOPES) {
      const p = perms[`SCREEN:${scopeKey}`];
      if (!p) continue;

      if (p.can_view || p.can_create || p.can_edit || p.can_delete) {
        console.error(`   ❌ ${scopeKey}: FAILURE! Permissions persist after revocation.`);
        phase3Errors++;
      }
    }

    if (phase3Errors === 0) console.log("   ✅ Success: All permissions successfully revoked.");

    console.log("\n🎉 TEST COMPLETE.");
    await trx.rollback();
    console.log("   🔄 Rollback complete (DB State Preserved).");
  } catch (err) {
    console.error("\n❌ FATAL ERROR:", err);
    await trx.rollback();
  } finally {
    await knex.destroy();
  }
}

runTest();
