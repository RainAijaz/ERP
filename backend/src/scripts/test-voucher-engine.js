require("dotenv").config();
const http = require("http");
const querystring = require("querystring");
const knex = require("../db/knex");

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
const USERNAME = process.env.TEST_ADMIN_USER || "admin";
const PASSWORD = process.env.TEST_ADMIN_PASSWORD || "admin123";

const request = (method, url, { headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      headers,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ res, data }));
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

const getCookie = (setCookieHeaders, name) => {
  if (!setCookieHeaders) return null;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  const found = headers.find((header) => header.startsWith(`${name}=`));
  if (!found) return null;
  return found.split(";")[0].split("=")[1];
};

const resolveAccountSubgroup = async () => {
  const preferred = await knex("erp.account_subgroups")
    .select("id")
    .where({ code: "cash_in_hand" })
    .first();
  if (preferred) return preferred.id;

  const any = await knex("erp.account_subgroups").select("id").first();
  if (!any) {
    throw new Error("No account_subgroups found. Run seeds first.");
  }
  return any.id;
};

const ensureAccount = async () => {
  const existing = await knex("erp.accounts")
    .select("id")
    .where({ code: "TEST_ACC" })
    .first();
  if (existing) return existing.id;

  const subgroupId = await resolveAccountSubgroup();
  const [created] = await knex("erp.accounts")
    .insert({
      code: "TEST_ACC",
      name: "Test Account",
      subgroup_id: subgroupId,
      is_active: true,
    })
    .returning(["id"]);

  return created.id;
};

const run = async () => {
  const accountId = await ensureAccount();

  const loginUrl = `${BASE_URL}/auth/login`;
  const loginPage = await request("GET", loginUrl);
  const csrfTokenMatch = loginPage.data.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!csrfTokenMatch) {
    throw new Error("CSRF token not found on login page.");
  }
  const csrfForm = csrfTokenMatch[1];
  const csrfCookie = getCookie(loginPage.res.headers["set-cookie"], "csrf_token");

  const loginBody = querystring.stringify({
    username: USERNAME,
    password: PASSWORD,
    _csrf: csrfForm,
  });

  const loginHeaders = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Content-Length": Buffer.byteLength(loginBody),
    Cookie: `csrf_token=${csrfCookie}`,
  };

  const loginResponse = await request("POST", loginUrl, {
    headers: loginHeaders,
    body: loginBody,
  });

  const sessionCookie = getCookie(
    loginResponse.res.headers["set-cookie"],
    process.env.SESSION_COOKIE_NAME || "erp_session"
  );
  if (!sessionCookie) {
    throw new Error("Session cookie not set. Check credentials.");
  }

  const voucherBody = JSON.stringify({
    voucher_type_code: "CASH_VOUCHER",
    voucher_no: 1,
    voucher_date: "2026-01-17",
    remarks: "Test voucher",
    lines: [
      {
        line_kind: "ACCOUNT",
        account_id: accountId,
        qty: 0,
        rate: 0,
        amount: 1000,
        meta: {},
      },
    ],
  });

  const voucherHeaders = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(voucherBody),
    "x-csrf-token": csrfCookie,
    Cookie: `csrf_token=${csrfCookie}; ${process.env.SESSION_COOKIE_NAME || "erp_session"}=${sessionCookie}`,
  };

  const voucherResponse = await request("POST", `${BASE_URL}/vouchers`, {
    headers: voucherHeaders,
    body: voucherBody,
  });

  console.log(voucherResponse.data);
};

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
