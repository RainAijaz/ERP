const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");

const db = createKnex(knexConfig);

const runtimeSupport = {
  productGroupIds: [],
  departmentIds: [],
  actorUserId: null,
};

const ts = () => Date.now();
const token = (prefix) => `${prefix}-${ts()}-${Math.floor(Math.random() * 10000)}`;

const GROUP_PAGES = [
  {
    key: "product-groups",
    title: "product_groups",
    url: "/master-data/basic-info/product-groups",
    table: "erp.product_groups",
    buildCreate: () => ({
      name: token("E2E-PG"),
      nameUr: token("ایٹوپی جی"),
      itemTypes: ["RM", "FG"],
    }),
    buildUpdate: () => ({
      name: token("E2E-PG-EDIT"),
      nameUr: token("ایٹوپی جی ایڈٹ"),
      itemTypes: ["SFG"],
    }),
    form: {
      nameField: "name",
      nameUrField: "name_ur",
      checkboxes: ["item_types"],
      primarySearchField: "name",
      requiredFields: ["name", "name_ur"],
    },
    cleanupWhere: (value) => ({ name: value }),
  },
  {
    key: "product-subgroups",
    title: "product_subgroups",
    url: "/master-data/basic-info/product-subgroups",
    table: "erp.product_subgroups",
    buildCreate: () => ({
      name: token("E2E-PSG"),
      nameUr: token("ایٹوپی ایس جی"),
      groupId: "first",
      itemTypes: ["RM"],
    }),
    buildUpdate: () => ({
      name: token("E2E-PSG-EDIT"),
      nameUr: token("ایٹوپی ایس جی ایڈٹ"),
      itemTypes: ["FG"],
    }),
    form: {
      nameField: "name",
      nameUrField: "name_ur",
      selects: ["group_id"],
      checkboxes: ["item_types"],
      primarySearchField: "name",
      requiredFields: ["name", "name_ur"],
    },
    cleanupWhere: (value) => ({ name: value }),
  },
  {
    key: "product-types",
    title: "product_types",
    url: "/master-data/basic-info/product-types",
    table: "erp.product_types",
    buildCreate: () => ({
      name: token("E2E-PT"),
      nameUr: token("ایٹوپی پی ٹی"),
    }),
    buildUpdate: () => ({
      name: token("E2E-PT-EDIT"),
      nameUr: token("ایٹوپی پی ٹی ایڈٹ"),
    }),
    form: {
      nameField: "name",
      nameUrField: "name_ur",
      primarySearchField: "name",
      requiredFields: ["name", "name_ur"],
      hasReadonlyCodeOnEdit: true,
    },
    cleanupWhere: (value) => ({ name: value }),
  },
  {
    key: "sales-discount-policies",
    title: "sales_discount_policies",
    url: "/master-data/basic-info/sales-discount-policies",
    table: "erp.sales_discount_policy",
    buildCreate: () => ({
      productGroupId: "first",
      maxPairDiscount: "1",
    }),
    buildUpdate: () => ({
      maxPairDiscount: "2",
    }),
    form: {
      selects: ["product_group_id"],
      numberFields: ["max_pair_discount"],
      primarySearchField: "max_pair_discount",
      requiredFields: ["product_group_id", "max_pair_discount"],
    },
    cleanupWhere: (value) => ({ max_pair_discount: Number(value) }),
  },
  {
    key: "party-groups",
    title: "party_groups",
    url: "/master-data/basic-info/party-groups",
    table: "erp.party_groups",
    buildCreate: () => ({
      partyType: "CUSTOMER",
      name: token("E2E-PARTY"),
      nameUr: token("ایٹوپی پارٹی"),
    }),
    buildUpdate: () => ({
      partyType: "SUPPLIER",
      name: token("E2E-PARTY-EDIT"),
      nameUr: token("ایٹوپی پارٹی ایڈٹ"),
    }),
    form: {
      selects: ["party_type"],
      nameField: "name",
      nameUrField: "name_ur",
      primarySearchField: "name",
      requiredFields: ["party_type", "name", "name_ur"],
      expectedSelectOptions: {
        party_type: ["CUSTOMER", "SUPPLIER", "BOTH"],
      },
    },
    cleanupWhere: (value) => ({ name: value }),
  },
  {
    key: "account-groups",
    title: "account_groups",
    url: "/master-data/basic-info/account-groups",
    table: "erp.account_groups",
    buildCreate: () => ({
      accountType: "ASSET",
      name: token("E2E-AG"),
      nameUr: token("ایٹوپی اے جی"),
      isContra: false,
    }),
    buildUpdate: () => ({
      accountType: "LIABILITY",
      name: token("E2E-AG-EDIT"),
      nameUr: token("ایٹوپی اے جی ایڈٹ"),
      isContra: true,
    }),
    form: {
      selects: ["account_type"],
      nameField: "name",
      nameUrField: "name_ur",
      singleCheckboxes: ["is_contra"],
      primarySearchField: "name",
      requiredFields: ["account_type", "name", "name_ur"],
      expectedSelectOptions: {
        account_type: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"],
      },
    },
    cleanupWhere: (value) => ({ name: value }),
  },
  {
    key: "departments",
    title: "departments",
    url: "/master-data/basic-info/departments",
    table: "erp.departments",
    buildCreate: () => ({
      name: token("E2E-DEPT"),
      nameUr: token("ایٹوپی ڈیپارٹمنٹ"),
      isProduction: true,
    }),
    buildUpdate: () => ({
      name: token("E2E-DEPT-EDIT"),
      nameUr: token("ایٹوپی ڈیپارٹمنٹ ایڈٹ"),
      isProduction: false,
    }),
    form: {
      nameField: "name",
      nameUrField: "name_ur",
      singleCheckboxes: ["is_production"],
      primarySearchField: "name",
      requiredFields: ["name", "name_ur"],
    },
    cleanupWhere: (value) => ({ name: value }),
  },
  {
    key: "production-stages",
    title: "production_stages",
    url: "/master-data/basic-info/production-stages",
    table: "erp.production_stages",
    buildCreate: () => ({
      name: token("E2E-STAGE"),
      nameUr: token("ایٹوپی اسٹیج"),
      deptId: "firstProduction",
      isActive: true,
    }),
    buildUpdate: () => ({
      name: token("E2E-STAGE-EDIT"),
      nameUr: token("ایٹوپی اسٹیج ایڈٹ"),
      isActive: false,
    }),
    form: {
      nameField: "name",
      nameUrField: "name_ur",
      selects: ["dept_id"],
      singleCheckboxes: ["is_active"],
      primarySearchField: "name",
      requiredFields: ["name", "dept_id"],
      deptShouldOnlyIncludeProduction: true,
    },
    cleanupWhere: (value) => ({ name: value }),
  },
];

const getHeading = (page) => page.locator("h1").first();
const getAddButton = (page) => page.locator("[data-modal-open]").first();
const getModal = (page) => page.locator("[data-modal]");
const getModalForm = (page) => page.locator("[data-modal-form]");
const getModalClose = (page) => page.locator("[data-modal-close]").first();
const getConfirmModal = (page) => page.locator("[data-confirm-modal]");
const getConfirmContinue = (page) => page.locator("[data-confirm-form] button[type='submit']").first();
const getUiErrorModal = (page) => page.locator("[data-ui-error-modal]");

async function selectFirstNonEmpty(select) {
  return selectNonEmptyByIndex(select, 0);
}

async function selectNonEmptyByIndex(select, index = 0) {
  const values = await select.locator("option").evaluateAll((opts) =>
    opts
      .map((opt) => String(opt.value || "").trim())
      .filter((v) => v.length > 0),
  );
  if (!values.length) return null;
  const safeIndex = Math.max(0, Math.min(index, values.length - 1));
  const value = values[safeIndex];
  await select.evaluate(
    (el, val) => {
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    value,
  );
  return value;
}

async function fillCoreForm(page, cfg, payload) {
  const form = getModalForm(page);
  await expect(form).toBeVisible();

  if (cfg.form.nameField && Object.prototype.hasOwnProperty.call(payload, "name")) {
    await form.locator(`[data-field='${cfg.form.nameField}']`).fill(String(payload.name || ""));
  }
  if (cfg.form.nameUrField && Object.prototype.hasOwnProperty.call(payload, "nameUr")) {
    await form.locator(`[data-field='${cfg.form.nameUrField}']`).fill(String(payload.nameUr || ""));
  }

  if (cfg.form.selects?.length) {
    for (const field of cfg.form.selects) {
      const select = form.locator(`select[data-field='${field}']`).first();
      if (!(await select.count())) continue;
      const hasExplicitValue = Object.prototype.hasOwnProperty.call(payload, field)
        || Object.prototype.hasOwnProperty.call(payload, camel(field));
      if (!hasExplicitValue) continue;

      const value = payload[field] ?? payload[camel(field)] ?? null;
      if (typeof value === "string" && value.length && value !== "first" && value !== "firstProduction") {
        if (value === "second") {
          await selectNonEmptyByIndex(select, 1);
          continue;
        }
        if (value === "third") {
          await selectNonEmptyByIndex(select, 2);
          continue;
        }
        await select.evaluate(
          (el, val) => {
            el.value = val;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          },
          value,
        );
        const selectedAfterSet = String(await select.inputValue()).trim();
        if (!selectedAfterSet) {
          await selectFirstNonEmpty(select);
        }
      } else {
        await selectFirstNonEmpty(select);
      }
    }
  }

  if (cfg.form.checkboxes?.length) {
    for (const field of cfg.form.checkboxes) {
      const wanted = payload[field] || payload[camel(field)] || [];
      const targets = Array.isArray(wanted) ? wanted : [wanted];
      const boxes = form.locator(`input[type='checkbox'][data-field='${field}'][data-multi='true']`);
      const count = await boxes.count();
      for (let i = 0; i < count; i += 1) {
        const box = boxes.nth(i);
        const value = await box.inputValue();
        if (targets.includes(value)) {
          if (!(await box.isChecked())) await box.check();
        } else if (await box.isChecked()) {
          await box.uncheck();
        }
      }
    }
  }

  if (cfg.form.singleCheckboxes?.length) {
    for (const field of cfg.form.singleCheckboxes) {
      const hasExplicitValue = Object.prototype.hasOwnProperty.call(payload, field)
        || Object.prototype.hasOwnProperty.call(payload, camel(field));
      if (!hasExplicitValue) continue;

      const wanted = Boolean(payload[field] ?? payload[camel(field)]);
      const box = form.locator(`input[type='checkbox'][data-field='${field}']`).first();
      if (!(await box.count())) continue;
      const checked = await box.isChecked();
      if (wanted !== checked) {
        if (wanted) await box.check();
        else await box.uncheck();
      }
    }
  }

  if (cfg.form.numberFields?.length) {
    for (const field of cfg.form.numberFields) {
      const val = payload[field] ?? payload[camel(field)];
      if (val === undefined) continue;
      await form.locator(`[data-field='${field}']`).fill(String(val));
    }
  }
}

function camel(s) {
  return String(s).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

async function ensureModalClosed(page) {
  const modal = getModal(page);
  const visible = await modal.isVisible().catch(() => false);
  if (!visible) return;
  const closeBtn = getModalClose(page);
  if (await closeBtn.count()) {
    await closeBtn.click();
    await expect(modal).toBeHidden();
    return;
  }
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
}

async function submitModal(page) {
  const modal = getModal(page);
  const form = getModalForm(page);
  await form.locator("button[type='submit']").click();
  await page.waitForTimeout(250);

  const stillOpen = await modal.isVisible().catch(() => false);
  if (stillOpen) {
    const invalidCount = await form.evaluate((f) => f.querySelectorAll(":invalid").length);
    if (invalidCount > 0) {
      throw new Error(`Blocked by HTML validation (${invalidCount} invalid field(s)).`);
    }
    const modalError = form.locator("[data-modal-error]").first();
    const hasModalError = await modalError.isVisible().catch(() => false);
    if (hasModalError) {
      const text = ((await modalError.textContent()) || "").trim();
      if (text) {
        throw new Error(`Server validation error: ${text}`);
      }
    }
    throw new Error("Modal remained open after submit without navigation.");
  }

  await page.waitForLoadState("domcontentloaded");
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

async function findRowByText(page, value, { visibleOnly = false } = {}) {
  const needle = normalizeText(value);
  if (!needle) return null;

  const rows = page.locator("[data-table-body] tr[data-row]");
  const count = await rows.count();
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    if (visibleOnly) {
      const hidden = await row.evaluate((el) => el.classList.contains("hidden")).catch(() => false);
      if (hidden) continue;
      const visible = await row.isVisible().catch(() => false);
      if (!visible) continue;
    }
    const text = normalizeText((await row.textContent()) || "");
    if (text.includes(needle)) return row;
  }
  return null;
}

async function waitForRowByText(page, value, { visibleOnly = true, shouldExist = true, timeout = 5000 } = {}) {
  const start = Date.now();
  let lastVisibleRows = [];

  while (Date.now() - start < timeout) {
    const found = Boolean(await findRowByText(page, value, { visibleOnly }));
    if (found === shouldExist) return;

    const rowLocator = page.locator("[data-table-body] tr[data-row]");
    const count = await rowLocator.count();
    const texts = [];
    for (let i = 0; i < count; i += 1) {
      const row = rowLocator.nth(i);
      if (visibleOnly) {
        const hidden = await row.evaluate((el) => el.classList.contains("hidden")).catch(() => false);
        if (hidden) continue;
        const visible = await row.isVisible().catch(() => false);
        if (!visible) continue;
      }
      texts.push(normalizeText((await row.textContent()) || ""));
    }
    lastVisibleRows = texts;
    await page.waitForTimeout(150);
  }

  throw new Error(
    `Row presence timeout for "${value}" (expected ${shouldExist}). Visible rows: ${lastVisibleRows.join(" || ")}`,
  );
}

async function extractRowRecordId(row) {
  const actionAttrs = ["data-toggle-action", "data-edit-action", "data-delete-action"];
  for (const selector of ["[data-toggle]", "[data-edit]", "[data-delete]"]) {
    const btn = row.locator(selector).first();
    if (!(await btn.count())) continue;
    for (const attr of actionAttrs) {
      const raw = String((await btn.getAttribute(attr)) || "");
      const m = raw.match(/\/(\d+)(?:\/|$)/);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

async function findRowByRecordId(page, recordId, { visibleOnly = false } = {}) {
  if (!Number.isInteger(recordId) || recordId <= 0) return null;
  const rows = page.locator("[data-table-body] tr[data-row]");
  const count = await rows.count();
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    if (visibleOnly) {
      const hidden = await row.evaluate((el) => el.classList.contains("hidden")).catch(() => false);
      if (hidden) continue;
      const visible = await row.isVisible().catch(() => false);
      if (!visible) continue;
    }
    const id = await extractRowRecordId(row);
    if (id === recordId) return row;
  }
  return null;
}

async function waitForRowByRecordId(page, recordId, { visibleOnly = true, shouldExist = true, timeout = 5000 } = {}) {
  await expect
    .poll(async () => Boolean(await findRowByRecordId(page, recordId, { visibleOnly })), {
      timeout,
    })
    .toBe(shouldExist);
}

async function resolveExistingRowKey(page, candidates, { visibleOnly = true } = {}) {
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (!value) continue;
    const row = await findRowByText(page, value, { visibleOnly });
    if (row) return value;
  }
  return null;
}

async function openEditForRow(row) {
  const edit = row.locator("[data-edit]").first();
  await expect(edit).toBeVisible();
  await edit.click();
}

async function toggleRow(row) {
  const btn = row.locator("[data-toggle]").first();
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(getConfirmModal(row.page())).toBeVisible();
  await getConfirmContinue(row.page()).click();
  await row.page().waitForLoadState("domcontentloaded");
}

async function deleteRowHard(page, row) {
  const btn = row.locator("[data-delete]").first();
  if (!(await btn.count())) return false;
  await btn.click();
  await expect(getConfirmModal(page)).toBeVisible();
  await getConfirmContinue(page).click();
  await page.waitForLoadState("domcontentloaded");
  return true;
}

async function ensureNoUiErrorModal(page) {
  const modal = getUiErrorModal(page);
  if (await modal.isVisible().catch(() => false)) {
    const text = await modal.textContent();
    throw new Error(`Unexpected UI error modal: ${text || ""}`);
  }
}

async function getActorUserId() {
  if (Number.isInteger(runtimeSupport.actorUserId) && runtimeSupport.actorUserId > 0) {
    return runtimeSupport.actorUserId;
  }
  const row = await db("erp.users").select("id").orderBy("id", "asc").first();
  runtimeSupport.actorUserId = Number(row?.id || 1);
  return runtimeSupport.actorUserId;
}

async function createSupportProductGroup() {
  const actorUserId = await getActorUserId();
  const name = token("E2E-POLICY-GROUP");
  const nameUr = token("ایٹوپی پالیسی گروپ");
  const [inserted] = await db("erp.product_groups")
    .insert({
      name,
      name_ur: nameUr,
      is_active: true,
      created_by: actorUserId,
    })
    .returning(["id"]);
  const id = Number(inserted?.id || inserted || 0);
  if (id > 0) {
    runtimeSupport.productGroupIds.push(id);
    await db("erp.product_group_item_types").insert([
      { group_id: id, item_type: "RM" },
      { group_id: id, item_type: "SFG" },
      { group_id: id, item_type: "FG" },
    ]);
  }
  return id;
}

async function ensureAvailableDiscountPolicyGroups(required = 2) {
  const groups = await db("erp.product_groups")
    .select("id")
    .where({ is_active: true })
    .orderBy("id", "asc");
  const usedRows = await db("erp.sales_discount_policy").select("product_group_id");
  const usedSet = new Set(usedRows.map((row) => Number(row.product_group_id)).filter((id) => id > 0));

  const available = groups
    .map((row) => Number(row.id))
    .filter((id) => id > 0 && !usedSet.has(id));

  while (available.length < required) {
    const id = await createSupportProductGroup();
    if (id > 0) available.push(id);
    else break;
  }

  return available.slice(0, required);
}

async function createSupportProductionDepartment() {
  const actorUserId = await getActorUserId();
  const name = token("E2E-STAGE-DEPT");
  const nameUr = token("ایٹوپی اسٹیج ڈیپارٹمنٹ");
  const [inserted] = await db("erp.departments")
    .insert({
      name,
      name_ur: nameUr,
      is_active: true,
      is_production: true,
      created_by: actorUserId,
    })
    .returning(["id"]);
  const id = Number(inserted?.id || inserted || 0);
  if (id > 0) runtimeSupport.departmentIds.push(id);
  return id;
}

async function ensureDepartmentsWithoutStage(required = 1) {
  const departments = await db("erp.departments")
    .select("id")
    .where({ is_active: true, is_production: true })
    .orderBy("id", "asc");
  const existingStages = await db("erp.production_stages")
    .select("dept_id")
    .whereNotNull("dept_id");
  const occupiedDeptSet = new Set(existingStages.map((row) => Number(row.dept_id)).filter((id) => id > 0));

  const available = departments
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0 && !occupiedDeptSet.has(id));

  while (available.length < required) {
    const id = await createSupportProductionDepartment();
    if (id > 0) available.push(id);
    else break;
  }

  return available.slice(0, required);
}

test.describe("Basic Info Groups pages - CRUD and relevance scenarios", () => {
  test.afterAll(async () => {
    if (runtimeSupport.productGroupIds.length) {
      await db("erp.sales_discount_policy").whereIn("product_group_id", runtimeSupport.productGroupIds).del();
      await db("erp.product_group_item_types").whereIn("group_id", runtimeSupport.productGroupIds).del();
      await db("erp.product_groups").whereIn("id", runtimeSupport.productGroupIds).del();
    }
    if (runtimeSupport.departmentIds.length) {
      await db("erp.production_stages").whereIn("dept_id", runtimeSupport.departmentIds).del();
      await db("erp.departments").whereIn("id", runtimeSupport.departmentIds).del();
    }
    await db.destroy();
  });

  for (const cfg of GROUP_PAGES) {
    test(`${cfg.key}: 20 scenario coverage`, async ({ page }) => {
      await login(page, "E2E_ADMIN");

      const preloaded = {
        availableGroups: null,
        groupNameA: "",
        groupNameB: "",
        freeDeptIds: null,
      };

      if (cfg.key === "sales-discount-policies") {
        preloaded.availableGroups = await ensureAvailableDiscountPolicyGroups(2);
        test.skip(
          !Array.isArray(preloaded.availableGroups) || preloaded.availableGroups.length < 2,
          "Need at least two available product groups for unique policy scenarios.",
        );
        const groupRows = await db("erp.product_groups")
          .select("id", "name")
          .whereIn("id", preloaded.availableGroups);
        const byId = new Map(groupRows.map((row) => [Number(row.id), String(row.name || "")]));
        preloaded.groupNameA = byId.get(Number(preloaded.availableGroups[0])) || "";
        preloaded.groupNameB = byId.get(Number(preloaded.availableGroups[1])) || "";
      }

      if (cfg.key === "production-stages") {
        preloaded.freeDeptIds = await ensureDepartmentsWithoutStage(2);
        test.skip(
          !Array.isArray(preloaded.freeDeptIds) || preloaded.freeDeptIds.length < 2,
          "Need two production departments without existing stages for create scenarios.",
        );
      }

      // 1 page loads
      const response = await page.goto(cfg.url, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);

      // 2 add visible
      await expect(getAddButton(page)).toBeVisible();

      // 3 download/print visible
      await expect(page.locator("[data-download-button]")).toBeVisible();
      await expect(page.locator("[data-print-button]")).toBeVisible();

      // 4 modal opens
      await getAddButton(page).click();
      await expect(getModal(page)).toBeVisible();

      // 5 modal closes
      await getModalClose(page).click();
      await expect(getModal(page)).toBeHidden();

      // 6 required submit blocked
      await getAddButton(page).click();
      const form = getModalForm(page);
      await form.locator("button[type='submit']").click();
      const invalidCount = await form.evaluate((f) => f.querySelectorAll(":invalid").length);
      expect(invalidCount).toBeGreaterThan(0);
      await getModalClose(page).click();

      // 7 relevant controls render
      await getAddButton(page).click();
      if (cfg.form.nameField) await expect(form.locator(`[data-field='${cfg.form.nameField}']`)).toBeVisible();
      if (cfg.form.nameUrField) await expect(form.locator(`[data-field='${cfg.form.nameUrField}']`)).toBeVisible();
      for (const s of cfg.form.selects || []) await expect(form.locator(`[data-field='${s}']`)).toBeVisible();
      for (const c of cfg.form.checkboxes || []) await expect(form.locator(`[data-field='${c}'][data-multi='true']`).first()).toBeVisible();
      for (const c of cfg.form.singleCheckboxes || []) await expect(form.locator(`[data-field='${c}']`)).toBeVisible();
      await getModalClose(page).click();

      const createA = cfg.buildCreate();
      const createB = cfg.buildCreate();
      const updateA = cfg.buildUpdate();

      if (cfg.key === "sales-discount-policies") {
        createA.product_group_id = String(preloaded.availableGroups[0]);
        createB.product_group_id = String(preloaded.availableGroups[1]);
        createA.max_pair_discount = "1";
        createB.max_pair_discount = "2";
        updateA.product_group_id = String(preloaded.availableGroups[0]);
        updateA.max_pair_discount = "3";
      }

      if (cfg.key === "production-stages") {
        createA.dept_id = String(preloaded.freeDeptIds[0]);
        createB.dept_id = String(preloaded.freeDeptIds[1]);
        createA.is_active = true;
        createB.isActive = false;
      }

      // 8 create A
      await ensureModalClosed(page);
      await getAddButton(page).click();
      await fillCoreForm(page, cfg, createA);
      await submitModal(page);
      await ensureNoUiErrorModal(page);

      // 9 create B
      await ensureModalClosed(page);
      await getAddButton(page).click();
      await fillCoreForm(page, cfg, createB);
      await submitModal(page);
      await ensureNoUiErrorModal(page);

      const searchInput = page.locator("[data-search-input]");

      // 10 edit prefill A
      const rowKeyA = cfg.key === "sales-discount-policies"
        ? preloaded.groupNameA
        : (createA.name || "");
      if (rowKeyA) {
        await searchInput.fill(rowKeyA);
        const rowAForEdit = await findRowByText(page, rowKeyA);
        expect(rowAForEdit).toBeTruthy();
        await openEditForRow(rowAForEdit);
        if (cfg.form.nameField) {
          await expect(form.locator(`[data-field='${cfg.form.nameField}']`)).toHaveValue(createA.name);
        }
      } else {
        await expect(page.locator("[data-edit]").first()).toBeVisible();
        await page.locator("[data-edit]").first().click();
      }

      // 11 edit save A
      await fillCoreForm(page, cfg, updateA);
      await submitModal(page);
      await ensureNoUiErrorModal(page);

      // 12 search hit
      if (updateA.name) {
        await searchInput.fill(updateA.name);
        const hitRow = await findRowByText(page, updateA.name);
        expect(hitRow).toBeTruthy();
      }

      // 13 search miss
      await searchInput.fill("__NO_MATCH__");
      const visibleRowsAfterMiss = await page.locator("[data-table-body] tr[data-row]:not(.hidden)").count();
      expect(visibleRowsAfterMiss).toBe(0);

      // reset search
      await searchInput.fill("");

      // locate row for lifecycle actions (toggle/filter/reactivate)
      const editedKey = updateA.name || createA.name || preloaded.groupNameA || "";
      const lifecycleCandidates = cfg.key === "sales-discount-policies"
        ? [preloaded.groupNameA, createA.name]
        : [updateA.name, createA.name, preloaded.groupNameA];
      const lifecycleKey = await resolveExistingRowKey(page, lifecycleCandidates, { visibleOnly: true });

      let rowA = lifecycleKey ? await findRowByText(page, lifecycleKey, { visibleOnly: true }) : null;
      expect(rowA).toBeTruthy();

      // 14 toggle deactivate
      await rowA.locator("[data-toggle]").first().click();
      await expect(getConfirmModal(page)).toBeVisible();
      await getConfirmContinue(page).click();
      await page.waitForLoadState("domcontentloaded");

      // 15 inactive filter shows row
      await page.locator("[data-status-filter]").selectOption("inactive");
      await page.waitForTimeout(50);
      const visibleRows = page.locator("[data-table-body] tr[data-row]:not(.hidden)");
      await expect(visibleRows.first()).toBeVisible();
      if (lifecycleKey) {
        rowA = await findRowByText(page, lifecycleKey, { visibleOnly: true });
      }

      // 16 active filter hides row
      await page.locator("[data-status-filter]").selectOption("active");
      await page.waitForTimeout(50);
      await expect(page.locator("[data-status-filter]")).toHaveValue("active");

      // 17 toggle reactivate
      await page.locator("[data-status-filter]").selectOption("inactive");
      await page.waitForTimeout(50);
      await expect(visibleRows.first()).toBeVisible();
      const rowAInactive = (lifecycleKey && (await findRowByText(page, lifecycleKey, { visibleOnly: true })))
        || visibleRows.first();
      expect(rowAInactive).toBeTruthy();
      await rowAInactive.locator("[data-toggle]").first().click();
      await expect(getConfirmModal(page)).toBeVisible();
      await getConfirmContinue(page).click();
      await page.waitForLoadState("domcontentloaded");
      await page.locator("[data-status-filter]").selectOption("all");

      // 18 page relevance checks
      if (cfg.form.expectedSelectOptions) {
        await getAddButton(page).click();
        for (const [field, values] of Object.entries(cfg.form.expectedSelectOptions)) {
          const options = await form.locator(`select[data-field='${field}'] option`).evaluateAll((opts) =>
            opts.map((opt) => String(opt.value || "").trim()).filter((v) => v.length > 0),
          );
          for (const requiredValue of values) {
            expect(options).toContain(requiredValue);
          }
        }
        await getModalClose(page).click();
      } else if (cfg.form.deptShouldOnlyIncludeProduction) {
        await getAddButton(page).click();
        const deptOptions = await form
          .locator("select[data-field='dept_id'] option")
          .evaluateAll((opts) => opts.map((o) => ({ value: String(o.value || ""), label: String(o.textContent || "") })));
        const nonEmptyDeptValues = deptOptions.filter((o) => o.value.trim().length > 0);
        expect(nonEmptyDeptValues.length).toBeGreaterThan(0);
        const deptIds = nonEmptyDeptValues.map((o) => Number(o.value)).filter((id) => Number.isInteger(id) && id > 0);
        const dbDeptRows = deptIds.length
          ? await db("erp.departments").select("id", "is_active", "is_production").whereIn("id", deptIds)
          : [];
        expect(dbDeptRows.length).toBe(deptIds.length);
        for (const dep of dbDeptRows) {
          expect(Boolean(dep.is_active)).toBeTruthy();
          expect(Boolean(dep.is_production)).toBeTruthy();
        }
        await getModalClose(page).click();
      } else if (cfg.form.hasReadonlyCodeOnEdit) {
        if (editedKey) {
          await searchInput.fill(editedKey);
        }
        const rowForCode = editedKey ? await findRowByText(page, editedKey) : page.locator("[data-row]").first();
        expect(rowForCode).toBeTruthy();
        await openEditForRow(rowForCode);
        const codeField = form.locator("[data-field='code']").first();
        await expect(codeField).toBeVisible();
        await expect(codeField).toBeDisabled();
        await getModalClose(page).click();
      } else {
        if (editedKey) {
          await searchInput.fill(editedKey);
          const rowForRel = await findRowByText(page, editedKey);
          expect(rowForRel).toBeTruthy();
        }
      }

      // 19 hard delete B
      const bKey = cfg.key === "sales-discount-policies"
        ? (preloaded.groupNameB || "")
        : (createB.name || createB.maxPairDiscount || "");
      if (bKey) {
        await searchInput.fill(String(bKey));
      }
      let rowB = bKey ? await findRowByText(page, String(bKey)) : null;
      expect(rowB).toBeTruthy();
      const hasDeleteB = await rowB.locator("[data-delete]").first().count();
      if (hasDeleteB) {
        await rowB.locator("[data-delete]").first().click();
        await expect(getConfirmModal(page)).toBeVisible();
        await getConfirmContinue(page).click();
        await page.waitForLoadState("domcontentloaded");
      } else {
        test.skip(true, `${cfg.key}: hard_delete permission/button unavailable for this user`);
      }

      // 20 hard delete A
      const aKey = lifecycleKey || editedKey;
      if (aKey) {
        await searchInput.fill(String(aKey));
      }
      let rowAFinal = aKey ? await findRowByText(page, String(aKey), { visibleOnly: true }) : null;
      expect(rowAFinal).toBeTruthy();
      const hasDeleteA = await rowAFinal.locator("[data-delete]").first().count();
      if (hasDeleteA) {
        await rowAFinal.locator("[data-delete]").first().click();
        await expect(getConfirmModal(page)).toBeVisible();
        await getConfirmContinue(page).click();
        await page.waitForLoadState("domcontentloaded");
      }

      await ensureNoUiErrorModal(page);
    });
  }
});
