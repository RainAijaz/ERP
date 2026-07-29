// Cross-service coverage for the "requester is never rewritten" rule.
//
// All 7 voucher services de-dupe pending approvals by refreshing the existing
// row. That refresh used to stamp `requested_by` with whoever saved, so the
// second person to touch a pending voucher silently became its maker. This spec
// exercises the FINANCIAL service (cash voucher) rather than stock count, so the
// rule is proven on a second, independently written copy of that code path.
//
// Two non-approver users are used because an approver's edit self-approves and
// never reaches the refresh branch.

const { test, expect } = require("@playwright/test");
const knexConfig = require("../../knexfile").development;
const db = require("knex")(knexConfig);
const { login } = require("./utils/auth");
const {
  getUserByUsername,
  upsertUserWithPermissions,
  setUserScopePermission,
  getApprovalPolicy,
  upsertApprovalPolicy,
  deleteApprovalPolicy,
} = require("./utils/db");

const MAKER_USER = process.env.E2E_CV_MAKER_USER || "e2e_cv_maker";
const MAKER_PASS = process.env.E2E_CV_MAKER_PASS || "CvMaker@123";
const EDITOR_USER = process.env.E2E_CV_EDITOR_USER || "e2e_cv_editor";
const EDITOR_PASS = process.env.E2E_CV_EDITOR_PASS || "CvEditor@123";

const getCsrf = async (page) => {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === "csrf_token")?.value || "";
};

const relogin = async (page, prefix) => {
  await page.goto("about:blank").catch(() => {});
  await page.context().clearCookies();
  await login(page, prefix);
};

const postCashVoucher = async (page, { voucherId = "", amount, note }, st) => {
  const csrf = await getCsrf(page);
  return page.request.post("/vouchers/cash", {
    headers: { "x-csrf-token": csrf },
    form: {
      _csrf: csrf,
      voucher_id: String(voucherId || ""),
      voucher_date: new Date().toISOString().slice(0, 10),
      header_account_id: String(st.headerAccountId),
      remarks: note,
      lines_json: JSON.stringify([
        {
          party_id: String(st.supplierId),
          cash_receipt: "0",
          cash_payment: String(amount),
          description: note,
        },
      ]),
    },
  });
};

const approvalsFor = async (voucherId) =>
  db("erp.approval_request")
    .select("id", "status", "requested_by", "requested_at", "summary")
    .where({ entity_type: "VOUCHER", entity_id: String(voucherId) })
    .orderBy("id", "asc");

test.describe("Refreshing a pending approval keeps its original requester", () => {
  test.describe.configure({ mode: "serial", timeout: 120000 });

  const state = {
    ready: false,
    skipReason: "fixture not built",
    branchId: null,
    headerAccountId: null,
    supplierId: null,
    makerId: null,
    editorId: null,
    adminId: null,
    policySnapshots: {},
    createdVoucherId: null,
  };

  test.beforeAll(async () => {
    process.env.E2E_CV_MAKER_USER = MAKER_USER;
    process.env.E2E_CV_MAKER_PASS = MAKER_PASS;
    process.env.E2E_CV_EDITOR_USER = EDITOR_USER;
    process.env.E2E_CV_EDITOR_PASS = EDITOR_PASS;

    const admin = await getUserByUsername(process.env.E2E_ADMIN_USER || "");
    state.adminId = Number(admin?.id || 0) || null;

    // Borrow the account/party/branch combination from a cash voucher this DB
    // has already posted, so the new one is guaranteed to be postable here.
    const sample = await db("erp.voucher_header as vh")
      .join("erp.voucher_line as vl", "vl.voucher_header_id", "vh.id")
      .join("erp.parties as p", "p.id", "vl.party_id")
      .where("vh.voucher_type_code", "CASH_VOUCHER")
      .where("vh.status", "APPROVED")
      .whereNotNull("vh.header_account_id")
      .whereIn("p.party_type", ["SUPPLIER", "BOTH"])
      .select("p.id as party_id", "vh.header_account_id", "vh.branch_id")
      .orderBy("vh.id", "desc")
      .first();
    if (!sample) {
      state.skipReason = "no approved cash voucher with a supplier line to reuse";
      return;
    }
    state.branchId = Number(sample.branch_id);
    state.headerAccountId = Number(sample.header_account_id);
    state.supplierId = Number(sample.party_id);

    for (const [username, password, key] of [
      [MAKER_USER, MAKER_PASS, "makerId"],
      [EDITOR_USER, EDITOR_PASS, "editorId"],
    ]) {
      state[key] = await upsertUserWithPermissions({
        username,
        password,
        roleName: process.env.E2E_ROLE_SALESMAN || "Salesman",
        branchId: state.branchId,
        scopeKeys: [],
      });
      if (!state[key]) {
        state.skipReason = `unable to provision ${username}`;
        return;
      }
      await setUserScopePermission({
        userId: state[key],
        scopeType: "VOUCHER",
        scopeKey: "CASH_VOUCHER",
        permissions: {
          can_navigate: true,
          can_view: true,
          can_create: true,
          can_edit: true,
          can_delete: false,
          can_print: true,
          can_approve: false, // an approver's edit self-approves instead
        },
      });
    }

    for (const action of ["create", "edit"]) {
      state.policySnapshots[action] = await getApprovalPolicy({
        entityType: "VOUCHER_TYPE",
        entityKey: "CASH_VOUCHER",
        action,
      });
      await upsertApprovalPolicy({
        entityType: "VOUCHER_TYPE",
        entityKey: "CASH_VOUCHER",
        action,
        requiresApproval: true,
      });
    }

    state.ready = true;
  });

  test.afterAll(async () => {
    const safe = async (fn) => {
      try {
        await fn();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[E2E cleanup]", err.message);
      }
    };

    for (const action of ["create", "edit"]) {
      const snapshot = state.policySnapshots[action];
      await safe(async () => {
        if (snapshot && typeof snapshot.requires_approval === "boolean") {
          await upsertApprovalPolicy({
            entityType: "VOUCHER_TYPE",
            entityKey: "CASH_VOUCHER",
            action,
            requiresApproval: snapshot.requires_approval,
          });
        } else {
          await deleteApprovalPolicy({
            entityType: "VOUCHER_TYPE",
            entityKey: "CASH_VOUCHER",
            action,
          });
        }
      });
    }

    // The voucher never leaves PENDING here, so nothing posted to GL.
    if (state.createdVoucherId) {
      const id = state.createdVoucherId;
      await safe(() =>
        db("erp.approval_request")
          .where({ entity_type: "VOUCHER", entity_id: String(id) })
          .del(),
      );
      await safe(() =>
        db("erp.activity_log")
          .where({ entity_type: "VOUCHER", entity_id: String(id) })
          .del(),
      );
      await safe(() => db("erp.voucher_line").where({ voucher_header_id: id }).del());
      await safe(() => db("erp.voucher_header").where({ id }).del());
    }

    await db.destroy();
  });

  test("a second user editing a pending cash voucher does not become its requester", async ({
    page,
  }) => {
    test.skip(!state.ready, state.skipReason);

    // --- maker raises it ---
    await relogin(page, "E2E_CV_MAKER");
    const createResp = await postCashVoucher(
      page,
      { amount: 310, note: "e2e requester-preserved create" },
      state,
    );
    expect(createResp.ok()).toBeTruthy();

    const header = await db("erp.voucher_header")
      .where({
        voucher_type_code: "CASH_VOUCHER",
        branch_id: state.branchId,
        created_by: state.makerId,
      })
      .orderBy("id", "desc")
      .first();
    expect(header?.id, "maker's cash voucher was not created").toBeTruthy();
    state.createdVoucherId = Number(header.id);
    expect(String(header.status).toUpperCase()).toBe("PENDING");

    const afterCreate = await approvalsFor(state.createdVoucherId);
    expect(afterCreate.length).toBe(1);
    expect(Number(afterCreate[0].requested_by)).toBe(Number(state.makerId));
    const approvalId = Number(afterCreate[0].id);
    const requestedAt = new Date(afterCreate[0].requested_at).getTime();

    // --- a different (also non-approving) user edits it ---
    await relogin(page, "E2E_CV_EDITOR");
    const editResp = await postCashVoucher(
      page,
      {
        voucherId: state.createdVoucherId,
        amount: 460,
        note: "e2e requester-preserved edit",
      },
      state,
    );
    expect(editResp.ok()).toBeTruthy();

    const afterEdit = await approvalsFor(state.createdVoucherId);
    expect(afterEdit.length, "the edit must not stack a second request").toBe(1);
    expect(Number(afterEdit[0].id)).toBe(approvalId);
    expect(String(afterEdit[0].status).toUpperCase()).toBe("PENDING");

    expect(
      Number(afterEdit[0].requested_by),
      "the editor must not take over authorship of the request",
    ).toBe(Number(state.makerId));
    expect(Number(afterEdit[0].requested_by)).not.toBe(Number(state.editorId));
    expect(
      new Date(afterEdit[0].requested_at).getTime(),
      "requested_at belongs to the original submission",
    ).toBe(requestedAt);

    // The request did move forward — only its authorship is frozen. (The
    // financial service labels edits "EDIT ..."; inventory uses "UPDATE ...".)
    expect(String(afterEdit[0].summary || "")).toMatch(/^(EDIT|UPDATE)\s/);

    // An admin is still a valid checker for it (maker != checker holds).
    if (state.adminId) {
      expect(Number(afterEdit[0].requested_by)).not.toBe(Number(state.adminId));
    }
  });
});
