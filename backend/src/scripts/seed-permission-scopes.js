const knex = require("../db/knex");

const SCOPES = [
  // --- ADMINISTRATION ---
  { key: "setup:branches", type: "SCREEN", group: "Administration", desc: "Branches Setup" },
  { key: "setup:users", type: "SCREEN", group: "Administration", desc: "User Management" },
  { key: "setup:roles", type: "SCREEN", group: "Administration", desc: "Roles & Permissions" },
  { key: "setup:approvals", type: "SCREEN", group: "Administration", desc: "Pending Approvals" },
  { key: "setup:audit", type: "REPORT", group: "Administration", desc: "Audit & Activity Logs" },

  // --- MASTER DATA ---
  { key: "master:accounts", type: "SCREEN", group: "Master Data", desc: "Chart of Accounts" },
  { key: "master:parties", type: "SCREEN", group: "Master Data", desc: "Parties (Customers/Suppliers)" },
  { key: "master:products", type: "SCREEN", group: "Master Data", desc: "Product Definitions" },
  { key: "master:bom", type: "SCREEN", group: "Master Data", desc: "Bill of Materials (BOM)" },
  { key: "master:rates", type: "SCREEN", group: "Master Data", desc: "Labor & Production Rates" },

  // --- HR & PAYROLL ---
  { key: "hr:employees", type: "SCREEN", group: "HR & Payroll", desc: "Employee Master" },
  { key: "hr:attendance", type: "SCREEN", group: "HR & Payroll", desc: "Attendance Marking" },
  { key: "hr:payroll", type: "VOUCHER", group: "HR & Payroll", desc: "Payroll Generation" },
  { key: "hr:reports", type: "REPORT", group: "HR & Payroll", desc: "HR Reports" },

  // --- FINANCIAL ---
  { key: "finance:cash_voucher", type: "VOUCHER", group: "Financial", desc: "Cash Payment/Receipt" },
  { key: "finance:bank_voucher", type: "VOUCHER", group: "Financial", desc: "Bank Transactions" },
  { key: "finance:journal", type: "VOUCHER", group: "Financial", desc: "Journal Voucher" },
  { key: "finance:reports", type: "REPORT", group: "Financial", desc: "Financial Statements" },

  // --- PURCHASE ---
  { key: "purchase:order", type: "VOUCHER", group: "Purchase", desc: "Purchase Order" },
  { key: "purchase:invoice", type: "VOUCHER", group: "Purchase", desc: "Purchase Invoice (GRN)" },
  { key: "purchase:return", type: "VOUCHER", group: "Purchase", desc: "Purchase Return" },
  { key: "purchase:reports", type: "REPORT", group: "Purchase", desc: "Purchase Reports" },

  // --- SALES ---
  { key: "sales:order", type: "VOUCHER", group: "Sales", desc: "Sales Order" },
  { key: "sales:invoice", type: "VOUCHER", group: "Sales", desc: "Sales Invoice" },
  { key: "sales:return", type: "VOUCHER", group: "Sales", desc: "Sales Return" },
  { key: "sales:reports", type: "REPORT", group: "Sales", desc: "Sales Reports" },

  // --- PRODUCTION ---
  { key: "prod:planning", type: "SCREEN", group: "Production", desc: "Production Planning" },
  { key: "prod:process", type: "VOUCHER", group: "Production", desc: "Production Process (Issue/Receive)" },
  { key: "prod:job_card", type: "VOUCHER", group: "Production", desc: "Job Cards" },
  { key: "prod:reports", type: "REPORT", group: "Production", desc: "Production Reports" },

  // --- INVENTORY ---
  { key: "inv:stock_transfer", type: "VOUCHER", group: "Inventory", desc: "Stock Transfer" },
  { key: "inv:stock_adjust", type: "VOUCHER", group: "Inventory", desc: "Stock Adjustment" },
  { key: "inv:gate_pass", type: "VOUCHER", group: "Inventory", desc: "Gate Pass (In/Out)" },
  { key: "inv:reports", type: "REPORT", group: "Inventory", desc: "Stock Reports" },
];

async function seedScopes() {
  console.log("🌱 Seeding Permission Scopes...");
  const trx = await knex.transaction();
  try {
    for (const scope of SCOPES) {
      // Upsert logic
      const existing = await trx("erp.permission_scope_registry").where({ scope_key: scope.key }).first();
      if (!existing) {
        await trx("erp.permission_scope_registry").insert({
          scope_key: scope.key,
          scope_type: scope.type,
          module_group: scope.group,
          description: scope.desc,
        });
        console.log(`   + Added: ${scope.desc}`);
      } else {
        // Optional: Update description/group if changed
        await trx("erp.permission_scope_registry").where({ id: existing.id }).update({ module_group: scope.group, description: scope.desc, scope_type: scope.type });
      }
    }
    await trx.commit();
    console.log("✅ Scopes seeded successfully.");
  } catch (err) {
    await trx.rollback();
    console.error("❌ Seeding failed:", err);
  } finally {
    await knex.destroy();
  }
}

seedScopes();
