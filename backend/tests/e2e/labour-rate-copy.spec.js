const { test, expect } = require("@playwright/test");
const createKnex = require("knex");
const knexConfig = require("../../knexfile").development;
const { login } = require("./utils/auth");
const copyService = require("../../src/services/hr-payroll/labour-rate-copy-service");
const { applyMasterDataChange } = require("../../src/utils/approval-applier");

const RATES_PATH = "/hr-payroll/labours/rates";
const TAG = `lrcopy${Date.now().toString(36)}`;

const db = createKnex(knexConfig);

const ctx = {
  deptId: null,
  groupId: null,
  skuIds: [],
  sourceId: null,
  targetAId: null,
  targetBId: null,
  blockedId: null,
  labourIds: [],
};

const createLabour = async (name, deptId, { assign = true } = {}) => {
  const [row] = await db("erp.labours")
    .insert({
      name,
      code: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      status: "active",
      dept_id: assign ? deptId : null,
    })
    .returning("id");
  const id = Number(row.id || row);
  if (assign) {
    await db("erp.labour_department")
      .insert({ labour_id: id, dept_id: deptId })
      .onConflict()
      .ignore();
  }
  ctx.labourIds.push(id);
  return id;
};

const rateRows = (labourId) =>
  db("erp.labour_rate_rules")
    .where({ labour_id: labourId, dept_id: ctx.deptId })
    .orderBy("sku_id", "asc")
    .select("sku_id", "rate_value", "rate_type", "apply_on", "status");

const openModal = async (page) => {
  await page.goto(RATES_PATH, { waitUntil: "domcontentloaded" });
  await page.locator("[data-lrc-open]").click();
  await expect(page.locator("[data-lrc-modal]")).toBeVisible();
};

const selectScope = async (page, targetIds) => {
  await page.locator("[data-lrc-source]").selectOption(String(ctx.sourceId));
  await expect(page.locator("[data-lrc-dept]")).toBeEnabled();
  await page.locator("[data-lrc-dept]").selectOption(String(ctx.deptId));
  await page
    .locator("[data-lrc-targets]")
    .selectOption(targetIds.map((id) => String(id)));
  // Summary switches from the prompt to the "{n} articles → ..." line.
  await expect(page.locator("[data-lrc-summary]")).toContainText(/\d/, {
    timeout: 10000,
  });
};

const copyNow = async (page, mode) => {
  if (mode === "OVERWRITE") {
    await page.locator('[data-lrc-conflict][value="OVERWRITE"]').check();
  }
  const applyBtn = page.locator("[data-lrc-apply]");
  await expect(applyBtn).toBeEnabled();
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes("/rates/copy") && res.request().method() === "POST",
    ),
    applyBtn.click(),
  ]);
  await expect(page.locator('[data-lrc-step="result"]')).toBeVisible();
  return response;
};

test.describe("Labour rates — copy from another labour", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const dept = await db("erp.departments")
      .where({ is_active: true, is_production: true })
      .orderBy("id", "asc")
      .first("id");
    if (!dept) test.skip(true, "No active production department available");
    ctx.deptId = Number(dept.id);

    // Three real FG/SFG skus that share a group, so the group filter is testable.
    const skus = await db("erp.skus as s")
      .join("erp.variants as v", "v.id", "s.variant_id")
      .join("erp.items as i", "i.id", "v.item_id")
      .where({ "s.is_active": true, "i.is_active": true })
      .whereIn("i.item_type", ["FG", "SFG"])
      .whereNotNull("i.group_id")
      .orderBy("s.id", "asc")
      .limit(3)
      .select("s.id", "i.group_id");
    if (skus.length < 3) test.skip(true, "Need at least 3 active SKUs");
    ctx.skuIds = skus.map((row) => Number(row.id));
    ctx.groupId = Number(skus[0].group_id);

    ctx.sourceId = await createLabour(`${TAG} SOURCE`, ctx.deptId);
    ctx.targetAId = await createLabour(`${TAG} TARGET A`, ctx.deptId);
    ctx.targetBId = await createLabour(`${TAG} TARGET B`, ctx.deptId);
    ctx.blockedId = await createLabour(`${TAG} BLOCKED`, ctx.deptId, {
      assign: false,
    });

    const base = {
      applies_to_all_labours: false,
      dept_id: ctx.deptId,
      apply_on: "SKU",
      rate_type: "PER_DOZEN",
      status: "active",
    };
    await db("erp.labour_rate_rules").insert([
      { ...base, labour_id: ctx.sourceId, sku_id: ctx.skuIds[0], rate_value: 10 },
      { ...base, labour_id: ctx.sourceId, sku_id: ctx.skuIds[1], rate_value: 20 },
      { ...base, labour_id: ctx.sourceId, sku_id: ctx.skuIds[2], rate_value: 30 },
      // Scope-wide fallback: has no sku_id, so it can never be copied.
      {
        ...base,
        labour_id: ctx.sourceId,
        apply_on: "GROUP",
        sku_id: null,
        group_id: ctx.groupId,
        rate_value: 5,
      },
      // Target B already holds a DIFFERENT rate on the first sku -> CONFLICT.
      { ...base, labour_id: ctx.targetBId, sku_id: ctx.skuIds[0], rate_value: 99 },
    ]);
  });

  test.afterAll(async () => {
    if (ctx.labourIds.length) {
      await db("erp.labour_rate_rules")
        .whereIn("labour_id", ctx.labourIds)
        .del();
      await db("erp.labour_department")
        .whereIn("labour_id", ctx.labourIds)
        .del();
      await db("erp.labours").whereIn("id", ctx.labourIds).del();
    }
    await db.destroy();
  });

  test("preview reports states, blocked targets and uncopyable scope-wide rules", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await openModal(page);
    await selectScope(page, [ctx.targetAId, ctx.targetBId, ctx.blockedId]);

    // 3 sku-pinned articles; the GROUP fallback is not among them.
    await expect(page.locator("[data-lrc-tbody] tr")).toHaveCount(3);

    // The unassigned labour cannot receive the copy and is named as blocked.
    const blocked = page.locator("[data-lrc-blocked]");
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText(`${TAG} BLOCKED`);

    // The scope-wide rule is surfaced, not silently dropped.
    await expect(page.locator("[data-lrc-notes]")).toContainText("1");

    // Target B already has a different rate on sku 1 -> conflict controls show.
    await expect(page.locator("[data-lrc-conflict-wrap]")).toBeVisible();

    // 3 articles x 2 eligible targets = 6 cells, of which 1 is a conflict that
    // SKIP excludes -> 5 writes.
    await expect(page.locator("[data-lrc-summary]")).toContainText("5");
  });

  test("narrowing filters does not hit the network", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await openModal(page);
    // Target B carries the conflicting rate, so the conflict toggle is present.
    await selectScope(page, [ctx.targetAId, ctx.targetBId]);
    await expect(page.locator("[data-lrc-tbody] tr")).toHaveCount(3);

    let previewCalls = 0;
    page.on("request", (request) => {
      if (request.url().includes("/rates/copy-preview")) previewCalls += 1;
    });

    await page.locator("[data-lrc-filters-toggle]").click();
    await page
      .locator("[data-lrc-articles]")
      .selectOption([String(ctx.skuIds[0])]);
    await expect(page.locator("[data-lrc-tbody] tr")).toHaveCount(1);

    // Toggling the conflict mode is also a pure re-render.
    await page.locator('[data-lrc-conflict][value="OVERWRITE"]').check();
    await page.waitForTimeout(600);
    expect(previewCalls).toBe(0);
  });

  test("SKIP copies new rates and leaves an existing different rate alone", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await openModal(page);
    await selectScope(page, [ctx.targetAId, ctx.targetBId]);
    const response = await copyNow(page, "SKIP");
    expect(response.status()).toBe(200);

    const aRows = await rateRows(ctx.targetAId);
    expect(aRows.map((row) => Number(row.rate_value))).toEqual([10, 20, 30]);
    // Copies are written article-pinned regardless of the source's apply_on.
    aRows.forEach((row) => expect(row.apply_on).toBe("SKU"));

    const bRows = await rateRows(ctx.targetBId);
    expect(bRows).toHaveLength(3);
    const bFirst = bRows.find((row) => Number(row.sku_id) === ctx.skuIds[0]);
    expect(Number(bFirst.rate_value)).toBe(99); // untouched by SKIP
  });

  test("OVERWRITE replaces the differing rate", async ({ page }) => {
    await login(page, "E2E_ADMIN");
    await openModal(page);
    await selectScope(page, [ctx.targetBId]);
    const response = await copyNow(page, "OVERWRITE");
    expect(response.status()).toBe(200);

    const bRows = await rateRows(ctx.targetBId);
    const bFirst = bRows.find((row) => Number(row.sku_id) === ctx.skuIds[0]);
    expect(Number(bFirst.rate_value)).toBe(10);
    expect(bRows).toHaveLength(3);
  });

  test("re-copying is idempotent — no duplicate rows", async ({ page }) => {
    const before = await rateRows(ctx.targetAId);
    await login(page, "E2E_ADMIN");
    await openModal(page);
    await selectScope(page, [ctx.targetAId]);

    // Everything is identical now, so there is nothing left to write.
    await expect(page.locator("[data-lrc-apply]")).toBeDisabled();

    const after = await rateRows(ctx.targetAId);
    expect(after).toHaveLength(before.length);
  });

  test("mixed rate types create one approval/write batch per rate type", async ({
    page,
  }) => {
    const targetId = await createLabour(`${TAG} TARGET MIXED`, ctx.deptId);
    // A labour can hold only one rule per (dept, sku) — the unique index
    // enforces it — so flip one existing rule to PER_PAIR rather than adding a
    // second rule for the same article.
    await db("erp.labour_rate_rules")
      .where({
        labour_id: ctx.sourceId,
        dept_id: ctx.deptId,
        sku_id: ctx.skuIds[1],
      })
      .update({ rate_type: "PER_PAIR", rate_value: 7 });

    await login(page, "E2E_ADMIN");
    await openModal(page);
    await selectScope(page, [targetId]);

    // The UI warns that this will split into more than one request.
    await expect(page.locator("[data-lrc-notes]")).toBeVisible();

    const response = await copyNow(page, "SKIP");
    const payload = await response.json();
    const rateTypes = payload.requests.map((entry) => entry.rate_type).sort();
    expect(rateTypes).toEqual(["PER_DOZEN", "PER_PAIR"]);

    // Each rate is written under its own type — never converted.
    const rows = await rateRows(targetId);
    const byType = Object.fromEntries(
      rows.map((row) => [Number(row.sku_id), row.rate_type]),
    );
    expect(byType[ctx.skuIds[1]]).toBe("PER_PAIR");
    expect(byType[ctx.skuIds[0]]).toBe("PER_DOZEN");

    // Restore the fixture for later tests.
    await db("erp.labour_rate_rules")
      .where({
        labour_id: ctx.sourceId,
        dept_id: ctx.deptId,
        sku_id: ctx.skuIds[1],
      })
      .update({ rate_type: "PER_DOZEN", rate_value: 20 });
  });

  test("the server ignores client-supplied rows and rebuilds the plan", async ({
    page,
  }) => {
    const targetId = await createLabour(`${TAG} TARGET FORGE`, ctx.deptId);
    await login(page, "E2E_ADMIN");
    await page.goto(RATES_PATH, { waitUntil: "domcontentloaded" });

    // Forge a payload carrying a bogus rate and an extra sku. The route must
    // derive rows from the source labour, not from anything the client sent.
    const result = await page.evaluate(
      async ({ path, source, dept, target }) => {
        const token = document
          .querySelector('input[name="_csrf"]')
          ?.getAttribute("value");
        const response = await fetch(path + "/copy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "CSRF-Token": token,
          },
          credentials: "same-origin",
          body: JSON.stringify({
            _csrf: token,
            source_labour_id: source,
            dept_id: dept,
            target_labour_ids: [target],
            conflict_mode: "SKIP",
            article_type: "BOTH",
            rows: [{ sku_id: 999999, new_rate: 123456, labour_id: target }],
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      {
        path: RATES_PATH,
        source: ctx.sourceId,
        dept: ctx.deptId,
        target: targetId,
      },
    );
    expect(result.status).toBe(200);

    const rows = await rateRows(targetId);
    expect(rows.map((row) => Number(row.rate_value))).toEqual([10, 20, 30]);
    expect(rows.some((row) => Number(row.rate_value) === 123456)).toBe(false);
  });

  test("copying to a labour outside the chosen department is refused", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await page.goto(RATES_PATH, { waitUntil: "domcontentloaded" });

    const result = await page.evaluate(
      async ({ path, source, dept, target }) => {
        const token = document
          .querySelector('input[name="_csrf"]')
          ?.getAttribute("value");
        const response = await fetch(path + "/copy", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "CSRF-Token": token,
          },
          credentials: "same-origin",
          body: JSON.stringify({
            _csrf: token,
            source_labour_id: source,
            dept_id: dept,
            target_labour_ids: [target],
            conflict_mode: "SKIP",
          }),
        });
        return { status: response.status, body: await response.json() };
      },
      {
        path: RATES_PATH,
        source: ctx.sourceId,
        dept: ctx.deptId,
        target: ctx.blockedId,
      },
    );

    expect(result.status).toBe(400);
    expect(await rateRows(ctx.blockedId)).toHaveLength(0);
  });

  test("department dropdown only offers departments with rates", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await openModal(page);
    await page.locator("[data-lrc-source]").selectOption(String(ctx.sourceId));
    await expect(page.locator("[data-lrc-dept]")).toBeEnabled();

    const values = await page
      .locator("[data-lrc-dept] option")
      .evaluateAll((opts) =>
        opts.map((opt) => opt.value).filter((value) => value !== ""),
      );
    expect(values).toEqual([String(ctx.deptId)]);

    // The option is annotated with how many rates would be copied.
    await expect(
      page.locator(`[data-lrc-dept] option[value="${ctx.deptId}"]`),
    ).toContainText("3");
  });

  test("the source labour cannot be picked as its own target", async ({
    page,
  }) => {
    await login(page, "E2E_ADMIN");
    await openModal(page);
    await page.locator("[data-lrc-source]").selectOption(String(ctx.sourceId));

    const targetValues = await page
      .locator("[data-lrc-targets] option")
      .evaluateAll((opts) => opts.map((opt) => opt.value));
    expect(targetValues).not.toContain(String(ctx.sourceId));
  });

  // Every e2e login available here carries the Admin role, which bypasses the
  // approval queue, so the queued path is exercised against the applier
  // directly — that is the code an approver's click actually runs.
  test("an approved BULK_LABOUR_RATE_COPY request writes the reviewed rows", async () => {
    const targetId = await createLabour(`${TAG} TARGET APPROVAL`, ctx.deptId);
    const plan = await copyService.buildCopyPlan({
      db,
      sourceLabourId: ctx.sourceId,
      targetLabourIds: [targetId],
      deptId: ctx.deptId,
      filters: {},
      conflictMode: "SKIP",
    });
    const rows = copyService.buildWriteRows({ plan, rateType: "PER_DOZEN" });
    expect(rows).toHaveLength(3);

    const request = {
      entity_type: "LABOUR",
      entity_id: String(targetId),
      new_value: {
        mode: "BULK_LABOUR_RATE_COPY",
        source_labour_id: ctx.sourceId,
        labour_ids: [targetId],
        dept_id: ctx.deptId,
        rate_type: "PER_DOZEN",
        status: "active",
        conflict_mode: "SKIP",
        rows,
      },
      old_value: null,
      summary: "Copy Labour Rates - e2e",
    };

    await db.transaction(async (trx) => {
      const applied = await applyMasterDataChange(trx, request, null);
      expect(applied).toBeTruthy();
    });

    const written = await rateRows(targetId);
    expect(written.map((row) => Number(row.rate_value))).toEqual([10, 20, 30]);
    written.forEach((row) => {
      expect(row.apply_on).toBe("SKU");
      expect(row.rate_type).toBe("PER_DOZEN");
      expect(row.status).toBe("active");
    });

    // Applying the same approved request twice must not duplicate rows.
    await db.transaction(async (trx) => {
      await applyMasterDataChange(trx, request, null);
    });
    expect(await rateRows(targetId)).toHaveLength(3);
  });

  test("an approved copy skips a target that lost its department", async () => {
    const targetId = await createLabour(`${TAG} TARGET DROPPED`, ctx.deptId);
    const plan = await copyService.buildCopyPlan({
      db,
      sourceLabourId: ctx.sourceId,
      targetLabourIds: [targetId],
      deptId: ctx.deptId,
      filters: {},
      conflictMode: "SKIP",
    });
    const rows = copyService.buildWriteRows({ plan, rateType: "PER_DOZEN" });

    // Unassign the target after the request was raised.
    await db("erp.labour_department").where({ labour_id: targetId }).del();
    await db("erp.labours").where({ id: targetId }).update({ dept_id: null });

    await db.transaction(async (trx) => {
      const applied = await applyMasterDataChange(
        trx,
        {
          entity_type: "LABOUR",
          entity_id: String(targetId),
          new_value: {
            mode: "BULK_LABOUR_RATE_COPY",
            labour_ids: [targetId],
            dept_id: ctx.deptId,
            rate_type: "PER_DOZEN",
            status: "active",
            conflict_mode: "SKIP",
            rows,
          },
          old_value: null,
          summary: "Copy Labour Rates - e2e dropped",
        },
        null,
      );
      expect(applied).toBe(false);
    });

    expect(await rateRows(targetId)).toHaveLength(0);
  });
});
