const knex = require("../db/knex");
const { hashPassword } = require("../middleware/core/auth");

const username = process.env.SEED_ADMIN_USERNAME || "admin";
const password = process.env.SEED_ADMIN_PASSWORD || "admin123";
const email = process.env.SEED_ADMIN_EMAIL;
const extraRoleName = process.env.SEED_ROLE_NAME;
const extraRoleDescription = process.env.SEED_ROLE_DESCRIPTION || null;
const extraUsername = process.env.SEED_USER_USERNAME;
const extraPassword = process.env.SEED_USER_PASSWORD;
const extraEmail = process.env.SEED_USER_EMAIL || null;
const extraBranchCode = process.env.SEED_USER_BRANCH_CODE || process.env.SEED_ADMIN_BRANCH_CODE;
const adminBranchCodes = process.env.SEED_ADMIN_BRANCH_CODES;
const extraBranchCodes = process.env.SEED_USER_BRANCH_CODES || process.env.SEED_ADMIN_BRANCH_CODES;

const run = async () => {
  if (!email) {
    throw new Error("SEED_ADMIN_EMAIL is required.");
  }

  const role = await knex("erp.role_templates").select("id").whereRaw("lower(trim(name)) = 'admin'").first();

  if (!role) {
    throw new Error("Admin role template not found");
  }

  const passwordHash = hashPassword(password);

  const branchCode = process.env.SEED_ADMIN_BRANCH_CODE;
  if (!branchCode && !adminBranchCodes) {
    throw new Error("SEED_ADMIN_BRANCH_CODE is required (no default branch creation).");
  }

  const branchCodes = (adminBranchCodes || branchCode || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const branches = await knex("erp.branches")
    .select("id", "code")
    .whereIn("code", branchCodes);

  if (branches.length !== branchCodes.length) {
    const found = new Set(branches.map((row) => row.code));
    const missing = branchCodes.filter((code) => !found.has(code));
    throw new Error(`Branch code(s) not found: ${missing.join(", ")}`);
  }

  await knex.transaction(async (trx) => {
    await trx("erp.users")
      .insert({
        username,
        password_hash: passwordHash,
        email,
        primary_role_id: role.id,
        status: "Active",
      })
      .onConflict("username")
      .merge({
        email,
        primary_role_id: role.id,
        status: "Active",
      });

    await trx("erp.user_branch")
      .insert(
        branches.map((branch) => ({
          user_id: trx("erp.users").select("id").where("username", username).limit(1),
          branch_id: branch.id,
        }))
      )
      .onConflict()
      .ignore();

    if (extraRoleName && extraUsername && extraPassword && (extraBranchCode || extraBranchCodes)) {
      const roleRow = await trx("erp.role_templates")
        .insert({
          name: extraRoleName,
          description: extraRoleDescription,
        })
        .onConflict("name")
        .merge({ description: extraRoleDescription })
        .returning("id");

      const roleId = Array.isArray(roleRow) ? roleRow[0]?.id || roleRow[0] : roleRow?.id || roleRow;

      const extraCodes = (extraBranchCodes || extraBranchCode || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

      if (!extraCodes.length) {
        throw new Error("SEED_USER_BRANCH_CODE is required for the extra user.");
      }

      const extraBranches = await trx("erp.branches")
        .select("id", "code")
        .whereIn("code", extraCodes);

      if (extraBranches.length !== extraCodes.length) {
        const found = new Set(extraBranches.map((row) => row.code));
        const missing = extraCodes.filter((code) => !found.has(code));
        throw new Error(`Branch code(s) not found for extra user: ${missing.join(", ")}`);
      }

      await trx("erp.users")
        .insert({
          username: extraUsername,
          password_hash: hashPassword(extraPassword),
          email: extraEmail,
          primary_role_id: roleId,
          status: "Active",
        })
        .onConflict("username")
        .merge({
          email: extraEmail,
          primary_role_id: roleId,
          status: "Active",
        });

      await trx("erp.user_branch")
        .insert(
          extraBranches.map((branch) => ({
            user_id: trx("erp.users").select("id").where("username", extraUsername).limit(1),
            branch_id: branch.id,
          }))
        )
        .onConflict()
        .ignore();
    }
  });
};

run()
  .then(() => {
    console.log(`Seeded admin user '${username}'.`);
    if (extraRoleName && extraUsername) {
      console.log(`Seeded role '${extraRoleName}' and user '${extraUsername}'.`);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

//  psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS erp;"
//  psql -U postgres -d postgres -c "CREATE DATABASE erp;"
//  npm run db:ddl
//  $env:SEED_ADMIN_EMAIL="admin@example.com"
// $env:SEED_ADMIN_BRANCH_CODE="124"
// $env:SEED_ADMIN_USERNAME="admin"
// $env:SEED_ADMIN_PASSWORD="Admin@123"
// npm run seed:admin
