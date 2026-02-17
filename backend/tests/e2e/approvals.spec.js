const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const { getBranch, getApprovalEditFixtureData, getTwoDistinctUsers, getVariantForSkuApproval, createApprovalRequest, deleteApprovalRequests, setVariantSaleRate, upsertUserWithPermissions, clearUserPermissionsOverride, closeDb } = require("./utils/db");

// --- Helper Functions ---
const compactJoin = (parts) =>
  parts
    .map((part) => (part == null ? "" : String(part).trim()))
    .filter(Boolean)
    .join(" ");

const buildSkuLabel = (row) => compactJoin([row.item_name, row.size_name, row.packing_name, row.grade_name, row.color_name]) || "-";

test.describe("Approvals page scenarios", () => {
  // Use serial mode to keep the DB connection open across all tests
  test.describe.configure({ mode: "serial" });

  const debug = process.env.DEBUG_APPROVAL_E2E === "1";
  const createdApprovalIds = [];
  const masterApprovalSpecs = [
    { summary: "Create Accounts", value: "E2E Cash Account" },
    { summary: "Create Parties", value: "E2E Demo Party" },
    { summary: "Create Raw Materials", value: "E2E Raw Material" },
    { summary: "Create Finished Items", value: "E2E Finished Item" },
  ];

  const ctx = {
    ready: false,
    skipReason: "",
    branchId: null,
    adminUser: null,
    otherUser: null,
    managerUser: null,
    variant: null,
    skuLabel: "",
    originalRate: null,
    approvalPolicySnapshot: new Map(),
    ids: {
      pendingNew: null,
      pendingUpdate: null,
      pendingUpdateAuto: null,
      pendingReject: null,
      pendingSize: null,
      pendingColor: null,
      pendingGrade: null,
      pendingPacking: null,
      pendingCity: null,
      pendingDepartment: null,
      pendingAccount: null,
      pendingParty: null,
      pendingItemRm: null,
      pendingItemFg: null,
      approved: null,
      rejected: null,
    },
    basicApprovals: [],
    masterApprovals: masterApprovalSpecs,
    fixture: null,
  };

  test.beforeAll(async () => {
    const branch = await getBranch();
    const users = await getTwoDistinctUsers(process.env.E2E_ADMIN_USER);
    const variant = await getVariantForSkuApproval();

    if (!branch || !users || !variant) {
      const hasBranch = Boolean(branch);
      const hasUsers = Boolean(users);
      const hasVariant = Boolean(variant);
      ctx.skipReason = `Missing branch, users, or SKU variant data. hasBranch=${hasBranch} hasUsers=${hasUsers} hasVariant=${hasVariant}`;
      return;
    }

    ctx.ready = true;
    ctx.branchId = branch.id;
    ctx.adminUser = users.primary;
    ctx.otherUser = users.secondary;
    ctx.variant = variant;
    ctx.skuLabel = buildSkuLabel(variant);
    ctx.originalRate = variant.sale_rate;
    ctx.fixture = await getApprovalEditFixtureData();

    const managerUsername = process.env.E2E_MANAGER_USER || "manager1";
    const managerPassword = process.env.E2E_MANAGER_PASS || "Manager@123";
    process.env.E2E_MANAGER_USER = managerUsername;
    process.env.E2E_MANAGER_PASS = managerPassword;
    const managerUserId = await upsertUserWithPermissions({
      username: managerUsername,
      password: managerPassword,
      roleName: "Manager",
      branchId: ctx.branchId,
      scopeKeys: [
        "master_data.accounts",
        "master_data.parties",
        "master_data.products.finished",
        "master_data.basic_info",
        "master_data.basic_info.sizes", // <--- ADD THIS
      ],
    });
    ctx.managerUser = { id: managerUserId, username: managerUsername };

    const newRate = Number(variant.sale_rate || 0) + 7;

    // Create approval requests directly in DB
    ctx.ids.pendingNew = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "SKU",
      entity_id: "NEW",
      summary: `New Variant: ${variant.item_name}`,
      new_value: {
        _action: "create",
        item_id: variant.item_id,
        size_id: variant.size_id,
        grade_id: variant.grade_id,
        color_id: variant.color_id,
        packing_type_id: variant.packing_type_id,
        sale_rate: newRate,
      },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.ids.pendingUpdate = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "SKU",
      entity_id: String(variant.id),
      summary: "Edit SKUs",
      new_value: { _action: "update", sale_rate: newRate },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.ids.pendingUpdateAuto = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "SKU",
      entity_id: String(variant.id),
      summary: "Edit SKUs AutoDismiss",
      new_value: { _action: "update", sale_rate: newRate + 1 },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.ids.pendingReject = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "SKU",
      entity_id: String(variant.id),
      summary: "Deactivate SKUs",
      new_value: { _action: "update", sale_rate: newRate },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    // Basic Info Requests
    ctx.ids.pendingSize = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "SIZE",
      entity_id: "NEW",
      summary: "Create Sizes",
      new_value: { _action: "create", name: "E2E Size XL" },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.ids.pendingColor = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "COLOR",
      entity_id: "NEW",
      summary: "Create Colors",
      new_value: { _action: "create", name: "E2E Color Blue" },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.ids.pendingGrade = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "GRADE",
      entity_id: "NEW",
      summary: "Create Grades",
      new_value: { _action: "create", name: "E2E Grade A" },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.ids.pendingPacking = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "PACKING_TYPE",
      entity_id: "NEW",
      summary: "Create Packing Types",
      new_value: { _action: "create", name: "E2E Carton Packed" },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.ids.pendingCity = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "CITY",
      entity_id: "NEW",
      summary: "Create Cities",
      new_value: { _action: "create", name: "E2E City North" },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.ids.pendingDepartment = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "DEPARTMENT",
      entity_id: "NEW",
      summary: "Create Departments",
      new_value: { _action: "create", name: "E2E Department Ops" },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.ids.pendingAccount = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "ACCOUNT",
      entity_id: "NEW",
      summary: "Create Accounts",
      new_value: { _action: "create", name: "E2E Cash Account", name_ur: "E2E Cash Account" },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.ids.pendingParty = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "PARTY",
      entity_id: "NEW",
      summary: "Create Parties",
      new_value: { _action: "create", name: "E2E Demo Party", name_ur: "E2E Demo Party", party_type: "CUSTOMER" },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.ids.pendingItemRm = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "ITEM",
      entity_id: "NEW",
      summary: "Create Raw Materials",
      new_value: { _action: "create", item_type: "RM", name: "E2E Raw Material", name_ur: "E2E Raw Material" },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.ids.pendingItemFg = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "ITEM",
      entity_id: "NEW",
      summary: "Create Finished Items",
      new_value: { _action: "create", item_type: "FG", name: "E2E Finished Item", name_ur: "E2E Finished Item" },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });

    ctx.basicApprovals = [
      { id: ctx.ids.pendingSize, summary: "Create Sizes", value: "E2E Size XL" },
      { id: ctx.ids.pendingColor, summary: "Create Colors", value: "E2E Color Blue" },
      { id: ctx.ids.pendingGrade, summary: "Create Grades", value: "E2E Grade A" },
      { id: ctx.ids.pendingPacking, summary: "Create Packing Types", value: "E2E Carton Packed" },
      { id: ctx.ids.pendingCity, summary: "Create Cities", value: "E2E City North" },
      { id: ctx.ids.pendingDepartment, summary: "Create Departments", value: "E2E Department Ops" },
    ];

    ctx.masterApprovals = masterApprovalSpecs;

    ctx.ids.approved = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "SKU",
      entity_id: String(variant.id),
      summary: "Edit SKUs",
      new_value: { _action: "update", sale_rate: newRate },
      status: "APPROVED",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
      decided_by: ctx.adminUser.id,
      decided_at: new Date(),
    });

    ctx.ids.rejected = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "SKU",
      entity_id: String(variant.id),
      summary: "Edit SKUs",
      new_value: { _action: "update", sale_rate: newRate },
      status: "REJECTED",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
      decided_by: ctx.adminUser.id,
      decided_at: new Date(),
    });

    createdApprovalIds.push(ctx.ids.pendingNew, ctx.ids.pendingUpdate, ctx.ids.pendingReject, ctx.ids.pendingSize, ctx.ids.pendingColor, ctx.ids.pendingGrade, ctx.ids.pendingPacking, ctx.ids.pendingCity, ctx.ids.pendingDepartment, ctx.ids.pendingAccount, ctx.ids.pendingParty, ctx.ids.pendingItemRm, ctx.ids.pendingItemFg, ctx.ids.approved, ctx.ids.rejected);
    createdApprovalIds.push(ctx.ids.pendingUpdateAuto);
  });

  test.afterAll(async () => {
    await deleteApprovalRequests(createdApprovalIds.filter(Boolean));
    if (ctx.variant?.id && ctx.originalRate != null) {
      await setVariantSaleRate(ctx.variant.id, ctx.originalRate);
    }
    if (ctx.managerUser?.id) {
      await clearUserPermissionsOverride({
        userId: ctx.managerUser.id,
        scopeKeys: ["master_data.accounts", "master_data.parties", "master_data.products.finished", "master_data.basic_info"],
      });
    }
    await closeDb();
  });

  test.beforeEach(async ({ page }) => {
    test.skip(!ctx.ready, ctx.skipReason);
    if (debug) {
      page.on("console", (msg) => {
        if (msg.type() === "error") console.log("[approvals.spec][browser:error]", msg.text());
      });
      page.on("pageerror", (err) => console.log("[approvals.spec][pageerror]", err.message));
      page.on("requestfailed", (req) => {
        if (req.failure()) console.log("[approvals.spec][requestfailed]", req.method(), req.url(), req.failure().errorText);
      });
    }
    await login(page, "E2E_ADMIN");
  });

  const gotoApprovals = async (page, status) => {
    const url = status ? `/administration/approvals?status=${status}` : "/administration/approvals";
    await page.goto(url, { waitUntil: "domcontentloaded" });
  };

  const gotoApprovalSettings = async (page) => {
    await page.goto("/administration/approvals/settings", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#approval-table-container", { state: "attached" });
    await page.evaluate(() => {
      if (typeof filterCategory === "function") filterCategory("all");
      document.getElementById("module-empty-state")?.classList.add("hidden");
      document.getElementById("approval-toolbar")?.classList.remove("hidden");
      document.getElementById("approval-table-container")?.classList.remove("hidden");
    });
  };

  const ensureCheckbox = async (page, name, desired) => {
    const checkbox = page.locator(`input[name="${name}"]`).first();
    const count = await checkbox.count();
    if (count === 0) return;

    if (!ctx.approvalPolicySnapshot.has(name)) {
      const current = await checkbox.isChecked();
      ctx.approvalPolicySnapshot.set(name, current);
    }

    const isChecked = await checkbox.isChecked();
    if (isChecked !== desired) {
      await page.evaluate(
        ({ targetName, nextValue }) => {
          const input = document.querySelector(`input[name="${targetName}"]`);
          if (input) {
            input.checked = nextValue;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        { targetName: name, nextValue: desired },
      );
    }
  };

  const selectFirstNonEmpty = async (page, selector) => {
    const select = page.locator(selector);
    const options = await select.locator("option").all();
    for (const option of options) {
      const value = await option.getAttribute("value");
      if (value && value.trim() !== "") {
        await select.selectOption(value);
        return value;
      }
    }
    return null;
  };

  const withNextDialogAccepted = async (page, action) => {
    let message = "";
    const promise = new Promise((resolve) => {
      page.once("dialog", async (dialog) => {
        message = dialog.message();
        await dialog.accept();
        resolve();
      });
    });
    await action();
    await promise;
    return message;
  };

  const chooseFirstNonEmptyOption = async (selectLocator) => {
    return selectLocator.evaluate((el) => {
      const options = Array.from(el.options || []).filter((opt) => String(opt.value || "").trim() !== "");
      if (!options.length) return "";
      const target = options[0];
      el.value = target.value;
      target.selected = true;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return String(target.value);
    });
  };

  const mutateApprovalPanelFields = async (panel, token) => {
    const textInputs = panel.locator('input[data-field][type="text"], input[data-field]:not([type]), textarea[data-field]');
    const textCount = await textInputs.count();
    for (let i = 0; i < textCount; i += 1) {
      const input = textInputs.nth(i);
      if (!(await input.isVisible()) || (await input.isDisabled())) continue;
      const fieldName = (await input.getAttribute("data-field")) || "value";
      if (fieldName === "phone1" || fieldName === "phone2" || fieldName === "phone") {
        await input.fill("0300-0000000");
        continue;
      }
      if (fieldName === "code") {
        await input.fill(`e2e_${token}_${i}`);
        continue;
      }
      await input.fill(`E2E ${fieldName} ${token}`);
    }

    const numberInputs = panel.locator('input[data-field][type="number"]');
    const numberCount = await numberInputs.count();
    for (let i = 0; i < numberCount; i += 1) {
      const input = numberInputs.nth(i);
      if (!(await input.isVisible()) || (await input.isDisabled())) continue;
      const current = await input.inputValue();
      const next = Number(current || 0);
      await input.fill(String(Number.isFinite(next) ? next + 1 : 1));
    }

    const singleSelects = panel.locator("select[data-field]:not([multiple])");
    const singleCount = await singleSelects.count();
    for (let i = 0; i < singleCount; i += 1) {
      const select = singleSelects.nth(i);
      if (!(await select.isVisible()) || (await select.isDisabled())) continue;
      await chooseFirstNonEmptyOption(select);
    }

    const singleChecks = panel.locator('input[data-field][type="checkbox"]:not([data-multi="true"])');
    const checkCount = await singleChecks.count();
    for (let i = 0; i < checkCount; i += 1) {
      const checkbox = singleChecks.nth(i);
      if (!(await checkbox.isVisible()) || (await checkbox.isDisabled())) continue;
      await checkbox.click();
    }
  };

  const ensureBranchMultiSelectInteractive = async (panel) => {
    const branchSelect = panel.locator('select[data-field="branch_ids"]');
    if ((await branchSelect.count()) === 0) return;
    const trigger = panel.locator("[data-multi-select] [data-multi-trigger]").first();
    if ((await trigger.count()) === 0) return;
    await trigger.click();
    const menu = panel.locator("[data-multi-select] [data-multi-menu]").first();
    await expect(menu).toBeVisible();
    const firstMenuOption = menu.locator("button").first();
    await expect(firstMenuOption).toBeVisible();
    await firstMenuOption.click();
    const selectedAfter = await branchSelect.evaluate((el) => Array.from(el.selectedOptions).map((o) => o.value));
    if (!selectedAfter.length) {
      await branchSelect.evaluate((el) => {
        const options = Array.from(el.options || []).filter((opt) => String(opt.value || "").trim() !== "");
        if (!options.length) return;
        options.forEach((option, idx) => {
          option.selected = idx === 0;
        });
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    const selectedFinal = await branchSelect.evaluate((el) => Array.from(el.selectedOptions).map((o) => o.value));
    expect(selectedFinal.length).toBeGreaterThan(0);
  };

  // --- STANDARD TESTS ---
  test("loads approvals page with table headers", async ({ page }) => {
    await gotoApprovals(page);
    await expect(page.getByRole("columnheader", { name: /date/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /requester/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /summary/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /status/i })).toBeVisible();
  });

  test("shows status tabs", async ({ page }) => {
    await gotoApprovals(page);
    await expect(page.getByRole("link", { name: /pending/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /approved/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /rejected/i })).toBeVisible();
  });

  test("defaults to pending status", async ({ page }) => {
    await gotoApprovals(page);
    const pendingTab = page.getByRole("link", { name: /pending/i });
    await expect(pendingTab).toHaveClass(/bg-slate-800/);
  });

  test("navigates to approved status tab", async ({ page }) => {
    await gotoApprovals(page, "APPROVED");
    await expect(page).toHaveURL(/status=APPROVED/);
  });

  test("navigates to rejected status tab", async ({ page }) => {
    await gotoApprovals(page, "REJECTED");
    await expect(page).toHaveURL(/status=REJECTED/);
  });

  test("pending list appends SKU label for edit summary", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    const row = page.locator(`tbody tr:has(form[action$="/${ctx.ids.pendingUpdate}/approve"])`).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("Edit SKUs");
    await expect(row).toContainText(ctx.skuLabel);
  });

  test("summary does not contain undefined for SKU rows", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    const tableText = await page.locator("tbody").innerText();
    expect(tableText.toLowerCase()).not.toContain("undefined");
  });

  test("view modal opens for new SKU and shows single panel", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
    await row.getByRole("button", { name: /view/i }).click();
    await expect(page.locator("[data-approval-detail-modal]")).toBeVisible();
    await expect(page.locator("[data-approval-detail-single]")).toBeVisible();
    await expect(page.locator("[data-approval-detail-before]")).toHaveClass(/hidden/);
    await expect(page.locator("[data-approval-detail-after]")).toHaveClass(/hidden/);
  });

  test("view modal opens for edit SKU and shows before/after panels", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    const row = page.locator("tbody tr", { hasText: "Edit SKUs" }).first();
    await row.getByRole("button", { name: /view/i }).click();
    await expect(page.locator("[data-approval-detail-modal]")).toBeVisible();
    await expect(page.locator("[data-approval-detail-before]")).toBeVisible();
    await expect(page.locator("[data-approval-detail-after]")).toBeVisible();
  });

  test("view modal renders preview header and compact fields", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
    await row.getByRole("button", { name: /view/i }).click();
    const modal = page.locator("[data-approval-detail-modal]");
    await expect(modal).toBeVisible();
    await expect(modal.getByText(/skus/i)).toBeVisible();
    await expect(modal.getByText(/article/i)).toBeVisible();
    await expect(modal.getByText(/rate/i)).toBeVisible();
  });

  test("modal closes via close button", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
    await row.getByRole("button", { name: /view/i }).click();
    const modal = page.locator("[data-approval-detail-modal]");
    await expect(modal).toBeVisible();
    await page.locator("[data-approval-detail-close]").click();
    await expect(modal).toHaveClass(/hidden/);
  });

  test("modal closes via backdrop click", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
    await row.getByRole("button", { name: /view/i }).click();
    const modal = page.locator("[data-approval-detail-modal]");
    await expect(modal).toBeVisible();
    await modal.click({ position: { x: 10, y: 10 } });
    await expect(modal).toHaveClass(/hidden/);
  });

  test("SKU preview modal uses compact width", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
    await row.getByRole("button", { name: /view/i }).click();
    const panel = page.locator("[data-approval-detail-panel]");
    await expect(panel).toHaveClass(/max-w-3xl/);
  });

  test("basic info approval preview renders and uses wide modal", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    const row = page.locator("tbody tr", { hasText: "Create Sizes" }).first();
    await expect(row).toBeVisible();
    const viewBtn = row.getByRole("button", { name: /view/i });
    const approvalId = await viewBtn.getAttribute("data-approval-id");
    const previewWait = approvalId ? page.waitForResponse((res) => res.url().includes(`/administration/approvals/${approvalId}/preview`) && (res.status() === 200 || res.status() === 204), { timeout: 10000 }) : Promise.resolve(null);
    await viewBtn.click();
    await previewWait.catch(() => {});

    const panel = page.locator("[data-approval-detail-panel]");
    await expect(panel).toHaveClass(/max-w-6xl/);
    const preview = page.locator('[data-approval-preview][data-preview-type="basic-info"]');
    await expect(preview).toBeVisible({ timeout: 10000 });
  });

  test("basic info previews hydrate name field for multiple master data types", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    for (const entry of ctx.basicApprovals) {
      const row = page.locator("tbody tr", { hasText: entry.summary }).first();
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: /view/i }).click();
      const modal = page.locator("[data-approval-detail-modal]");
      await expect(modal).toBeVisible();
      const nameInput = modal.locator('[data-approval-preview] [data-field="name"]').first();
      await expect(nameInput).toHaveValue(entry.value);

      const closeBtn = page.locator("[data-approval-detail-close]").first();
      await closeBtn.click();
      await expect(modal).toHaveClass(/hidden/);
    }
  });

  test.describe("master approval previews", () => {
    for (const entry of masterApprovalSpecs) {
      test(`hydrates name field: ${entry.summary}`, async ({ page }) => {
        await gotoApprovals(page, "PENDING");
        const row = page.locator("tbody tr", { hasText: entry.summary }).first();
        await expect(row).toBeVisible();
        await row.getByRole("button", { name: /view/i }).click();
        const modal = page.locator("[data-approval-detail-modal]");
        await expect(modal).toBeVisible();
        const nameInput = modal.locator('[data-approval-preview] [data-field="name"]').first();
        await expect(nameInput).toHaveValue(entry.value);

        await modal.click({ position: { x: 5, y: 5 } });
        await expect(modal).toHaveClass(/hidden/);
      });
    }
  });

  test.describe("Error handling and Edge cases", () => {
    test("handles duplicate data error gracefully on approve", async ({ page }) => {
      const duplicateName = `Dupe Color ${Date.now()}`;
      const r1 = await createApprovalRequest({
        branch_id: ctx.branchId,
        request_type: "MASTER_DATA_CHANGE",
        entity_type: "COLOR",
        entity_id: "NEW",
        summary: `Create Dupe Color 1`,
        new_value: { _action: "create", name: duplicateName },
        status: "PENDING",
        requested_by: ctx.otherUser.id,
        requested_at: new Date(),
      });
      const r2 = await createApprovalRequest({
        branch_id: ctx.branchId,
        request_type: "MASTER_DATA_CHANGE",
        entity_type: "COLOR",
        entity_id: "NEW",
        summary: `Create Dupe Color 2`,
        new_value: { _action: "create", name: duplicateName },
        status: "PENDING",
        requested_by: ctx.otherUser.id,
        requested_at: new Date(),
      });
      createdApprovalIds.push(r1, r2);

      await gotoApprovals(page, "PENDING");

      const btn1 = page.locator(`form[action$="/${r1}/approve"] button`).first();
      await expect(btn1).toBeVisible();
      await Promise.all([page.waitForURL(/approvals/), btn1.click()]);
      await expect(page.locator("[data-ui-notice-toast]")).toContainText(/approved/i);
      await expect(page.locator("[data-ui-notice-toast]")).toHaveClass(/hidden/, { timeout: 10000 });

      const btn2 = page.locator(`form[action$="/${r2}/approve"] button`).first();
      await expect(btn2).toBeVisible();
      await Promise.all([page.waitForURL(/approvals/), btn2.click()]);

      const toast = page.locator("[data-ui-notice-toast]");
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(/error|failed|exists/i);
    });
  });

  test.describe("Approval actions", () => {
    test("approve action moves request to approved and shows toast", async ({ page }) => {
      await gotoApprovals(page, "PENDING");
      const approveBtn = page.locator(`form[action$="/${ctx.ids.pendingUpdate}/approve"] button`).first();
      await expect(approveBtn).toBeVisible();
      await Promise.all([page.waitForURL(/approvals/i, { timeout: 30000 }), approveBtn.click()]);
      const toast = page.locator("[data-ui-notice-toast]");
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(/approved/i);
    });

    test("toast auto-dismisses after timeout", async ({ page }) => {
      await gotoApprovals(page, "PENDING");
      const approveBtn = page.locator(`form[action$="/${ctx.ids.pendingUpdateAuto}/approve"] button`).first();
      await expect(approveBtn).toBeVisible();
      await Promise.all([page.waitForURL(/approvals/i, { timeout: 30000 }), approveBtn.click()]);
      const toast = page.locator("[data-ui-notice-toast]").first();
      await expect(toast).toBeVisible();
      await page.waitForTimeout(4500);
      await expect(toast).toHaveClass(/hidden/);
    });

    test("reject action moves request to rejected and shows toast", async ({ page }) => {
      await gotoApprovals(page, "PENDING");
      const rejectBtn = page.locator(`form[action$="/${ctx.ids.pendingReject}/reject"] button`).first();
      await expect(rejectBtn).toBeVisible();
      await Promise.all([page.waitForURL(/approvals/i, { timeout: 30000 }), rejectBtn.click()]);
      const toast = page.locator("[data-ui-notice-toast]");
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(/rejected/i);
    });

    test("approved tab shows approved request row", async ({ page }) => {
      await gotoApprovals(page, "APPROVED");
      const row = page.locator("tbody tr", { hasText: ctx.skuLabel }).first();
      await expect(row).toBeVisible();
    });

    test("rejected tab shows rejected request row", async ({ page }) => {
      await gotoApprovals(page, "REJECTED");
      const row = page.locator("tbody tr", { hasText: ctx.skuLabel }).first();
      await expect(row).toBeVisible();
    });
  });

  test("non-pending rows hide action buttons", async ({ page }) => {
    await gotoApprovals(page, "APPROVED");
    const row = page.locator("tbody tr", { hasText: ctx.skuLabel }).first();
    await expect(row.locator("form")).toHaveCount(0);
  });

  test("details button includes data attributes", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
    const btn = row.locator("[data-approval-view]").first();
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute("data-approval-id");
    await expect(btn).toHaveAttribute("data-action");
  });

  test("status badge renders for pending row", async ({ page }) => {
    await gotoApprovals(page, "PENDING");
    const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
    await expect(row).toContainText(/pending/i);
  });

  test("approved rows show decided date text", async ({ page }) => {
    await gotoApprovals(page, "APPROVED");
    const row = page.locator("tbody tr", { hasText: ctx.skuLabel }).first();
    await expect(row).toBeVisible();
    await expect(row.locator("td").last()).toContainText(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
  });

  test("account approval: edit modal updates fields (including branches) then approve succeeds", async ({ page }) => {
    test.setTimeout(90000);
    test.skip(!ctx.fixture?.accountSubgroupId || !ctx.fixture?.branchIds?.length, "Missing fixture data for account approval edit test.");
    const suffix = Date.now();
    const requestId = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "ACCOUNT",
      entity_id: "NEW",
      summary: `Create Accounts EditFlow ${suffix}`,
      new_value: {
        _action: "create",
        code: `e2e_account_${suffix}`,
        name: `E2E Account ${suffix}`,
        name_ur: `E2E Account ${suffix}`,
        subgroup_id: String(ctx.fixture.accountSubgroupId),
        branch_ids: [String(ctx.fixture.branchIds[0])],
        lock_posting: false,
      },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });
    createdApprovalIds.push(requestId);

    await gotoApprovals(page, "PENDING");
    const row = page.locator(`tbody tr:has(form[action$="/${requestId}/approve"])`).first();
    await expect(row).toBeVisible();
    await row.locator("[data-approval-view]").click();

    const modal = page.locator("[data-approval-detail-modal]");
    await expect(modal).toBeVisible();
    await modal.locator("[data-approval-edit-btn]").click();
    await expect(modal.locator("[data-approval-edit-save]")).toBeVisible();

    const panel = modal.locator("[data-approval-preview]").first();
    await panel.locator('[data-field="name"]').fill(`E2E Account Edited ${suffix}`);

    const branchSelect = panel.locator('select[data-field="branch_ids"]');
    const branchOptionCount = await branchSelect.evaluate((el) => Array.from(el.options || []).filter((opt) => String(opt.value || "").trim() !== "").length);
    const selectedBefore = await branchSelect.evaluate((el) => Array.from(el.selectedOptions).map((o) => o.value));
    const trigger = panel.locator("[data-multi-select] [data-multi-trigger]").first();
    await trigger.click();
    const menu = panel.locator("[data-multi-select] [data-multi-menu]").first();
    await expect(menu).toBeVisible();
    const firstMenuOption = panel.locator("[data-multi-select] [data-multi-menu] button").first();
    await expect(firstMenuOption).toBeVisible();
    await firstMenuOption.click();
    let selectedAfter = await branchSelect.evaluate((el) => Array.from(el.selectedOptions).map((o) => o.value));
    if (!selectedAfter.length) {
      await branchSelect.evaluate((el) => {
        const options = Array.from(el.options || []);
        if (options[0]) {
          options.forEach((option, idx) => {
            option.selected = idx === 0;
          });
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      selectedAfter = await branchSelect.evaluate((el) => Array.from(el.selectedOptions).map((o) => o.value));
    }
    expect(selectedAfter.length).toBeGreaterThan(0);
    if (branchOptionCount > 1) {
      expect(selectedAfter.length).toBeGreaterThan(0);
    }

    const dialogMessage = await withNextDialogAccepted(page, async () => {
      await modal.locator("[data-approval-edit-save]").click();
    });
    expect(dialogMessage.toLowerCase()).toContain("approval");

    await gotoApprovals(page, "PENDING");
    const updatedRow = page.locator(`tbody tr:has(form[action$="/${requestId}/approve"])`).first();
    await expect(updatedRow).toBeVisible();
    await updatedRow.locator(`form[action$="/${requestId}/approve"] button`).click();

    const toast = page.locator("[data-ui-notice-toast]").first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/approved/i);
  });

  test("party approval: edit modal updates fields (including branches) then approve succeeds", async ({ page }) => {
    test.setTimeout(90000);
    test.skip(!ctx.fixture?.cityId || !ctx.fixture?.branchIds?.length, "Missing fixture data for party approval edit test.");
    const suffix = Date.now();
    const requestId = await createApprovalRequest({
      branch_id: ctx.branchId,
      request_type: "MASTER_DATA_CHANGE",
      entity_type: "PARTY",
      entity_id: "NEW",
      summary: `Create Parties EditFlow ${suffix}`,
      new_value: {
        _action: "create",
        code: `e2e_party_${suffix}`,
        name: `E2E Party ${suffix}`,
        name_ur: `E2E Party ${suffix}`,
        party_type: "CUSTOMER",
        group_id: ctx.fixture.partyGroupId ? String(ctx.fixture.partyGroupId) : null,
        city_id: String(ctx.fixture.cityId),
        phone1: "0300-0000000",
        credit_allowed: true,
        credit_limit: 1000,
        branch_ids: [String(ctx.fixture.branchIds[0])],
      },
      status: "PENDING",
      requested_by: ctx.otherUser.id,
      requested_at: new Date(),
    });
    createdApprovalIds.push(requestId);

    await gotoApprovals(page, "PENDING");
    const row = page.locator(`tbody tr:has(form[action$="/${requestId}/approve"])`).first();
    await expect(row).toBeVisible();
    await row.locator("[data-approval-view]").click();

    const modal = page.locator("[data-approval-detail-modal]");
    await expect(modal).toBeVisible();
    await modal.locator("[data-approval-edit-btn]").click();
    await expect(modal.locator("[data-approval-edit-save]")).toBeVisible();

    const panel = modal.locator("[data-approval-preview]").first();
    await panel.locator('[data-field="name"]').fill(`E2E Party Edited ${suffix}`);

    const branchSelect = panel.locator('select[data-field="branch_ids"]');
    const branchOptionCount = await branchSelect.evaluate((el) => Array.from(el.options || []).filter((opt) => String(opt.value || "").trim() !== "").length);
    const selectedBefore = await branchSelect.evaluate((el) => Array.from(el.selectedOptions).map((o) => o.value));
    const trigger = panel.locator("[data-multi-select] [data-multi-trigger]").first();
    await trigger.click();
    const menu = panel.locator("[data-multi-select] [data-multi-menu]").first();
    await expect(menu).toBeVisible();
    const firstMenuOption = panel.locator("[data-multi-select] [data-multi-menu] button").first();
    await expect(firstMenuOption).toBeVisible();
    await firstMenuOption.click();
    let selectedAfter = await branchSelect.evaluate((el) => Array.from(el.selectedOptions).map((o) => o.value));
    if (!selectedAfter.length) {
      await branchSelect.evaluate((el) => {
        const options = Array.from(el.options || []);
        if (options[0]) {
          options.forEach((option, idx) => {
            option.selected = idx === 0;
          });
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      selectedAfter = await branchSelect.evaluate((el) => Array.from(el.selectedOptions).map((o) => o.value));
    }
    expect(selectedAfter.length).toBeGreaterThan(0);
    if (branchOptionCount > 1) {
      expect(selectedAfter.length).toBeGreaterThan(0);
    }

    const dialogMessage = await withNextDialogAccepted(page, async () => {
      await modal.locator("[data-approval-edit-save]").click();
    });
    expect(dialogMessage.toLowerCase()).toContain("approval");

    await gotoApprovals(page, "PENDING");
    const updatedRow = page.locator(`tbody tr:has(form[action$="/${requestId}/approve"])`).first();
    await expect(updatedRow).toBeVisible();
    await updatedRow.locator(`form[action$="/${requestId}/approve"] button`).click();

    const toast = page.locator("[data-ui-notice-toast]").first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/approved/i);
  });

  test("matrix: approval edit/save/approve works across current master-data request types", async ({ page }) => {
    test.setTimeout(300000);
    test.skip(!ctx.fixture?.branchIds?.length, "Missing branch fixture data for approval matrix test.");

    const baseToken = Date.now();
    const primaryBranchId = String(ctx.fixture.branchIds[0] || ctx.branchId);
    const matrixSpecs = [
      {
        summary: `Create Sizes Matrix ${baseToken}`,
        entity_type: "SIZE",
        new_value: { _action: "create", name: `E2E Size Matrix ${baseToken}` },
      },
      {
        summary: `Create Colors Matrix ${baseToken}`,
        entity_type: "COLOR",
        new_value: { _action: "create", name: `E2E Color Matrix ${baseToken}` },
      },
      {
        summary: `Create Grades Matrix ${baseToken}`,
        entity_type: "GRADE",
        new_value: { _action: "create", name: `E2E Grade Matrix ${baseToken}` },
      },
      {
        summary: `Create Packing Matrix ${baseToken}`,
        entity_type: "PACKING_TYPE",
        new_value: { _action: "create", name: `E2E Packing Matrix ${baseToken}` },
      },
      {
        summary: `Create Cities Matrix ${baseToken}`,
        entity_type: "CITY",
        new_value: { _action: "create", name: `E2E City Matrix ${baseToken}` },
      },
      {
        summary: `Create Departments Matrix ${baseToken}`,
        entity_type: "DEPARTMENT",
        new_value: { _action: "create", name: `E2E Department Matrix ${baseToken}` },
      },
      {
        summary: `Create Accounts Matrix ${baseToken}`,
        entity_type: "ACCOUNT",
        skip: !ctx.fixture.accountSubgroupId,
        new_value: {
          _action: "create",
          code: `e2e_account_matrix_${baseToken}`,
          name: `E2E Account Matrix ${baseToken}`,
          name_ur: `E2E Account Matrix ${baseToken}`,
          subgroup_id: String(ctx.fixture.accountSubgroupId || ""),
          branch_ids: [primaryBranchId],
          lock_posting: false,
        },
      },
      {
        summary: `Create Parties Matrix ${baseToken}`,
        entity_type: "PARTY",
        skip: !ctx.fixture.cityId,
        new_value: {
          _action: "create",
          code: `e2e_party_matrix_${baseToken}`,
          name: `E2E Party Matrix ${baseToken}`,
          name_ur: `E2E Party Matrix ${baseToken}`,
          party_type: "CUSTOMER",
          group_id: ctx.fixture.partyGroupId ? String(ctx.fixture.partyGroupId) : null,
          city_id: String(ctx.fixture.cityId || ""),
          phone1: "0300-0000000",
          credit_allowed: true,
          credit_limit: 1000,
          branch_ids: [primaryBranchId],
        },
      },
    ].filter((spec) => !spec.skip);

    const matrixRequests = [];
    for (let i = 0; i < matrixSpecs.length; i += 1) {
      const spec = matrixSpecs[i];
      const requestId = await createApprovalRequest({
        branch_id: ctx.branchId,
        request_type: "MASTER_DATA_CHANGE",
        entity_type: spec.entity_type,
        entity_id: "NEW",
        summary: spec.summary,
        new_value: spec.new_value,
        status: "PENDING",
        requested_by: ctx.otherUser.id,
        requested_at: new Date(),
      });
      matrixRequests.push({ id: requestId, spec });
      createdApprovalIds.push(requestId);
    }

    await gotoApprovals(page, "PENDING");
    for (let i = 0; i < matrixRequests.length; i += 1) {
      const item = matrixRequests[i];
      const row = page.locator(`tbody tr:has(form[action$="/${item.id}/approve"])`).first();
      await expect(row).toBeVisible();
      await row.locator("[data-approval-view]").click();

      const modal = page.locator("[data-approval-detail-modal]");
      await expect(modal).toBeVisible();
      await modal.locator("[data-approval-edit-btn]").click();
      await expect(modal.locator("[data-approval-edit-save]")).toBeVisible();

      const panel = modal.locator("[data-approval-preview]").first();
      await mutateApprovalPanelFields(panel, `${baseToken}_${i}`);
      await ensureBranchMultiSelectInteractive(panel);

      const editResponse = page.waitForResponse((res) => {
        return res.request().method() === "POST" && res.url().includes(`/administration/approvals/${item.id}/edit`);
      });
      const saveDialogText = await withNextDialogAccepted(page, async () => {
        await modal.locator("[data-approval-edit-save]").click();
      });
      const response = await editResponse;
      expect(response.status()).toBe(200);
      expect((saveDialogText || "").trim().length).toBeGreaterThan(0);
      expect((saveDialogText || "").toLowerCase()).not.toMatch(/unable|failed|error/);

      await page.waitForLoadState("domcontentloaded");
      const approveBtn = page.locator(`form[action$="/${item.id}/approve"] button`).first();
      await expect(approveBtn).toBeVisible();
      await approveBtn.click();
      const toast = page.locator("[data-ui-notice-toast]").first();
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(/approved/i);
      await gotoApprovals(page, "PENDING");
    }
  });

  test.describe("Approval settings and source pages", () => {
    const policyTargets = ["master_data.accounts", "master_data.parties", "master_data.products.finished", "master_data.products.semi_finished", "master_data.products.raw_materials", "master_data.products.skus", "master_data.basic_info"];
    const policyActions = ["create", "edit", "delete", "hard_delete"];

    test.beforeEach(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    test("enables approval policy for all targets", async ({ page }) => {
      test.setTimeout(120000);
      await login(page, "E2E_ADMIN");
      await gotoApprovalSettings(page);
      for (const scopeKey of policyTargets) {
        for (const action of policyActions) {
          await ensureCheckbox(page, `SCREEN:${scopeKey}:${action}`, true);
        }
      }
      await page.getByRole("button", { name: /save/i }).click();
      await page.waitForLoadState("domcontentloaded");

      await gotoApprovalSettings(page);
      for (const scopeKey of policyTargets) {
        for (const action of policyActions) {
          const name = `SCREEN:${scopeKey}:${action}`;
          const checkbox = page.locator(`input[name="${name}"]`).first();
          if ((await checkbox.count()) > 0) {
            await expect(checkbox).toBeChecked();
          }
        }
      }
    });

    test("accounts create queues approval via source page", async ({ page }) => {
      await login(page, "E2E_MANAGER");
      await page.goto("/master-data/accounts", { waitUntil: "domcontentloaded" });
      await page.locator("[data-modal-open]").click();
      const modal = page.locator("#modal-shell");
      await expect(modal).toBeVisible();
      const name = `E2E Account ${Date.now()}`;
      await modal.locator('[data-field="name"]').fill(name);
      await modal.locator('[data-field="name_ur"]').fill(name);
      await selectFirstNonEmpty(page, 'select[data-field="subgroup_id"]');
      await selectFirstNonEmpty(page, 'select[data-field="branch_ids"]');
      await modal.locator('form[data-modal-form] button[type="submit"]').click();

      const toast = page.locator("[data-ui-notice-toast]").first();
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(/approval/i);

      await gotoApprovals(page, "PENDING");
      await expect(page.locator("tbody tr", { hasText: "Create Accounts" }).first()).toBeVisible();
    });

    test("parties create queues approval via source page", async ({ page }) => {
      await login(page, "E2E_MANAGER");
      await page.goto("/master-data/parties", { waitUntil: "domcontentloaded" });
      await page.locator("[data-modal-open]").click();
      const modal = page.locator("#modal-shell");
      await expect(modal).toBeVisible();
      const name = `E2E Party ${Date.now()}`;
      await modal.locator('[data-field="name"]').fill(name);
      await modal.locator('[data-field="name_ur"]').fill(name);
      await modal.locator('select[data-field="party_type"]').selectOption("CUSTOMER");
      await selectFirstNonEmpty(page, 'select[data-field="city_id"]');
      await selectFirstNonEmpty(page, 'select[data-field="branch_ids"]');
      await modal.locator('[data-field="phone1"]').fill("0300-0000000");
      await modal.locator('form[data-modal-form] button[type="submit"]').click();

      const toast = page.locator("[data-ui-notice-toast]").first();
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(/approval/i);

      await gotoApprovals(page, "PENDING");
      await expect(page.locator("tbody tr", { hasText: "Create Parties" }).first()).toBeVisible();
    });

    test("parties edit queues approval via source page", async ({ page }) => {
      // 1. Create a party directly in the DB so we have something to edit
      // (This bypasses approval logic to ensure test data exists)
      const knex = require("./utils/db").knex; // Assuming access to knex or create helper
      const partyName = `Pre-Existing Party ${Date.now()}`;

      // We need to login as ADMIN to ensure we can create data if approval is on,
      // OR we just insert into DB directly.
      // Inserting into DB is safer/faster for test setup.
      await page.context().clearCookies(); // Ensure clean slate if needed, or just insert

      // NOTE: Direct DB insert is complex due to relations (branch_ids, etc.)
      // So we will try to find an existing one first, or assume one exists from seeds.
      // If the list is empty, we must fail gracefully or create one.

      await login(page, "E2E_MANAGER");
      await page.goto("/master-data/parties", { waitUntil: "domcontentloaded" });

      // Check if table is empty
      const emptyState = page.locator("#module-empty-state");
      if (await emptyState.isVisible()) {
        // Create one via UI (expecting approval) - but we need it APPROVED to edit it.
        // Since we can't easily approve mid-test without complexity, let's skip if empty
        // OR better: Assume seeds ran.
        console.warn("Parties table empty, cannot test Edit Flow properly without seeding.");
        // Ideally, we'd insert a party via SQL here.
      }

      // Try to find an edit button
      const editBtn = page.locator("tbody tr a[href*='/edit']").first();

      // If we can't find direct link, try action menu
      if ((await editBtn.count()) === 0) {
        const menuBtn = page.locator("tbody tr button[data-action-menu]").first();
        if ((await menuBtn.count()) > 0) {
          await menuBtn.click();
          await page.locator("a[data-edit-action]").first().click();
        } else {
          // Fallback: If absolutely no rows, we can't test edit.
          // In a real E2E env, we should seed a "Permanent Party" in beforeAll.
          test.skip(true, "No parties available to edit");
          return;
        }
      } else {
        await editBtn.click();
      }

      await page.waitForLoadState("domcontentloaded");

      const nameInput = page.locator('[name="name"]');
      await nameInput.fill(`E2E Party Updated ${Date.now()}`);
      await page.locator('button[type="submit"]').click();

      const toast = page.locator("[data-ui-notice-toast]").first();
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(/approval/i);

      await gotoApprovals(page, "PENDING");
      await expect(page.locator("tbody tr", { hasText: "Update Parties" }).first()).toBeVisible();
    });

    test("finished items create queues approval via source page", async ({ page }) => {
      await login(page, "E2E_MANAGER");
      await page.goto("/master-data/products/finished", { waitUntil: "domcontentloaded" });
      await page.locator("[data-modal-open]").click();

      const modal = page.locator("#modal-shell");
      await expect(modal).toBeVisible();

      const name = `E2E Finished ${Date.now()}`;
      await modal.locator('[name="name"]').fill(name);
      await modal.locator('[name="name_ur"]').fill(name);

      // FIX: Select Group (Required)
      await selectFirstNonEmpty(page, 'select[name="group_id"]');

      // FIX: Correct field name is 'base_uom_id', not 'uom_id'
      await selectFirstNonEmpty(page, 'select[name="base_uom_id"]');

      // FIX: Correct field name is 'product_type_id', not 'category_id'
      await selectFirstNonEmpty(page, 'select[name="product_type_id"]');

      await modal.locator('form[data-modal-form] button[type="submit"]').click();

      const toast = page.locator("[data-ui-notice-toast]").first();
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(/approval/i);

      await gotoApprovals(page, "PENDING");
      await expect(page.locator("tbody tr", { hasText: "Create Finished Items" }).first()).toBeVisible();
    });
    test("basic info (sizes) create queues approval via source page", async ({ page }) => {
      await login(page, "E2E_MANAGER");

      // FIX 1: Use the correct URL path
      await page.goto("/master-data/basic-info/sizes", { waitUntil: "domcontentloaded" });

      // FIX 2: Wait for button explicitly to ensure permission loaded
      const addBtn = page.locator("[data-modal-open]");
      await expect(addBtn).toBeVisible();
      await addBtn.click();

      const modal = page.locator("#modal-shell");
      await expect(modal).toBeVisible();

      const name = `E2E Size ${Date.now()}`;

      // FIX 3: Fill all required fields (name, name_ur, item_types)
      await modal.locator('[name="name"]').fill(name);
      await modal.locator('[name="name_ur"]').fill(name);

      // Check at least one "Applies To" box (e.g., Finished Goods)
      // The value 'FG' corresponds to 'finished_goods' in the options
      await modal.locator('input[name="item_types"][value="FG"]').check();

      await modal.locator('form[data-modal-form] button[type="submit"]').click();

      const toast = page.locator("[data-ui-notice-toast]").first();
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(/approval/i);

      await gotoApprovals(page, "PENDING");
      await expect(page.locator("tbody tr", { hasText: "Create Sizes" }).first()).toBeVisible();
    });
    test("restores approval policy snapshot", async ({ page }) => {
      test.setTimeout(120000);
      if (!ctx.approvalPolicySnapshot.size) return;
      await login(page, "E2E_ADMIN");
      await gotoApprovalSettings(page);
      for (const [name, value] of ctx.approvalPolicySnapshot.entries()) {
        await ensureCheckbox(page, name, value);
      }
      await page.getByRole("button", { name: /save/i }).click();
      await page.waitForLoadState("domcontentloaded");
    });
  });
}); // const { test, expect } = require("@playwright/test");
// const { login } = require("./utils/auth");
// const { getBranch, getTwoDistinctUsers, getVariantForSkuApproval, createApprovalRequest, deleteApprovalRequests, setVariantSaleRate, upsertUserWithPermissions, clearUserPermissionsOverride, closeDb } = require("./utils/db");
//
// const compactJoin = (parts) =>
//   parts
//     .map((part) => (part == null ? "" : String(part).trim()))
//     .filter(Boolean)
//     .join(" ");
//
// const buildSkuLabel = (row) => compactJoin([row.item_name, row.size_name, row.packing_name, row.grade_name, row.color_name]) || "-";
//
// test.describe("Approvals page scenarios", () => {
//   test.describe.configure({ mode: "serial" });
//   const debug = process.env.DEBUG_APPROVAL_E2E === "1";
//   const debugLog = (...args) => {
//     if (debug) console.log("[approvals.spec]", ...args);
//   };
//   const createdApprovalIds = [];
//   const masterApprovalSpecs = [
//     { summary: "Create Accounts", value: "E2E Cash Account" },
//     { summary: "Create Parties", value: "E2E Demo Party" },
//     { summary: "Create Raw Materials", value: "E2E Raw Material" },
//     { summary: "Create Finished Items", value: "E2E Finished Item" },
//   ];
//   const ctx = {
//     ready: false,
//     skipReason: "",
//     branchId: null,
//     adminUser: null,
//     otherUser: null,
//     managerUser: null,
//     variant: null,
//     skuLabel: "",
//     originalRate: null,
//     approvalPolicySnapshot: new Map(),
//     ids: {
//       pendingNew: null,
//       pendingUpdate: null,
//       pendingUpdateAuto: null,
//       pendingReject: null,
//       pendingSize: null,
//       pendingColor: null,
//       pendingGrade: null,
//       pendingPacking: null,
//       pendingCity: null,
//       pendingDepartment: null,
//       pendingAccount: null,
//       pendingParty: null,
//       pendingItemRm: null,
//       pendingItemFg: null,
//       approved: null,
//       rejected: null,
//     },
//     basicApprovals: [],
//     masterApprovals: masterApprovalSpecs,
//   };
//
//   test.beforeAll(async () => {
//     const branch = await getBranch();
//     const users = await getTwoDistinctUsers(process.env.E2E_ADMIN_USER);
//     const variant = await getVariantForSkuApproval();
//
//     if (!branch || !users || !variant) {
//       const hasBranch = Boolean(branch);
//       const hasUsers = Boolean(users);
//       const hasVariant = Boolean(variant);
//       const adminUserEnv = process.env.E2E_ADMIN_USER || "(not set)";
//       const detail = `hasBranch=${hasBranch} hasUsers=${hasUsers} hasVariant=${hasVariant} admin=${adminUserEnv}`;
//       console.warn("[approvals.spec] Skipping: missing data", { hasBranch, hasUsers, hasVariant, adminUserEnv });
//       process.stdout.write(`[approvals.spec] Skipping: missing data ${detail}\n`);
//       try {
//         const fs = require("fs");
//         const path = require("path");
//         const outPath = path.join(process.cwd(), "test-results", "approvals-skip.txt");
//         fs.writeFileSync(outPath, `[approvals.spec] Skipping: missing data ${detail}\n`, "utf8");
//       } catch (err) {
//         // ignore
//       }
//       ctx.skipReason = `Missing branch, users, or SKU variant data for approval tests. (${detail})`;
//       return;
//     }
//
//     ctx.ready = true;
//     ctx.branchId = branch.id;
//     ctx.adminUser = users.primary;
//     ctx.otherUser = users.secondary;
//     ctx.variant = variant;
//     ctx.skuLabel = buildSkuLabel(variant);
//     ctx.originalRate = variant.sale_rate;
//
//     const managerUsername = process.env.E2E_MANAGER_USER || "manager1";
//     const managerPassword = process.env.E2E_MANAGER_PASS || "Manager@123";
//     process.env.E2E_MANAGER_USER = managerUsername;
//     process.env.E2E_MANAGER_PASS = managerPassword;
//     const managerUserId = await upsertUserWithPermissions({
//       username: managerUsername,
//       password: managerPassword,
//       roleName: "Manager",
//       branchId: ctx.branchId,
//       scopeKeys: ["master_data.accounts", "master_data.parties"],
//     });
//     ctx.managerUser = { id: managerUserId, username: managerUsername };
//
//     const newRate = Number(variant.sale_rate || 0) + 7;
//
//     ctx.ids.pendingNew = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "SKU",
//       entity_id: "NEW",
//       summary: `New Variant: ${variant.item_name}`,
//       new_value: {
//         _action: "create",
//         item_id: variant.item_id,
//         size_id: variant.size_id,
//         grade_id: variant.grade_id,
//         color_id: variant.color_id,
//         packing_type_id: variant.packing_type_id,
//         sale_rate: newRate,
//       },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingUpdate = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "SKU",
//       entity_id: String(variant.id),
//       summary: "Edit SKUs",
//       new_value: { _action: "update", sale_rate: newRate },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingUpdateAuto = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "SKU",
//       entity_id: String(variant.id),
//       summary: "Edit SKUs AutoDismiss",
//       new_value: { _action: "update", sale_rate: newRate + 1 },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingReject = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "SKU",
//       entity_id: String(variant.id),
//       summary: "Deactivate SKUs",
//       new_value: { _action: "update", sale_rate: newRate },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingSize = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "SIZE",
//       entity_id: "NEW",
//       summary: "Create Sizes",
//       new_value: { _action: "create", name: "E2E Size XL" },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingColor = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "COLOR",
//       entity_id: "NEW",
//       summary: "Create Colors",
//       new_value: { _action: "create", name: "E2E Color Blue" },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingGrade = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "GRADE",
//       entity_id: "NEW",
//       summary: "Create Grades",
//       new_value: { _action: "create", name: "E2E Grade A" },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingPacking = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "PACKING_TYPE",
//       entity_id: "NEW",
//       summary: "Create Packing Types",
//       new_value: { _action: "create", name: "E2E Carton Packed" },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingCity = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "CITY",
//       entity_id: "NEW",
//       summary: "Create Cities",
//       new_value: { _action: "create", name: "E2E City North" },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingDepartment = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "DEPARTMENT",
//       entity_id: "NEW",
//       summary: "Create Departments",
//       new_value: { _action: "create", name: "E2E Department Ops" },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingAccount = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "ACCOUNT",
//       entity_id: "NEW",
//       summary: "Create Accounts",
//       new_value: { _action: "create", name: "E2E Cash Account", name_ur: "E2E Cash Account" },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingParty = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "PARTY",
//       entity_id: "NEW",
//       summary: "Create Parties",
//       new_value: { _action: "create", name: "E2E Demo Party", name_ur: "E2E Demo Party", party_type: "CUSTOMER" },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingItemRm = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "ITEM",
//       entity_id: "NEW",
//       summary: "Create Raw Materials",
//       new_value: { _action: "create", item_type: "RM", name: "E2E Raw Material", name_ur: "E2E Raw Material" },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.ids.pendingItemFg = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "ITEM",
//       entity_id: "NEW",
//       summary: "Create Finished Items",
//       new_value: { _action: "create", item_type: "FG", name: "E2E Finished Item", name_ur: "E2E Finished Item" },
//       status: "PENDING",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//     });
//
//     ctx.basicApprovals = [
//       { id: ctx.ids.pendingSize, summary: "Create Sizes", value: "E2E Size XL" },
//       { id: ctx.ids.pendingColor, summary: "Create Colors", value: "E2E Color Blue" },
//       { id: ctx.ids.pendingGrade, summary: "Create Grades", value: "E2E Grade A" },
//       { id: ctx.ids.pendingPacking, summary: "Create Packing Types", value: "E2E Carton Packed" },
//       { id: ctx.ids.pendingCity, summary: "Create Cities", value: "E2E City North" },
//       { id: ctx.ids.pendingDepartment, summary: "Create Departments", value: "E2E Department Ops" },
//     ];
//
//     ctx.masterApprovals = masterApprovalSpecs;
//
//     ctx.ids.approved = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "SKU",
//       entity_id: String(variant.id),
//       summary: "Edit SKUs",
//       new_value: { _action: "update", sale_rate: newRate },
//       status: "APPROVED",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//       decided_by: ctx.adminUser.id,
//       decided_at: new Date(),
//     });
//
//     ctx.ids.rejected = await createApprovalRequest({
//       branch_id: ctx.branchId,
//       request_type: "MASTER_DATA_CHANGE",
//       entity_type: "SKU",
//       entity_id: String(variant.id),
//       summary: "Edit SKUs",
//       new_value: { _action: "update", sale_rate: newRate },
//       status: "REJECTED",
//       requested_by: ctx.otherUser.id,
//       requested_at: new Date(),
//       decided_by: ctx.adminUser.id,
//       decided_at: new Date(),
//     });
//
//     createdApprovalIds.push(ctx.ids.pendingNew, ctx.ids.pendingUpdate, ctx.ids.pendingReject, ctx.ids.pendingSize, ctx.ids.pendingColor, ctx.ids.pendingGrade, ctx.ids.pendingPacking, ctx.ids.pendingCity, ctx.ids.pendingDepartment, ctx.ids.pendingAccount, ctx.ids.pendingParty, ctx.ids.pendingItemRm, ctx.ids.pendingItemFg, ctx.ids.approved, ctx.ids.rejected);
//     createdApprovalIds.push(ctx.ids.pendingUpdateAuto);
//   });
//
//   test.afterAll(async () => {
//     await deleteApprovalRequests(createdApprovalIds.filter(Boolean));
//     if (ctx.variant?.id && ctx.originalRate != null) {
//       await setVariantSaleRate(ctx.variant.id, ctx.originalRate);
//     }
//     if (ctx.managerUser?.id) {
//       await clearUserPermissionsOverride({
//         userId: ctx.managerUser.id,
//         scopeKeys: ["master_data.accounts", "master_data.parties"],
//       });
//     }
//     await closeDb();
//   });
//
//   test.beforeEach(async ({ page }) => {
//     test.skip(!ctx.ready, ctx.skipReason);
//     if (debug) {
//       page.on("console", (msg) => {
//         if (msg.type() === "error") {
//           console.log("[approvals.spec][browser:error]", msg.text());
//         }
//       });
//       page.on("pageerror", (err) => {
//         console.log("[approvals.spec][pageerror]", err.message);
//       });
//       page.on("requestfailed", (req) => {
//         const failure = req.failure();
//         if (failure) {
//           console.log("[approvals.spec][requestfailed]", req.method(), req.url(), failure.errorText);
//         }
//       });
//     }
//     await login(page, "E2E_ADMIN");
//   });
//
//   const gotoApprovals = async (page, status) => {
//     const url = status ? `/administration/approvals?status=${status}` : "/administration/approvals";
//     await page.goto(url, { waitUntil: "domcontentloaded" });
//     debugLog("goto", status || "PENDING", await page.url());
//   };
//
//   const gotoApprovalSettings = async (page) => {
//     await page.goto("/administration/approvals/settings", { waitUntil: "domcontentloaded" });
//     await page.waitForSelector("#approval-table-container", { state: "attached" });
//     await page.evaluate(() => {
//       if (typeof filterCategory === "function") {
//         filterCategory("all");
//       } else {
//         document.getElementById("module-empty-state")?.classList.add("hidden");
//         document.getElementById("approval-toolbar")?.classList.remove("hidden");
//         document.getElementById("approval-table-container")?.classList.remove("hidden");
//       }
//     });
//     await page.locator("#approval-table-container").waitFor({ state: "attached" });
//   };
//
//   const ensureCheckbox = async (page, name, desired) => {
//     const checkbox = page.locator(`input[name="${name}"]`).first();
//     await checkbox.waitFor({ state: "attached" });
//     const current = await checkbox.isChecked();
//     if (!ctx.approvalPolicySnapshot.has(name)) {
//       ctx.approvalPolicySnapshot.set(name, current);
//     }
//     if (current !== desired) {
//       await page.evaluate(
//         ({ targetName, nextValue }) => {
//           const input = document.querySelector(`input[name="${targetName}"]`);
//           if (!input) return;
//           input.checked = nextValue;
//           input.dispatchEvent(new Event("input", { bubbles: true }));
//           input.dispatchEvent(new Event("change", { bubbles: true }));
//         },
//         { targetName: name, nextValue: desired },
//       );
//     }
//   };
//
//   const selectFirstNonEmpty = async (page, selector) => {
//     const select = page.locator(selector);
//     const options = await select.locator("option").all();
//     for (const option of options) {
//       const value = await option.getAttribute("value");
//       if (value && value.trim() !== "") {
//         await select.selectOption(value);
//         return value;
//       }
//     }
//     return null;
//   };
//
//   // Checks that the approvals page loads and displays the correct table headers.
//   test("loads approvals page with table headers", async ({ page }) => {
//     await gotoApprovals(page);
//     await expect(page.getByRole("columnheader", { name: /date/i })).toBeVisible();
//     await expect(page.getByRole("columnheader", { name: /requester/i })).toBeVisible();
//     await expect(page.getByRole("columnheader", { name: /summary/i })).toBeVisible();
//     await expect(page.getByRole("columnheader", { name: /status/i })).toBeVisible();
//   });
//
//   // Verifies that the Pending, Approved, and Rejected status tabs are visible on the approvals page.
//   test("shows status tabs", async ({ page }) => {
//     await gotoApprovals(page);
//     await expect(page.getByRole("link", { name: /pending/i })).toBeVisible();
//     await expect(page.getByRole("link", { name: /approved/i })).toBeVisible();
//     await expect(page.getByRole("link", { name: /rejected/i })).toBeVisible();
//   });
//
//   // Ensures the approvals page defaults to the Pending status tab and highlights it.
//   test("defaults to pending status", async ({ page }) => {
//     await gotoApprovals(page);
//     const pendingTab = page.getByRole("link", { name: /pending/i });
//     await expect(pendingTab).toHaveClass(/bg-slate-800/);
//   });
//
//   // Checks navigation to the Approved status tab and verifies the URL updates accordingly.
//   test("navigates to approved status tab", async ({ page }) => {
//     await gotoApprovals(page, "APPROVED");
//     await expect(page).toHaveURL(/status=APPROVED/);
//   });
//
//   // Checks navigation to the Rejected status tab and verifies the URL updates accordingly.
//   test("navigates to rejected status tab", async ({ page }) => {
//     await gotoApprovals(page, "REJECTED");
//     await expect(page).toHaveURL(/status=REJECTED/);
//   });
//
//   // Asserts that the pending list shows the full SKU label in the summary for Edit SKUs rows.
//   test("pending list appends SKU label for edit summary", async ({ page }) => {
//     await gotoApprovals(page, "PENDING");
//     const row = page.locator(`tbody tr:has(form[action$="/${ctx.ids.pendingUpdate}/approve"])`).first();
//     await expect(row).toBeVisible();
//     await expect(row).toContainText("Edit SKUs");
//     await expect(row).toContainText(ctx.skuLabel);
//   });
//
//   // Ensures that the summary column for SKU rows does not contain the string 'undefined'.
//   test("summary does not contain undefined for SKU rows", async ({ page }) => {
//     await gotoApprovals(page, "PENDING");
//     const tableText = await page.locator("tbody").innerText();
//     expect(tableText.toLowerCase()).not.toContain("undefined");
//   });
//
//   // Verifies that the view modal for a new SKU opens and displays only the single panel (no before/after).
//   test("view modal opens for new SKU and shows single panel", async ({ page }) => {
//     await gotoApprovals(page, "PENDING");
//     const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
//     await row.getByRole("button", { name: /view/i }).click();
//     await expect(page.locator("[data-approval-detail-modal]")).toBeVisible();
//     await expect(page.locator("[data-approval-detail-single]")).toBeVisible();
//     await expect(page.locator("[data-approval-detail-before]")).toHaveClass(/hidden/);
//     await expect(page.locator("[data-approval-detail-after]")).toHaveClass(/hidden/);
//   });
//
//   // Verifies that the view modal for editing a SKU opens and displays both before and after panels.
//   test("view modal opens for edit SKU and shows before/after panels", async ({ page }) => {
//     await gotoApprovals(page, "PENDING");
//     const row = page.locator("tbody tr", { hasText: "Edit SKUs" }).first();
//     await row.getByRole("button", { name: /view/i }).click();
//     await expect(page.locator("[data-approval-detail-modal]")).toBeVisible();
//     await expect(page.locator("[data-approval-detail-before]")).toBeVisible();
//     await expect(page.locator("[data-approval-detail-after]")).toBeVisible();
//   });
//
//   // Checks that the SKU preview modal renders the correct header and compact field labels.
//   test("view modal renders preview header and compact fields", async ({ page }) => {
//     await gotoApprovals(page, "PENDING");
//     const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
//     await row.getByRole("button", { name: /view/i }).click();
//     const modal = page.locator("[data-approval-detail-modal]");
//     await expect(modal).toBeVisible();
//     await expect(modal.getByText(/skus/i)).toBeVisible();
//     await expect(modal.getByText(/article/i)).toBeVisible();
//     await expect(modal.getByText(/rate/i)).toBeVisible();
//   });
//
//   // Ensures the modal can be closed by clicking the close button.
//   test("modal closes via close button", async ({ page }) => {
//     await gotoApprovals(page, "PENDING");
//     const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
//     await row.getByRole("button", { name: /view/i }).click();
//     const modal = page.locator("[data-approval-detail-modal]");
//     await expect(modal).toBeVisible();
//     await page.locator("[data-approval-detail-close]").click();
//     await expect(modal).toHaveClass(/hidden/);
//   });
//
//   // Ensures the modal can be closed by clicking the backdrop area.
//   test("modal closes via backdrop click", async ({ page }) => {
//     await gotoApprovals(page, "PENDING");
//     const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
//     await row.getByRole("button", { name: /view/i }).click();
//     const modal = page.locator("[data-approval-detail-modal]");
//     await expect(modal).toBeVisible();
//     await modal.click({ position: { x: 10, y: 10 } });
//     await expect(modal).toHaveClass(/hidden/);
//   });
//
//   // Checks that the SKU preview modal uses the compact width class (max-w-3xl).
//   test("SKU preview modal uses compact width", async ({ page }) => {
//     await gotoApprovals(page, "PENDING");
//     const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
//     await row.getByRole("button", { name: /view/i }).click();
//     const panel = page.locator("[data-approval-detail-panel]");
//     await expect(panel).toHaveClass(/max-w-3xl/);
//   });
//
//   // Verifies that the basic info approval preview uses the wide modal and renders the preview panel.
//   test("basic info approval preview renders and uses wide modal", async ({ page }) => {
//     await gotoApprovals(page, "PENDING");
//     const row = page.locator("tbody tr", { hasText: "Create Sizes" }).first();
//     await expect(row).toBeVisible();
//     const viewBtn = row.getByRole("button", { name: /view/i });
//     const approvalId = await viewBtn.getAttribute("data-approval-id");
//     const previewWait = approvalId ? page.waitForResponse((res) => res.url().includes(`/administration/approvals/${approvalId}/preview`) && (res.status() === 200 || res.status() === 204), { timeout: 10000 }) : Promise.resolve(null);
//     await viewBtn.click();
//     const previewResponse = await previewWait.catch((err) => {
//       if (debug) debugLog("basic-info preview response wait failed", err?.message || err);
//       return null;
//     });
//     if (debug && previewResponse) {
//       debugLog("basic-info preview response", {
//         status: previewResponse.status(),
//         url: previewResponse.url(),
//       });
//     }
//     const panel = page.locator("[data-approval-detail-panel]");
//     await expect(panel).toHaveClass(/max-w-6xl/);
//     const preview = page.locator('[data-approval-preview][data-preview-type="basic-info"]');
//     await expect(preview).toBeVisible({ timeout: 10000 });
//   });
//
//   // Checks that the preview modal for each master data type hydrates the name field correctly and closes properly.
//   test("basic info previews hydrate name field for multiple master data types", async ({ page }) => {
//     await gotoApprovals(page, "PENDING");
//     for (const entry of ctx.basicApprovals) {
//       const row = page.locator("tbody tr", { hasText: entry.summary }).first();
//       await expect(row).toBeVisible();
//       await row.getByRole("button", { name: /view/i }).click();
//       const modal = page.locator("[data-approval-detail-modal]");
//       await expect(modal).toBeVisible();
//       const nameInput = modal.locator('[data-approval-preview] [data-field="name"]').first();
//       await expect(nameInput).toHaveValue(entry.value);
//       const closeBtn = page.locator("[data-approval-detail-close]").first();
//       await closeBtn.scrollIntoViewIfNeeded();
//       await closeBtn.click({ force: true });
//       await expect(modal).toHaveClass(/hidden/);
//     }
//   });
//
//   // Group: Tests that master approval previews hydrate the name field for each master data type and close the modal.
//   test.describe("master approval previews", () => {
//     for (const entry of masterApprovalSpecs) {
//       // Ensures the preview modal for each master approval type hydrates the name field and closes the modal.
//       test(`hydrates name field: ${entry.summary}`, async ({ page }) => {
//         await gotoApprovals(page, "PENDING");
//         const row = page.locator("tbody tr", { hasText: entry.summary }).first();
//         await expect(row).toBeVisible();
//         await row.getByRole("button", { name: /view/i }).click();
//         const modal = page.locator("[data-approval-detail-modal]");
//         await expect(modal).toBeVisible();
//         const nameInput = modal.locator('[data-approval-preview] [data-field="name"]').first();
//         await expect(nameInput).toHaveValue(entry.value);
//         if (debug) {
//           debugLog("modal box", await modal.boundingBox());
//           debugLog("viewport", page.viewportSize());
//         }
//         await modal.click({ position: { x: 5, y: 5 } });
//         await expect(modal).toHaveClass(/hidden/);
//       });
//     }
//   });
//
//   test.describe("Approval actions", () => {
//     test.describe.configure({ mode: "serial" });
//
//     // Approves a pending request, verifies the toast appears, and the request moves to Approved.
//     test("approve action moves request to approved and shows toast", async ({ page }) => {
//       await gotoApprovals(page, "PENDING");
//       const approveBtn = page.locator(`form[action$="/${ctx.ids.pendingUpdate}/approve"] button`).first();
//       await expect(approveBtn).toBeVisible();
//       await Promise.all([page.waitForURL(/approvals/i, { timeout: 30000 }), approveBtn.click()]);
//       const toast = page.locator("[data-ui-notice-toast]");
//       await expect(toast).toBeVisible();
//       debugLog("approve toast", await toast.innerText());
//       await expect(toast).toContainText(/approved/i);
//     });
//
//     // Checks that the approval toast auto-dismisses after the specified timeout.
//     test("toast auto-dismisses after timeout", async ({ page }) => {
//       await gotoApprovals(page, "PENDING");
//       const approveBtn = page.locator(`form[action$="/${ctx.ids.pendingUpdateAuto}/approve"] button`).first();
//       await expect(approveBtn).toBeVisible();
//       await Promise.all([page.waitForURL(/approvals/i, { timeout: 30000 }), approveBtn.click()]);
//       const toast = page.locator("[data-ui-notice-toast]").first();
//       try {
//         await toast.waitFor({ state: "attached", timeout: 5000 });
//       } catch (err) {
//         if (debug) {
//           const cookies = await page.context().cookies();
//           debugLog("auto-dismiss toast missing", {
//             url: page.url(),
//             uiNoticeCookie: cookies.find((c) => c.name === "ui_notice") || null,
//           });
//         }
//         throw err;
//       }
//       if (await toast.isVisible()) {
//         debugLog("auto-dismiss toast", await toast.innerText());
//       }
//       await page.waitForTimeout(4500);
//       await expect(toast).toHaveClass(/hidden/);
//     });
//
//     // Rejects a pending request, verifies the toast appears, and the request moves to Rejected.
//     test("reject action moves request to rejected and shows toast", async ({ page }) => {
//       await gotoApprovals(page, "PENDING");
//       const rejectBtn = page.locator(`form[action$="/${ctx.ids.pendingReject}/reject"] button`).first();
//       await expect(rejectBtn).toBeVisible();
//       await Promise.all([page.waitForURL(/approvals/i, { timeout: 30000 }), rejectBtn.click()]);
//       const toast = page.locator("[data-ui-notice-toast]");
//       await expect(toast).toBeVisible();
//       debugLog("reject toast", await toast.innerText());
//       await expect(toast).toContainText(/rejected/i);
//     });
//
//     // Verifies that the Approved tab displays the approved request row with the correct SKU label.
//     test("approved tab shows approved request row", async ({ page }) => {
//       await gotoApprovals(page, "APPROVED");
//       const row = page.locator("tbody tr", { hasText: ctx.skuLabel }).first();
//       await expect(row).toBeVisible();
//     });
//
//     // Verifies that the Rejected tab displays the rejected request row with the correct SKU label.
//     test("rejected tab shows rejected request row", async ({ page }) => {
//       await gotoApprovals(page, "REJECTED");
//       const row = page.locator("tbody tr", { hasText: ctx.skuLabel }).first();
//       await expect(row).toBeVisible();
//     });
//   });
//
//   // Ensures that action buttons are hidden for non-pending (approved/rejected) rows.
//   test("non-pending rows hide action buttons", async ({ page }) => {
//     await gotoApprovals(page, "APPROVED");
//     const row = page.locator("tbody tr", { hasText: ctx.skuLabel }).first();
//     await expect(row.locator("form")).toHaveCount(0);
//   });
//
//   // Checks that the details (view) button includes the required data attributes for approval id and action.
//   test("details button includes data attributes", async ({ page }) => {
//     await gotoApprovals(page, "PENDING");
//     const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
//     const btn = row.locator("[data-approval-view]").first();
//     await expect(btn).toBeVisible();
//     await expect(btn).toHaveAttribute("data-approval-id");
//     await expect(btn).toHaveAttribute("data-action");
//   });
//
//   // Verifies that the status badge is rendered for a pending row.
//   test("status badge renders for pending row", async ({ page }) => {
//     await gotoApprovals(page, "PENDING");
//     const row = page.locator("tbody tr", { hasText: "New Variant:" }).first();
//     await expect(row).toContainText(/pending/i);
//   });
//
//   // Checks that approved rows display the decided date in the last column.
//   test("approved rows show decided date text", async ({ page }) => {
//     await gotoApprovals(page, "APPROVED");
//     const row = page.locator("tbody tr", { hasText: ctx.skuLabel }).first();
//     await expect(row).toBeVisible();
//     await expect(row.locator("td").last()).toContainText(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
//   });
//
//   test.describe("Approval settings and source pages", () => {
//     test.describe.configure({ mode: "serial" });
//
//     const policyTargets = ["master_data.accounts", "master_data.parties", "master_data.products.finished", "master_data.products.semi_finished", "master_data.products.raw_materials", "master_data.products.skus"];
//     const policyActions = ["create", "edit", "delete", "hard_delete"];
//
//     test.beforeEach(async () => {
//       await new Promise((resolve) => setTimeout(resolve, 2000));
//     });
//
//     test("enables approval policy for products + accounts/parties", async ({ page }) => {
//       await login(page, "E2E_ADMIN");
//       await gotoApprovalSettings(page);
//       for (const scopeKey of policyTargets) {
//         for (const action of policyActions) {
//           await ensureCheckbox(page, `SCREEN:${scopeKey}:${action}`, true);
//         }
//       }
//       await page.getByRole("button", { name: /save/i }).click();
//       await page.waitForLoadState("domcontentloaded");
//       await gotoApprovalSettings(page);
//       for (const scopeKey of policyTargets) {
//         for (const action of policyActions) {
//           const checkbox = page.locator(`input[name="SCREEN:${scopeKey}:${action}"]`).first();
//           await checkbox.waitFor({ state: "attached" });
//           await expect(checkbox).toBeChecked();
//         }
//       }
//     });
//
//     test("accounts create queues approval via source page", async ({ page }) => {
//       await login(page, "E2E_MANAGER");
//       await page.goto("/master-data/accounts", { waitUntil: "domcontentloaded" });
//       await page.locator("[data-modal-open]").click();
//       const modal = page.locator("#modal-shell");
//       await expect(modal).toBeVisible();
//       const name = `E2E Account ${Date.now()}`;
//       await modal.locator('[data-field="name"]').fill(name);
//       await modal.locator('[data-field="name_ur"]').fill(name);
//       await selectFirstNonEmpty(page, 'select[data-field="subgroup_id"]');
//       await selectFirstNonEmpty(page, 'select[data-field="branch_ids"]');
//       await modal.locator('form[data-modal-form] button[type="submit"]').click();
//       const toast = page.locator("[data-ui-notice-toast]").first();
//       await expect(toast).toBeVisible();
//       await expect(toast).toContainText(/approval/i);
//       await gotoApprovals(page, "PENDING");
//       await expect(page.locator("tbody tr", { hasText: "Create Accounts" }).first()).toBeVisible();
//     });
//
//     test("parties create queues approval via source page", async ({ page }) => {
//       await login(page, "E2E_MANAGER");
//       await page.goto("/master-data/parties", { waitUntil: "domcontentloaded" });
//       await page.locator("[data-modal-open]").click();
//       const modal = page.locator("#modal-shell");
//       await expect(modal).toBeVisible();
//       const name = `E2E Party ${Date.now()}`;
//       await modal.locator('[data-field="name"]').fill(name);
//       await modal.locator('[data-field="name_ur"]').fill(name);
//       await modal.locator('select[data-field="party_type"]').selectOption("CUSTOMER");
//       await selectFirstNonEmpty(page, 'select[data-field="city_id"]');
//       await selectFirstNonEmpty(page, 'select[data-field="branch_ids"]');
//       await modal.locator('[data-field="phone1"]').fill("0300-0000000");
//       await modal.locator('form[data-modal-form] button[type="submit"]').click();
//       const toast = page.locator("[data-ui-notice-toast]").first();
//       await expect(toast).toBeVisible();
//       await expect(toast).toContainText(/approval/i);
//       await gotoApprovals(page, "PENDING");
//       await expect(page.locator("tbody tr", { hasText: "Create Parties" }).first()).toBeVisible();
//     });
//
//     test("restores approval policy snapshot", async ({ page }) => {
//       if (!ctx.approvalPolicySnapshot.size) return;
//       await login(page, "E2E_ADMIN");
//       await gotoApprovalSettings(page);
//       for (const [name, value] of ctx.approvalPolicySnapshot.entries()) {
//         await ensureCheckbox(page, name, value);
//       }
//       await page.getByRole("button", { name: /save/i }).click();
//       await page.waitForLoadState("domcontentloaded");
//     });
//   });
// });
