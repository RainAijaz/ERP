// party_type = 'OTHER' is for a party the business neither buys from nor sells to,
// but still hands goods to on a returnable gate pass (sister concern, neighbouring
// factory, employee).
//
// The value of the feature is entirely about where the party shows up, so these
// tests drive the real screens: it must appear on Returnable Dispatch and must NOT
// appear on purchase, sales, or the cash-voucher party picker. Each negative test
// is paired with a control party of a trading type that IS expected on that screen,
// so a screen that simply failed to load can never make an exclusion test pass.
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const knex = require("../../src/db/knex");

const OTHER_NAME = "ZZ E2E Neighbour (OTHER)";
const SUPPLIER_NAME = "ZZ E2E Control Supplier";
const CUSTOMER_NAME = "ZZ E2E Control Customer";

const created = [];

const createParty = async ({ name, code, partyType, userId, branchIds }) => {
  const [row] = await knex("erp.parties")
    .insert({
      code,
      name,
      name_ur: name,
      party_type: partyType,
      branch_id: branchIds[0],
      created_by: userId,
      is_active: true,
    })
    .returning("id");
  const id = Number(row?.id ?? row);
  // Linked to every branch, so branch scoping can never be the reason a party is
  // missing from a picker — only party_type can.
  await knex("erp.party_branch").insert(
    branchIds.map((branchId) => ({ party_id: id, branch_id: branchId })),
  );
  created.push(id);
  return id;
};

const optionTexts = async (page, selector) =>
  page.locator(`${selector} option`).allTextContents();

test.describe("Party type OTHER: where it may and may not be selected", () => {
  test.beforeAll(async () => {
    const user = await knex("erp.users").select("id").orderBy("id").first();
    const branches = await knex("erp.branches")
      .select("id")
      .where("is_active", true);
    const branchIds = branches.map((branch) => Number(branch.id));
    test.skip(
      !user || !branchIds.length,
      "No users or active branches available.",
    );

    await createParty({
      name: OTHER_NAME,
      code: "ZZ_E2E_OTHER",
      partyType: "OTHER",
      userId: user.id,
      branchIds,
    });
    await createParty({
      name: SUPPLIER_NAME,
      code: "ZZ_E2E_SUP",
      partyType: "SUPPLIER",
      userId: user.id,
      branchIds,
    });
    await createParty({
      name: CUSTOMER_NAME,
      code: "ZZ_E2E_CUST",
      partyType: "CUSTOMER",
      userId: user.id,
      branchIds,
    });
  });

  test.afterAll(async () => {
    if (created.length) {
      await knex("erp.party_branch").whereIn("party_id", created).del();
      await knex("erp.parties").whereIn("id", created).del();
    }
    // Deliberately no knex.destroy(): specs in the same worker share this knex
    // instance, so tearing the pool down here makes every later spec fail on
    // acquireConnection. Playwright closes the process when the run ends.
  });

  test("Returnable Dispatch offers the OTHER party under a 'Sent To' label", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/returnable-dispatch?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Returnable dispatch page not accessible for admin.",
    );
    await page.waitForSelector("[data-returnable-form]");

    const options = await optionTexts(page, 'select[name="vendor_party_id"]');
    expect(options.join("\n")).toContain(OTHER_NAME);
    // Suppliers were always allowed here and must stay allowed.
    expect(options.join("\n")).toContain(SUPPLIER_NAME);
    // Handing stock to a customer is a sale or a delivery, not a loan.
    expect(options.join("\n")).not.toContain(CUSTOMER_NAME);

    // The field is no longer called "Vendor" — it accepts non-vendors now.
    const form = page.locator("[data-returnable-form]");
    await expect(form).toContainText("Sent To");
    await expect(form).not.toContainText(/\bVendor\b/);
  });

  test("Purchase entry does not offer the OTHER party as a supplier", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/purchase?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Purchase voucher page not accessible for admin.",
    );
    await page.waitForSelector('select[name="supplier_party_id"]');

    const options = (
      await optionTexts(page, 'select[name="supplier_party_id"]')
    ).join("\n");
    // Control: a real supplier linked to the same branches IS listed, so the
    // absence below is about party_type and nothing else.
    expect(options).toContain(SUPPLIER_NAME);
    expect(options).not.toContain(OTHER_NAME);
  });

  test("Sales entry does not offer the OTHER party as a customer", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/sales?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Sales voucher page not accessible for admin.",
    );
    await page.waitForLoadState("domcontentloaded");

    const html = await page.content();
    expect(html).toContain(CUSTOMER_NAME); // control
    expect(html).not.toContain(OTHER_NAME);
  });

  test("Cash voucher party picker does not offer the OTHER party", async ({
    page,
  }) => {
    // A PARTY line posts to a receivable/payable control account. An OTHER party
    // has neither, and gl-posting-service would reject the voucher at posting
    // time, so it must not be offered in the first place.
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/vouchers/cash?new=1", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Cash voucher page not accessible for admin.",
    );
    await page.waitForLoadState("domcontentloaded");

    // The picker is built in the page from an embedded options.parties payload.
    const html = await page.content();
    expect(html).toContain(SUPPLIER_NAME); // control
    expect(html).toContain(CUSTOMER_NAME); // control
    expect(html).not.toContain(OTHER_NAME);
  });

  test("Parties master offers Other as a party type", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    const response = await page.goto("/master-data/parties", {
      waitUntil: "domcontentloaded",
    });
    test.skip(
      !response || response.status() !== 200,
      "Parties master not accessible for admin.",
    );

    const options = await optionTexts(page, 'select[name="party_type"]');
    const joined = options.join("\n");
    expect(joined).toContain("Customer");
    expect(joined).toContain("Supplier");
    expect(joined).toContain("Other");
  });
});
