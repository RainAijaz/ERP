// Opening Balance on the customer/supplier create form.
//
// The whole point of the feature is that the number does NOT live on erp.parties —
// it is posted as a real Journal Voucher, because every ledger derives party balances
// by summing erp.gl_entry on party_id and erp.gl_batch.source_voucher_id is NOT NULL.
// So a test that only checked the form would prove nothing: each test here drives the
// real screen and then asserts on the GL rows that came out the other end.
//
// Requires a running server (E2E_BASE_URL, default http://localhost:3000) and
// E2E_ADMIN_USER / E2E_ADMIN_PASSWORD.
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");
const knex = require("../../src/db/knex");

const PARTIES_URL = "/master-data/basic-info/parties";
const NAME_PREFIX = "ZZ E2E OpenBal";

const ctx = {
  branchId: null,
  altBranchId: null,
  cityId: null,
  groupId: null,
  adminUserId: null,
  makerUserId: null,
  // Only torn down if this spec had to create it.
  createdEquityAccountIds: [],
  partyIds: [],
  approvalIds: [],
};

// ---------------------------------------------------------------- helpers

const selectByValue = async (selectLocator, value) => {
  await selectLocator.evaluate((el, val) => {
    el.value = String(val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, String(value));
};

const selectMultiValues = async (selectLocator, values) => {
  await selectLocator.evaluate((el, wanted) => {
    const set = new Set(wanted.map(String));
    Array.from(el.options).forEach((opt) => {
      opt.selected = set.has(String(opt.value));
    });
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, values.map(String));
};

/**
 * Fills and submits the parties create modal. `openingBalance` is optional so the
 * same helper covers the "no opening balance" control cases.
 */
const createPartyViaUi = async (
  page,
  { name, partyType = "SUPPLIER", branchId, openingBalance = null },
) => {
  await page.goto(PARTIES_URL, { waitUntil: "domcontentloaded" });
  await page.locator("[data-modal-open]").first().click();
  await expect(page.locator("[data-modal]")).toBeVisible();

  const form = page.locator("[data-modal-form]");
  await form.locator("[data-field='name']").fill(name);
  await form.locator("[data-field='name_ur']").fill(`${name} UR`);
  await selectByValue(
    form.locator("select[data-field='party_type']").first(),
    partyType,
  );
  await selectByValue(
    form.locator("select[data-field='group_id']").first(),
    ctx.groupId,
  );
  await selectMultiValues(
    form.locator("select[data-field='branch_ids']").first(),
    [branchId || ctx.branchId],
  );
  await selectByValue(
    form.locator("select[data-field='city_id']").first(),
    ctx.cityId,
  );
  await form.locator("[data-field='phone1']").fill("0300-7654321");

  if (openingBalance) {
    await form
      .locator("[data-field='opening_balance']")
      .fill(String(openingBalance.amount));
    await selectByValue(
      form.locator("select[data-field='opening_balance_direction']").first(),
      openingBalance.direction,
    );
    await form
      .locator("[data-field='opening_balance_date']")
      .fill(openingBalance.asOfDate);
  }

  await form.locator("button[type='submit']").click();
  await expect(page).toHaveURL(/parties/i);
};

const findParty = async (name) =>
  knex("erp.parties").whereRaw("lower(name) = lower(?)", [name]).first();

/** Every GL leg carrying this party, with its account code and owning voucher. */
const glLegsForParty = async (partyId) =>
  knex("erp.gl_entry as ge")
    .join("erp.accounts as a", "a.id", "ge.account_id")
    .join("erp.gl_batch as gb", "gb.id", "ge.batch_id")
    .join("erp.voucher_header as vh", "vh.id", "gb.source_voucher_id")
    .select(
      "a.code as account_code",
      "ge.dr",
      "ge.cr",
      "ge.entry_date",
      "ge.branch_id",
      "vh.id as voucher_id",
      "vh.voucher_no",
      "vh.voucher_type_code",
      "vh.status",
    )
    .where("ge.party_id", partyId);

/** Both sides of the voucher, so the contra leg and the balancing can be checked. */
const allLegsOfVoucher = async (voucherId) =>
  knex("erp.gl_entry as ge")
    .join("erp.accounts as a", "a.id", "ge.account_id")
    .join("erp.gl_batch as gb", "gb.id", "ge.batch_id")
    .select("a.code as account_code", "ge.dr", "ge.cr", "ge.party_id")
    .where("gb.source_voucher_id", voucherId);

// Create-form validation failures come back via the parties flash cookie, which
// re-opens the modal with the message in [data-modal-error] — not as a toast.
const modalError = (page) => page.locator("[data-modal-error]");
const uiNotice = (page) => page.locator("[data-ui-notice-toast]");

const isoDaysFromNow = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * The contra account must exist or every post fails. It is seeded as a GROUP with no
 * accounts under it (erp.accounts rows are never seeded anywhere), so on a fresh DB
 * this spec has to create one — and then owns cleaning it up.
 */
const ensureEquityAccount = async (branchId) => {
  const group = await knex("erp.account_groups")
    .where({ code: "opening_balance_equity" })
    .first();
  if (!group) return false;

  const existing = await knex("erp.accounts as a")
    .join("erp.account_branch as ab", "ab.account_id", "a.id")
    .where({ "a.subgroup_id": group.id, "ab.branch_id": branchId })
    .select("a.id")
    .first();
  if (existing) return true;

  const [row] = await knex("erp.accounts")
    .insert({
      code: "gl_opening_balance_equity",
      name: "Opening Balance Equity",
      name_ur: "ابتدائی بیلنس ایکویٹی",
      subgroup_id: group.id,
      // Control accounts default to locked, and validateLines rejects locked
      // accounts on manual JV lines.
      lock_posting: false,
      is_active: true,
      created_by: ctx.adminUserId,
    })
    .onConflict("code")
    .merge({ lock_posting: false, is_active: true })
    .returning("id");
  const accountId = Number(row?.id ?? row);
  await knex("erp.account_branch")
    .insert({ account_id: accountId, branch_id: branchId })
    .onConflict(["account_id", "branch_id"])
    .ignore();
  ctx.createdEquityAccountIds.push(accountId);
  return true;
};

// ---------------------------------------------------------------- lifecycle

test.describe("Party opening balance", () => {
  // Deliberately not "serial": each test creates its own party and asserts on its
  // own GL rows, so one failure must not hide the state of the other fourteen.
  test.beforeAll(async () => {
    const admin = await knex("erp.users")
      .where({ username: process.env.E2E_ADMIN_USER || "admin" })
      .first();
    // approval_request_maker_checker_check forbids decided_by = requested_by, so the
    // queued-request tests need a requester who is not the approving admin.
    const maker = await knex("erp.users")
      .whereNot({ id: admin?.id || 0 })
      .first();
    const branches = await knex("erp.branches")
      .where({ is_active: true })
      .orderBy("id")
      .select("id");
    const city = await knex("erp.cities").orderBy("id").first();
    const group = await knex("erp.party_groups").orderBy("id").first();

    ctx.adminUserId = admin?.id || null;
    ctx.makerUserId = maker?.id || null;
    ctx.branchId = branches[0] ? Number(branches[0].id) : null;
    ctx.altBranchId = branches[1] ? Number(branches[1].id) : null;
    ctx.cityId = city?.id || null;
    ctx.groupId = group?.id || null;

    test.skip(
      !ctx.adminUserId || !ctx.branchId || !ctx.cityId || !ctx.groupId,
      "Missing admin user, active branch, city, or party group.",
    );

    const ready = await ensureEquityAccount(ctx.branchId);
    test.skip(
      !ready,
      "No 'opening_balance_equity' account group — run the seeds first.",
    );
    if (ctx.altBranchId) await ensureEquityAccount(ctx.altBranchId);
  });

  test.afterAll(async () => {
    const parties = await knex("erp.parties")
      .where("name", "like", `${NAME_PREFIX}%`)
      .select("id");
    const partyIds = parties.map((p) => Number(p.id));

    if (partyIds.length) {
      const batches = await knex("erp.gl_batch as gb")
        .join("erp.gl_entry as ge", "ge.batch_id", "gb.id")
        .whereIn("ge.party_id", partyIds)
        .distinct("gb.source_voucher_id as vid");
      const voucherIds = batches.map((b) => Number(b.vid));
      if (voucherIds.length) {
        await knex("erp.gl_batch")
          .whereIn("source_voucher_id", voucherIds)
          .del();
        await knex("erp.voucher_line")
          .whereIn("voucher_header_id", voucherIds)
          .del();
        await knex("erp.voucher_header").whereIn("id", voucherIds).del();
      }
      await knex("erp.party_branch").whereIn("party_id", partyIds).del();
      await knex("erp.parties").whereIn("id", partyIds).del();
    }

    await knex("erp.approval_request")
      .where("summary", "like", `%${NAME_PREFIX}%`)
      .del();

    if (ctx.createdEquityAccountIds.length) {
      await knex("erp.account_branch")
        .whereIn("account_id", ctx.createdEquityAccountIds)
        .del();
      await knex("erp.accounts")
        .whereIn("id", ctx.createdEquityAccountIds)
        .del();
    }
    await knex.destroy();
  });

  test.beforeEach(async ({ page }) => {
    await login(page, "E2E_ADMIN");
  });

  // -------------------------------------------------------------- form shape

  test("create modal exposes the three opening balance inputs", async ({
    page,
  }) => {
    await page.goto(PARTIES_URL, { waitUntil: "domcontentloaded" });
    await page.locator("[data-modal-open]").first().click();
    await expect(page.locator("[data-modal]")).toBeVisible();

    const form = page.locator("[data-modal-form]");
    await expect(form.locator("[data-field='opening_balance']")).toBeVisible();
    await expect(
      form.locator("select[data-field='opening_balance_direction']"),
    ).toBeVisible();
    await expect(
      form.locator("[data-field='opening_balance_date']"),
    ).toBeVisible();

    // Direction must be phrased from the business's point of view, not Dr/Cr.
    const options = await form
      .locator("select[data-field='opening_balance_direction'] option")
      .allTextContents();
    expect(options.join(" ")).toMatch(/they owe us/i);
    expect(options.join(" ")).toMatch(/we owe them/i);
  });

  test("opening balance is hidden and disabled when editing an existing party", async ({
    page,
  }) => {
    // An existing party's balance is changed by posting a voucher, never by
    // editing the party row — so the inputs must not appear on the edit path.
    const name = `${NAME_PREFIX} EditHide ${Date.now()}`;
    await createPartyViaUi(page, { name, partyType: "CUSTOMER" });
    const party = await findParty(name);
    expect(party).toBeTruthy();

    // Reload rather than closing the create modal: an open modal overlay
    // intercepts the click on the row's edit button.
    await page.goto(PARTIES_URL, { waitUntil: "domcontentloaded" });

    // The list pages client-side, so the new row is only in the DOM once the
    // page size is lifted and the search narrows to it.
    await page.locator("[data-page-size]").selectOption("all");
    await page.locator("[data-search-input]").fill(name);
    const editButton = page
      .locator(`[data-edit][data-id='${party.id}']`)
      .first();
    await expect(editButton).toBeVisible();
    await editButton.click();
    await expect(page.locator("[data-modal]")).toBeVisible();

    const group = page.locator("[data-opening-balance-group]");
    await expect(group).toHaveClass(/hidden/);
    // Hiding alone would still submit the values; they must be disabled too.
    await expect(
      page.locator("[data-modal-form] [data-field='opening_balance']"),
    ).toBeDisabled();
  });

  // -------------------------------------------------------------- happy paths

  test("supplier we owe money to posts a credit to the AP control account", async ({
    page,
  }) => {
    const name = `${NAME_PREFIX} Sup CR ${Date.now()}`;
    await createPartyViaUi(page, {
      name,
      partyType: "SUPPLIER",
      openingBalance: {
        amount: 75000,
        direction: "CR",
        asOfDate: "2026-07-01",
      },
    });

    const party = await findParty(name);
    expect(party).toBeTruthy();

    const legs = await glLegsForParty(party.id);
    expect(legs).toHaveLength(1);
    expect(legs[0].account_code).toBe("gl_ap_control");
    expect(Number(legs[0].cr)).toBe(75000);
    expect(Number(legs[0].dr)).toBe(0);
    expect(legs[0].voucher_type_code).toBe("JOURNAL_VOUCHER");
    expect(legs[0].status).toBe("APPROVED");

    // The contra side must be equity, and the voucher must balance.
    const all = await allLegsOfVoucher(legs[0].voucher_id);
    expect(all).toHaveLength(2);
    const contra = all.find((l) => l.account_code !== "gl_ap_control");
    expect(contra.account_code).toMatch(/opening_balance_equity/i);
    expect(Number(contra.dr)).toBe(75000);
    const totalDr = all.reduce((s, l) => s + Number(l.dr), 0);
    const totalCr = all.reduce((s, l) => s + Number(l.cr), 0);
    expect(totalDr).toBe(totalCr);
  });

  test("customer who owes us posts a debit to the AR control account", async ({
    page,
  }) => {
    const name = `${NAME_PREFIX} Cust DR ${Date.now()}`;
    await createPartyViaUi(page, {
      name,
      partyType: "CUSTOMER",
      openingBalance: {
        amount: 12345.67,
        direction: "DR",
        asOfDate: "2026-07-01",
      },
    });

    const party = await findParty(name);
    const legs = await glLegsForParty(party.id);
    expect(legs).toHaveLength(1);
    expect(legs[0].account_code).toBe("gl_ar_control");
    expect(Number(legs[0].dr)).toBeCloseTo(12345.67, 2);
    expect(Number(legs[0].cr)).toBe(0);

    const all = await allLegsOfVoucher(legs[0].voucher_id);
    const totalDr = all.reduce((s, l) => s + Number(l.dr), 0);
    const totalCr = all.reduce((s, l) => s + Number(l.cr), 0);
    expect(totalDr).toBeCloseTo(totalCr, 2);
  });

  test("the voucher is dated the as-of date, not today", async ({ page }) => {
    // Backdating is the entire reason the field exists — an opening balance posted
    // with today's date would land in the wrong period.
    const name = `${NAME_PREFIX} Backdate ${Date.now()}`;
    await createPartyViaUi(page, {
      name,
      partyType: "SUPPLIER",
      openingBalance: { amount: 900, direction: "CR", asOfDate: "2026-07-01" },
    });

    const party = await findParty(name);
    const legs = await glLegsForParty(party.id);
    expect(legs).toHaveLength(1);
    const entryDate = new Date(legs[0].entry_date).toISOString().slice(0, 10);
    // Stored as a timestamp, so allow the local-midnight shift either way.
    expect(["2026-06-30", "2026-07-01"]).toContain(entryDate);
    expect(entryDate).not.toBe(new Date().toISOString().slice(0, 10));
  });

  test("a party created with no opening balance posts nothing at all", async ({
    page,
  }) => {
    // The overwhelmingly common case: the field is optional and must stay silent.
    const name = `${NAME_PREFIX} NoBalance ${Date.now()}`;
    await createPartyViaUi(page, { name, partyType: "SUPPLIER" });

    const party = await findParty(name);
    expect(party).toBeTruthy();
    expect(await glLegsForParty(party.id)).toHaveLength(0);
  });

  test("an explicit zero posts nothing", async ({ page }) => {
    const name = `${NAME_PREFIX} Zero ${Date.now()}`;
    await createPartyViaUi(page, {
      name,
      partyType: "SUPPLIER",
      openingBalance: { amount: 0, direction: "CR", asOfDate: "2026-07-01" },
    });

    const party = await findParty(name);
    expect(party).toBeTruthy();
    expect(await glLegsForParty(party.id)).toHaveLength(0);
  });

  // -------------------------------------------------------------- validation

  test("a future as-of date is rejected and no party is created", async ({
    page,
  }) => {
    const name = `${NAME_PREFIX} Future ${Date.now()}`;
    await createPartyViaUi(page, {
      name,
      partyType: "SUPPLIER",
      openingBalance: {
        amount: 500,
        direction: "CR",
        asOfDate: isoDaysFromNow(30),
      },
    });

    await expect(modalError(page)).toContainText(/future/i);
    // The whole create must fail, not just the balance — otherwise the user is
    // left with a party they think has a balance and does not.
    expect(await findParty(name)).toBeFalsy();
  });

  test("choosing OTHER hides, disables and clears the opening balance", async ({
    page,
  }) => {
    // OTHER parties are neither bought from nor sold to, so they have no AR/AP
    // control account to post against. The form takes the inputs away rather
    // than letting the user type a number that could never post.
    await page.goto(PARTIES_URL, { waitUntil: "domcontentloaded" });
    await page.locator("[data-modal-open]").first().click();
    const form = page.locator("[data-modal-form]");
    const partyType = form.locator("select[data-field='party_type']").first();

    await selectByValue(partyType, "SUPPLIER");
    await form.locator("[data-field='opening_balance']").fill("500");
    await expect(page.locator("[data-opening-balance-group]")).not.toHaveClass(
      /hidden/,
    );

    await selectByValue(partyType, "OTHER");
    await expect(page.locator("[data-opening-balance-group]")).toHaveClass(
      /hidden/,
    );
    // Disabled as well as hidden, or the value would still be submitted.
    await expect(form.locator("[data-field='opening_balance']")).toBeDisabled();
    // And cleared, so switching back does not resurrect a stale number.
    await expect(form.locator("[data-field='opening_balance']")).toHaveValue(
      "",
    );
  });

  test("the server rejects an OTHER opening balance even if the form is bypassed", async ({
    page,
  }) => {
    // The client-side hiding above is a convenience. A hand-rolled POST must
    // still be refused, and must not leave a half-made party behind.
    const name = `${NAME_PREFIX} OtherPost ${Date.now()}`;
    await page.goto(PARTIES_URL, { waitUntil: "domcontentloaded" });
    const csrf = await page
      .locator("[data-modal-form] input[name='_csrf']")
      .first()
      .inputValue();

    const response = await page.request.post(PARTIES_URL, {
      form: {
        _csrf: csrf,
        name,
        name_ur: `${name} UR`,
        party_type: "OTHER",
        // No group_id: party groups are typed, and a mismatched one trips its own
        // validation before the opening balance is ever looked at.
        city_id: String(ctx.cityId),
        branch_ids: String(ctx.branchId),
        phone1: "0300-7654321",
        opening_balance: "500",
        opening_balance_direction: "DR",
        opening_balance_date: "2026-07-01",
      },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(302);

    const flash = (response.headers()["set-cookie"] || "")
      .split("\n")
      .find((c) => c.startsWith("parties_flash="));
    expect(decodeURIComponent(flash || "")).toMatch(/customer or a supplier/i);
    expect(await findParty(name)).toBeFalsy();
  });

  test("an amount with no as-of date is rejected", async ({ page }) => {
    const name = `${NAME_PREFIX} NoDate ${Date.now()}`;
    await page.goto(PARTIES_URL, { waitUntil: "domcontentloaded" });
    await page.locator("[data-modal-open]").first().click();
    const form = page.locator("[data-modal-form]");
    await form.locator("[data-field='name']").fill(name);
    await form.locator("[data-field='name_ur']").fill(`${name} UR`);
    await selectByValue(
      form.locator("select[data-field='party_type']").first(),
      "SUPPLIER",
    );
    await selectByValue(
      form.locator("select[data-field='group_id']").first(),
      ctx.groupId,
    );
    await selectMultiValues(
      form.locator("select[data-field='branch_ids']").first(),
      [ctx.branchId],
    );
    await selectByValue(
      form.locator("select[data-field='city_id']").first(),
      ctx.cityId,
    );
    await form.locator("[data-field='phone1']").fill("0300-7654321");
    await form.locator("[data-field='opening_balance']").fill("1000");
    // date deliberately left blank
    await form.locator("button[type='submit']").click();

    await expect(modalError(page)).toContainText(/date/i);
    expect(await findParty(name)).toBeFalsy();
  });

  // -------------------------------------------------------------- maker-checker

  test("a queued create carries the balance in the payload and posts nothing yet", async ({
    page,
  }) => {
    test.skip(!ctx.makerUserId, "Needs a second user to act as the maker.");
    const name = `${NAME_PREFIX} Queued ${Date.now()}`;
    const [row] = await knex("erp.approval_request")
      .insert({
        branch_id: ctx.branchId,
        request_type: "MASTER_DATA_CHANGE",
        entity_type: "PARTY",
        entity_id: "NEW",
        summary: `Create Parties - ${name}`,
        status: "PENDING",
        requested_by: ctx.makerUserId,
        new_value: JSON.stringify({
          name,
          name_ur: `${name} UR`,
          party_type: "CUSTOMER",
          branch_id: ctx.branchId,
          city_id: ctx.cityId,
          group_id: ctx.groupId,
          phone1: "0300-1112222",
          code: `zz_e2e_q_${Date.now()}`,
          credit_allowed: false,
          credit_limit: 0,
          branch_ids: [String(ctx.branchId)],
          _action: "create",
          _opening_balance: {
            amount: 33000,
            direction: "DR",
            as_of_date: "2026-07-01",
          },
        }),
      })
      .returning(["id"]);
    ctx.approvalIds.push(row.id);

    // Nothing may exist until a checker approves.
    expect(await findParty(name)).toBeFalsy();

    const stored = await knex("erp.approval_request")
      .where({ id: row.id })
      .first();
    expect(stored.new_value._opening_balance).toMatchObject({
      amount: 33000,
      direction: "DR",
      as_of_date: "2026-07-01",
    });
  });

  test("approving a queued create makes the party AND posts its balance", async ({
    page,
  }) => {
    test.skip(!ctx.makerUserId, "Needs a second user to act as the maker.");
    const name = `${NAME_PREFIX} Approve ${Date.now()}`;
    const [row] = await knex("erp.approval_request")
      .insert({
        branch_id: ctx.branchId,
        request_type: "MASTER_DATA_CHANGE",
        entity_type: "PARTY",
        entity_id: "NEW",
        summary: `Create Parties - ${name}`,
        status: "PENDING",
        requested_by: ctx.makerUserId,
        new_value: JSON.stringify({
          name,
          name_ur: `${name} UR`,
          party_type: "CUSTOMER",
          branch_id: ctx.branchId,
          city_id: ctx.cityId,
          group_id: ctx.groupId,
          phone1: "0300-1112222",
          code: `zz_e2e_a_${Date.now()}`,
          credit_allowed: false,
          credit_limit: 0,
          branch_ids: [String(ctx.branchId)],
          _action: "create",
          _opening_balance: {
            amount: 33000,
            direction: "DR",
            as_of_date: "2026-07-01",
          },
        }),
      })
      .returning(["id"]);
    ctx.approvalIds.push(row.id);

    // NOT ?request_id= — that auto-opens the detail modal, whose overlay
    // swallows clicks on the Approve/Reject buttons behind it. The list is
    // ordered requested_at desc, so a freshly seeded row is on page 1.
    await page.goto("/administration/approvals?status=PENDING", {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator(`form[action='/administration/approvals/${row.id}/approve']`)
      .locator("button[type='submit']")
      .click();
    await expect(uiNotice(page)).toContainText(/approved/i);

    const party = await findParty(name);
    expect(party).toBeTruthy();
    ctx.partyIds.push(party.id);

    // The meta key must never reach the party row.
    expect(Object.keys(party)).not.toContain("_opening_balance");

    const legs = await glLegsForParty(party.id);
    expect(legs).toHaveLength(1);
    expect(legs[0].account_code).toBe("gl_ar_control");
    expect(Number(legs[0].dr)).toBe(33000);
    expect(legs[0].status).toBe("APPROVED");
  });

  test("rejecting a queued create posts nothing", async ({ page }) => {
    test.skip(!ctx.makerUserId, "Needs a second user to act as the maker.");
    const name = `${NAME_PREFIX} Reject ${Date.now()}`;
    const [row] = await knex("erp.approval_request")
      .insert({
        branch_id: ctx.branchId,
        request_type: "MASTER_DATA_CHANGE",
        entity_type: "PARTY",
        entity_id: "NEW",
        summary: `Create Parties - ${name}`,
        status: "PENDING",
        requested_by: ctx.makerUserId,
        new_value: JSON.stringify({
          name,
          name_ur: `${name} UR`,
          party_type: "SUPPLIER",
          branch_id: ctx.branchId,
          city_id: ctx.cityId,
          group_id: ctx.groupId,
          phone1: "0300-1112222",
          code: `zz_e2e_r_${Date.now()}`,
          credit_allowed: false,
          credit_limit: 0,
          branch_ids: [String(ctx.branchId)],
          _action: "create",
          _opening_balance: {
            amount: 4000,
            direction: "CR",
            as_of_date: "2026-07-01",
          },
        }),
      })
      .returning(["id"]);
    ctx.approvalIds.push(row.id);

    // NOT ?request_id= — that auto-opens the detail modal, whose overlay
    // swallows clicks on the Approve/Reject buttons behind it. The list is
    // ordered requested_at desc, so a freshly seeded row is on page 1.
    await page.goto("/administration/approvals?status=PENDING", {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator(`form[action='/administration/approvals/${row.id}/reject']`)
      .locator("button[type='submit']")
      .click();

    expect(await findParty(name)).toBeFalsy();
    const after = await knex("erp.approval_request")
      .where({ id: row.id })
      .first();
    expect(after.status).toBe("REJECTED");
  });

  test("the voucher lands on the party's branch, not the approver's", async ({
    page,
  }) => {
    // createVoucher reads req.branchId, which on the approvals screen belongs to the
    // approver. A party in another branch must still post to its own branch.
    test.skip(
      !ctx.makerUserId || !ctx.altBranchId,
      "Needs a second user and a second active branch.",
    );
    const name = `${NAME_PREFIX} CrossBranch ${Date.now()}`;
    const [row] = await knex("erp.approval_request")
      .insert({
        branch_id: ctx.altBranchId,
        request_type: "MASTER_DATA_CHANGE",
        entity_type: "PARTY",
        entity_id: "NEW",
        summary: `Create Parties - ${name}`,
        status: "PENDING",
        requested_by: ctx.makerUserId,
        new_value: JSON.stringify({
          name,
          name_ur: `${name} UR`,
          party_type: "SUPPLIER",
          branch_id: ctx.altBranchId,
          city_id: ctx.cityId,
          group_id: ctx.groupId,
          phone1: "0300-4445555",
          code: `zz_e2e_xb_${Date.now()}`,
          credit_allowed: false,
          credit_limit: 0,
          branch_ids: [String(ctx.altBranchId)],
          _action: "create",
          _opening_balance: {
            amount: 4200,
            direction: "CR",
            as_of_date: "2026-07-01",
          },
        }),
      })
      .returning(["id"]);
    ctx.approvalIds.push(row.id);

    // NOT ?request_id= — that auto-opens the detail modal, whose overlay
    // swallows clicks on the Approve/Reject buttons behind it. The list is
    // ordered requested_at desc, so a freshly seeded row is on page 1.
    await page.goto("/administration/approvals?status=PENDING", {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator(`form[action='/administration/approvals/${row.id}/approve']`)
      .locator("button[type='submit']")
      .click();

    const party = await findParty(name);
    expect(party).toBeTruthy();
    expect(Number(party.branch_id)).toBe(ctx.altBranchId);

    const legs = await glLegsForParty(party.id);
    expect(legs).toHaveLength(1);
    expect(Number(legs[0].branch_id)).toBe(ctx.altBranchId);
  });

  // -------------------------------------------------------------- read-back

  test("the posted balance shows up on the supplier ledger", async ({
    page,
  }) => {
    // The reason for posting to the GL at all: the number has to be visible in the
    // reports users actually read, not just on the party record.
    const name = `${NAME_PREFIX} Ledger ${Date.now()}`;
    await createPartyViaUi(page, {
      name,
      partyType: "SUPPLIER",
      openingBalance: {
        amount: 50000,
        direction: "CR",
        asOfDate: "2026-07-01",
      },
    });
    const party = await findParty(name);
    expect(party).toBeTruthy();

    await page.goto(
      `/reports/purchases/supplier-ledger?party_id=${party.id}` +
        `&from_date=2026-07-02&to_date=2026-12-31&load_report=1`,
      { waitUntil: "domcontentloaded" },
    );
    // Opening balance is derived by summing GL before from_date, so a JV dated
    // 01-Jul must appear as the opening figure for a range starting 02-Jul.
    await expect(page.locator("body")).toContainText(/50,000|50000/);
  });
});
