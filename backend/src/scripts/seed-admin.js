const knex = require("../db/knex");
const { hashPassword } = require("../middleware/core/auth");

const username = process.env.SEED_ADMIN_USERNAME || "admin";
const password = process.env.SEED_ADMIN_PASSWORD || "admin123";
const email = process.env.SEED_ADMIN_EMAIL;

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
  if (!branchCode) {
    throw new Error("SEED_ADMIN_BRANCH_CODE is required (no default branch creation).");
  }

  const branch = await knex("erp.branches").select("id").where({ code: branchCode }).first();

  if (!branch) {
    throw new Error(`Branch '${branchCode}' not found.`);
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
      .insert({
        user_id: trx("erp.users").select("id").where("username", username).limit(1),
        branch_id: branch.id,
      })
      .onConflict()
      .ignore();
  });
};

run()
  .then(() => {
    console.log(`Seeded admin user '${username}'.`);
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
