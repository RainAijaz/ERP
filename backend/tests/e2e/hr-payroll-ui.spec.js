const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");
const {
  createBomUiFixture,
  cleanupBomUiFixture,
  getApprovalPolicy,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
  closeDb,
} = require("./utils/db");

const openRuleEditModal = async (page, ruleId, searchTerm = "") => {
  const row = page.locator(`tr[data-row][data-rule-id="${ruleId}"]`).first();
  if (!(await row.isVisible())) {
    const searchInput = page.locator("[data-search-input]").first();
    if (searchTerm && (await searchInput.count()) > 0) {
      await searchInput.fill(searchTerm);
    }
  }
  await expect(row).toHaveAttribute("data-filter-visible", "true");

  const groupKey =
    (await row.getAttribute("data-labour-name")) ||
    (await row.getAttribute("data-labour-id")) ||
    "";
  if (groupKey) {
    const header = page
      .locator(`tr.group-header[data-group-key="${groupKey}"]`)
      .first();
    if ((await header.count()) > 0) {
      const isOpen = (await header.getAttribute("data-group-open")) === "true";
      if (!isOpen) {
        await header.click();
      }
    }
  }
  await expect(row).toBeVisible();

  const inlineEdit = row.locator("[data-edit]").first();
  if (await inlineEdit.isVisible()) {
    await inlineEdit.click();
    return;
  }

  const menuBtn = row.locator("[data-row-menu]").first();
  await expect(menuBtn).toBeVisible();
  await menuBtn.click();

  const menuEdit = row.locator("[data-row-menu-panel] [data-edit]").first();
  await expect(menuEdit).toBeVisible();
  await menuEdit.click();
};

test.describe("HR Payroll labour rates modal", () => {
  test.describe.configure({ mode: "serial" });

  const db = createKnex(knexConfig);
  const ctx = {
    fixture: null,
    ruleId: null,
    previousPolicy: null,
  };

  test.beforeAll(async () => {
    ctx.fixture = await createBomUiFixture(`labrate${Date.now()}`);
    test.skip(!ctx.fixture, "Failed to create labour-rate fixture.");

    ctx.previousPolicy = await getApprovalPolicy({
      entityType: "SCREEN",
      entityKey: "hr_payroll.labour_rates",
      action: "edit",
    });

    await upsertApprovalPolicy({
      entityType: "SCREEN",
      entityKey: "hr_payroll.labour_rates",
      action: "edit",
      requiresApproval: false,
    });

    const hasArticleTypeColumn = await db.schema
      .withSchema("erp")
      .hasColumn("labour_rate_rules", "article_type");
    const insertPayload = {
      applies_to_all_labours: false,
      labour_id: ctx.fixture.labourId,
      dept_id: ctx.fixture.deptId,
      apply_on: "GROUP",
      sku_id: ctx.fixture.sfgSkuId,
      subgroup_id: null,
      group_id: ctx.fixture.groupId,
      rate_type: "PER_PAIR",
      rate_value: 12.5,
      status: "active",
    };
    if (hasArticleTypeColumn) {
      insertPayload.article_type = "BOTH";
    }

    const [inserted] = await db("erp.labour_rate_rules")
      .insert(insertPayload)
      .returning(["id"]);
    ctx.ruleId = Number(inserted?.id || inserted);
  });

  test.afterAll(async () => {
    try {
      if (ctx.ruleId) {
        await db("erp.labour_rate_rules").where({ id: ctx.ruleId }).del();
      }
      if (ctx.previousPolicy) {
        await upsertApprovalPolicy({
          entityType: "SCREEN",
          entityKey: "hr_payroll.labour_rates",
          action: "edit",
          requiresApproval: Boolean(ctx.previousPolicy.requires_approval),
        });
      } else {
        await deleteApprovalPolicy({
          entityType: "SCREEN",
          entityKey: "hr_payroll.labour_rates",
          action: "edit",
        });
      }
      await cleanupBomUiFixture({ fixture: ctx.fixture });
    } finally {
      await closeDb();
      await db.destroy();
    }
  });

  test("admin can edit labour rate in modal and persist rate", async ({
    page,
  }) => {
    test.skip(!ctx.ruleId, "Rule fixture was not created.");

    await login(page, "E2E_ADMIN");
    await page.goto("/hr-payroll/labours/rates", {
      waitUntil: "domcontentloaded",
    });

    const rowEditButton = page
      .locator(`[data-edit][data-id="${ctx.ruleId}"]`)
      .first();
    const expectedSkuCode = String(
      (await rowEditButton.getAttribute("data-sku_code")) || "",
    ).trim();
    await openRuleEditModal(page, ctx.ruleId, expectedSkuCode);

    const modal = page.locator("[data-modal]");
    await expect(modal).toBeVisible();
    const skuReadonly = page.locator(
      '[data-modal-form] [data-sku-readonly="true"]',
    );
    await expect(skuReadonly).toBeVisible();
    if (expectedSkuCode) {
      await expect(skuReadonly).toContainText(expectedSkuCode);
    } else {
      await expect(skuReadonly).toHaveText(/\S+/);
    }

    const rateInput = page.locator(
      '[data-modal-form] [data-field="rate_value"]',
    );
    await expect(rateInput).toBeVisible();
    await expect(rateInput).toHaveAttribute("step", "0.01");
    await rateInput.fill("19.75");

    const submitBtn = page.locator('[data-modal-form] button[type="submit"]');
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes(`/hr-payroll/labours/rates/${ctx.ruleId}`),
      ),
      submitBtn.click(),
    ]);

    const updated = await db("erp.labour_rate_rules")
      .where({ id: ctx.ruleId })
      .first("id", "rate_value", "sku_id", "apply_on");
    expect(updated).toBeTruthy();
    expect(Number(updated.rate_value)).toBe(19.75);
    expect(Number(updated.sku_id)).toBe(Number(ctx.fixture.sfgSkuId));
    expect(String(updated.apply_on || "").toUpperCase()).toBe("GROUP");
  });

  test("labour rate input hides number spinners", async ({ page }) => {
    test.skip(!ctx.ruleId, "Rule fixture was not created.");

    await login(page, "E2E_ADMIN");
    await page.goto("/hr-payroll/labours/rates", {
      waitUntil: "domcontentloaded",
    });

    const rowEditButton = page
      .locator(`[data-edit][data-id="${ctx.ruleId}"]`)
      .first();
    const expectedSkuCode = String(
      (await rowEditButton.getAttribute("data-sku_code")) || "",
    ).trim();
    await openRuleEditModal(page, ctx.ruleId, expectedSkuCode);

    const rateInput = page.locator(
      '[data-modal-form] [data-field="rate_value"]',
    );
    await expect(rateInput).toBeVisible();

    const appearance = await rateInput.evaluate(
      (el) => getComputedStyle(el).appearance,
    );
    expect(["textfield", "none"].includes(appearance)).toBeTruthy();
  });
});
