const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");
const { createBomUiFixture, cleanupBomUiFixture, getApprovalPolicy, upsertApprovalPolicy, deleteApprovalPolicy, closeDb } = require("./utils/db");

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

    const hasArticleTypeColumn = await db.schema.withSchema("erp").hasColumn("labour_rate_rules", "article_type");
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

    const [inserted] = await db("erp.labour_rate_rules").insert(insertPayload).returning(["id"]);
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

  test("admin can edit labour rate in modal and persist rate", async ({ page }) => {
    test.skip(!ctx.ruleId, "Rule fixture was not created.");

    await login(page, "E2E_ADMIN");
    await page.goto("/hr-payroll/labours/rates", { waitUntil: "domcontentloaded" });

    const editBtn = page.locator(`[data-edit][data-id="${ctx.ruleId}"]`).first();
    await expect(editBtn).toBeVisible();
    const expectedSkuCode = String((await editBtn.getAttribute("data-sku_code")) || "").trim();
    await editBtn.click();

    const modal = page.locator("[data-modal]");
    await expect(modal).toBeVisible();
    const skuReadonly = page.locator('[data-modal-form] [data-sku-readonly="true"]');
    await expect(skuReadonly).toBeVisible();
    if (expectedSkuCode) {
      await expect(skuReadonly).toContainText(expectedSkuCode);
    } else {
      await expect(skuReadonly).toHaveText(/\S+/);
    }

    const rateInput = page.locator('[data-modal-form] [data-field="rate_value"]');
    await expect(rateInput).toBeVisible();
    await rateInput.fill("19.75");

    const submitBtn = page.locator('[data-modal-form] button[type="submit"]');
    await Promise.all([page.waitForLoadState("domcontentloaded"), submitBtn.click()]);

    const updated = await db("erp.labour_rate_rules").where({ id: ctx.ruleId }).first("id", "rate_value", "sku_id", "apply_on");
    expect(updated).toBeTruthy();
    expect(Number(updated.rate_value)).toBe(19.75);
    expect(Number(updated.sku_id)).toBe(Number(ctx.fixture.sfgSkuId));
    expect(String(updated.apply_on || "").toUpperCase()).toBe("GROUP");
  });
});
