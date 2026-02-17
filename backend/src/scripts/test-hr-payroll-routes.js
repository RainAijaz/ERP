require("dotenv").config();

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const cookieRaw = process.env.SESSION_COOKIE || "";
const sessionCookieName = process.env.SESSION_COOKIE_NAME || "erp_session";
let cookie = cookieRaw;
if (cookieRaw && !cookieRaw.includes("=")) {
  cookie = `${sessionCookieName}=${cookieRaw}`;
}
const doPost = process.env.DO_POST === "1";
const doCsrfTest = process.env.DO_CSRF_TEST !== "0";
const doEdgeCases = process.env.DO_EDGE_CASES === "1";
const doRoleTests = process.env.DO_ROLE_TESTS === "1";
const doDeepPageChecks = process.env.DO_DEEP_PAGE_CHECKS !== "0";
const authUsername = process.env.AUTH_USERNAME || process.env.E2E_ADMIN_USER || "";
const authPassword = process.env.AUTH_PASSWORD || process.env.E2E_ADMIN_PASSWORD || process.env.E2E_ADMIN_PASS || "";
const roleDirectUsername = process.env.ROLE_DIRECT_USERNAME || "";
const roleDirectPassword = process.env.ROLE_DIRECT_PASSWORD || "";
const roleQueuedUsername = process.env.ROLE_QUEUED_USERNAME || "";
const roleQueuedPassword = process.env.ROLE_QUEUED_PASSWORD || "";
const roleDeniedUsername = process.env.ROLE_DENIED_USERNAME || "";
const roleDeniedPassword = process.env.ROLE_DENIED_PASSWORD || "";
const knex = require("knex")(require("../../knexfile").development);
const cookieJar = new Map();

const seedCookieJar = () => {
  if (!cookie) return;
  String(cookie)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const idx = pair.indexOf("=");
      if (idx <= 0) return;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (!name || !value) return;
      cookieJar.set(name, value);
    });
};

const cookieHeaderFromJar = () =>
  Array.from(cookieJar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

const hasSessionCookie = () => Boolean(cookieJar.get(sessionCookieName));

const pages = [
  {
    path: "/hr-payroll/employees",
    type: "screen",
    checks: ["data-table", "data-modal", "data-page-size"],
    deepChecks: [
      'data-search-input',
      'data-status-filter',
      'data-filter-apply',
      'data-filter-clear',
      'data-filter-toggle',
      'data-filter-panel',
      'data-confirm-modal',
      'data-modal-form',
      'name="_csrf"',
      'data-page-size',
      'name="department_id"',
      'name="payroll_type"',
    ],
  },
  {
    path: "/hr-payroll/labours",
    type: "screen",
    checks: ["data-table", "data-modal", "data-page-size"],
    deepChecks: [
      'data-search-input',
      'data-status-filter',
      'data-filter-apply',
      'data-filter-clear',
      'data-filter-toggle',
      'data-filter-panel',
      'data-confirm-modal',
      'data-modal-form',
      'name="_csrf"',
      'data-page-size',
      'name="production_category"',
      'name="dept_ids"',
      'name="branch_ids"',
    ],
  },
  {
    path: "/hr-payroll/employees/commissions",
    type: "screen",
    checks: ["data-table", "data-modal", "data-page-size"],
    deepChecks: [
      'data-search-input',
      'data-status-filter',
      'data-filter-apply',
      'data-filter-clear',
      'data-filter-toggle',
      'data-filter-panel',
      'data-confirm-modal',
      'data-modal-form',
      'name="_csrf"',
      'data-page-size',
      'name="employee_id"',
      'name="apply_on"',
      'name="commission_basis"',
      'name="value"',
    ],
  },
  {
    path: "/hr-payroll/employees/allowances",
    type: "screen",
    checks: ["data-table", "data-modal", "data-page-size"],
    deepChecks: [
      'data-search-input',
      'data-status-filter',
      'data-filter-apply',
      'data-filter-clear',
      'data-filter-toggle',
      'data-filter-panel',
      'data-confirm-modal',
      'data-modal-form',
      'name="_csrf"',
      'data-page-size',
      'name="employee_id"',
      'name="allowance_type"',
      'name="amount_type"',
      'name="frequency"',
    ],
  },
  {
    path: "/hr-payroll/labours/rates",
    type: "screen",
    checks: ["data-table", "data-modal", "data-page-size"],
    deepChecks: [
      'data-search-input',
      'data-status-filter',
      'data-filter-apply',
      'data-filter-clear',
      'data-filter-toggle',
      'data-filter-panel',
      'data-confirm-modal',
      'data-modal-form',
      'name="_csrf"',
      'data-page-size',
      'name="apply_on"',
      'name="rate_type"',
      'name="rate_value"',
      'name="dept_id"',
    ],
  },
];

const redirects = [
  { path: "/master-data/hr-payroll/employees", location: "/hr-payroll/employees" },
  { path: "/master-data/hr-payroll/labours", location: "/hr-payroll/labours" },
  { path: "/master-data/hr-payroll/commission", location: "/hr-payroll/commission" },
  { path: "/master-data/hr-payroll/allowances", location: "/hr-payroll/allowances" },
  { path: "/master-data/hr-payroll/labour-rates", location: "/hr-payroll/labour-rates" },
  { path: "/hr-payroll/commission", location: "/hr-payroll/employees/commissions" },
  { path: "/hr-payroll/allowances", location: "/hr-payroll/employees/allowances" },
  { path: "/hr-payroll/labour-rates", location: "/hr-payroll/labours/rates" },
];

const extractCsrf = (html) => {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/i);
  return match ? match[1] : "";
};

const uniqueDigits = (size) => {
  const raw = Date.now().toString();
  if (raw.length >= size) return raw.slice(-size);
  return raw.padStart(size, "0");
};

const buildCnic13 = (prefix5, suffix3) => `${prefix5}${uniqueDigits(5)}${suffix3}`;

const buildPhone11 = () => `03${uniqueDigits(9)}`;

const extractOptions = (html, name) => {
  const selectMatch = html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)<\\/select>`, "i"));
  if (!selectMatch) return [];
  const options = [];
  const optionRegex = /<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/gi;
  let match;
  while ((match = optionRegex.exec(selectMatch[1]))) {
    if (match[1].trim()) options.push({ value: match[1].trim(), label: match[2].trim() });
  }
  return options;
};

const parseButtonAttributes = (buttonHtml) => {
  const attrs = {};
  const attrRegex = /([a-z0-9_-]+)="([^"]*)"/gi;
  let match;
  while ((match = attrRegex.exec(buttonHtml))) {
    attrs[match[1]] = match[2];
  }
  return attrs;
};

const findRowIdByCode = (html, code) => {
  const buttonRegex = /<button[^>]*data-edit[^>]*>/gi;
  let match;
  while ((match = buttonRegex.exec(html))) {
    const attrs = parseButtonAttributes(match[0]);
    if ((attrs["data-code"] || "").toLowerCase() === code.toLowerCase()) {
      return attrs["data-id"] || "";
    }
  }
  return "";
};

const splitCombinedSetCookie = (header) => {
  if (!header) return [];
  return String(header).split(/,(?=\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=)/g);
};

const parseSetCookies = (res) => {
  const fromGetSetCookie = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : null;
  if (fromGetSetCookie && fromGetSetCookie.length) return fromGetSetCookie;
  const single = res.headers.get("set-cookie");
  return single ? splitCombinedSetCookie(single) : [];
};

const decodeCookieValue = (value) => {
  try {
    return decodeURIComponent(value || "");
  } catch (err) {
    return value || "";
  }
};

const extractFlashErrorFromResponse = (res, prefix) => {
  const setCookies = parseSetCookies(res);
  const flashCookie = setCookies.find((header) => String(header).includes(`${prefix}=`));
  if (!flashCookie) return "";
  const first = String(flashCookie).split(";")[0] || "";
  const idx = first.indexOf("=");
  if (idx <= 0) return "";
  const rawValue = first.slice(idx + 1).trim();
  const decoded = decodeCookieValue(rawValue);
  try {
    const payload = JSON.parse(decoded);
    return payload?.error || "";
  } catch (err) {
    return "";
  }
};

const updateCookieJar = (res) => {
  const setCookies = parseSetCookies(res);
  for (const header of setCookies) {
    const first = String(header).split(";")[0] || "";
    const idx = first.indexOf("=");
    if (idx <= 0) continue;
    const key = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (!key) continue;
    if (value === "") {
      cookieJar.delete(key);
    } else {
      cookieJar.set(key, value);
    }
  }
};

const request = async (path, options = {}) => {
  try {
    const jarCookie = cookieHeaderFromJar();
    const cookieHeader = jarCookie || cookie;
    const requestOptions = {
      redirect: "manual",
      ...options,
    };
    const mergedHeaders = {
      ...(options.headers || {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };
    requestOptions.headers = mergedHeaders;
    const res = await fetch(`${baseUrl}${path}`, {
      ...requestOptions,
    });
    updateCookieJar(res);
    return res;
  } catch (err) {
    const causeCode = err?.cause?.code || "";
    throw new Error(`fetch failed (${causeCode || "no-code"}) for ${baseUrl}${path}`);
  }
};

const requestWithCookie = async (cookieHeader, path, options = {}) => {
  const requestOptions = {
    redirect: "manual",
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  };
  const res = await fetch(`${baseUrl}${path}`, requestOptions);
  return res;
};

const getCookieValue = (setCookies, name) => {
  for (const header of setCookies) {
    const first = String(header).split(";")[0] || "";
    const idx = first.indexOf("=");
    if (idx <= 0) continue;
    const key = first.slice(0, idx).trim();
    const value = first.slice(idx + 1).trim();
    if (key === name && value) return value;
  }
  return "";
};

const loginForSessionCookie = async () => {
  if (!authUsername || !authPassword) return false;
  const body = new URLSearchParams({ username: authUsername, password: authPassword }).toString();
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const setCookies = parseSetCookies(res);
  const token = getCookieValue(setCookies, sessionCookieName);
  if (!token) return false;
  cookie = `${sessionCookieName}=${token}`;
  seedCookieJar();
  return true;
};

const loginWithCredentials = async (username, password) => {
  if (!username || !password) return null;
  const body = new URLSearchParams({ username, password }).toString();
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const setCookies = parseSetCookies(res);
  const token = getCookieValue(setCookies, sessionCookieName);
  if (!token) return null;
  return `${sessionCookieName}=${token}`;
};

const assertPage = async ({ path, checks }) => {
  const res = await request(path, { method: "GET" });
  if (!(res.status >= 200 && res.status < 400)) return { ok: false, message: `GET ${path} -> ${res.status}` };
  const html = await res.text();
  const missing = checks.filter((needle) => !html.includes(needle));
  if (missing.length) return { ok: false, message: `GET ${path} missing ${missing.join(", ")}` };
  return { ok: true, html };
};

const runDeepChecks = (path, html, deepChecks = []) => {
  if (!deepChecks.length) return [];
  return deepChecks.filter((needle) => !html.includes(needle)).map((needle) => `GET ${path} missing deep-check ${needle}`);
};

const assertRedirect = async ({ path, location }) => {
  const res = await request(path, { method: "GET" });
  const got = res.headers.get("location");
  const ok = res.status >= 300 && res.status < 400 && got === location;
  return {
    ok,
    message: `GET ${path} -> ${res.status} ${got || ""}`,
  };
};

const runEmployeePostScenario = async () => {
  const getRes = await request("/hr-payroll/employees", { method: "GET" });
  const html = await getRes.text();
  const csrf = extractCsrf(html);
  const departments = extractOptions(html, "department_id");
  const branches = extractOptions(html, "branch_ids");
  const suffix = Date.now().toString().slice(-6);
  const code = `E2EEMP${suffix}`;
  const name = `E2E Employee ${suffix}`;
  const cnic = buildCnic13("35202", "111");
  const phone = buildPhone11();

  const payload = new URLSearchParams({
    _csrf: csrf,
    code,
    name,
    cnic,
    phone,
    department_id: departments[0] ? departments[0].value : "",
    designation: "Sales Officer",
    payroll_type: "MONTHLY",
    basic_salary: "25000",
    branch_ids: branches[0] ? branches[0].value : "",
    status: "active",
  });

  const createRes = await request("/hr-payroll/employees", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
  });
  const createOk = createRes.status >= 200 && createRes.status < 400;
  const createLocation = createRes.headers.get("location") || "";
  const createFlashError = extractFlashErrorFromResponse(createRes, "hr_hr_payroll_employees_flash");

  const inserted = await knex("erp.employees").select("id").where({ name }).orderBy("id", "desc").first();
  const foundId = inserted?.id ? String(inserted.id) : "";
  let queuedId = null;
  if (!foundId) {
    const queued = await knex("erp.approval_request")
      .select("id")
      .where({ entity_type: "EMPLOYEE", status: "PENDING" })
      .whereRaw("(new_value ->> 'code') = ?", [code])
      .orderBy("id", "desc")
      .first();
    queuedId = queued?.id || null;
  }

  let csrfOk = true;
  if (doCsrfTest) {
    const csrfPayload = new URLSearchParams(payload.toString());
    csrfPayload.delete("_csrf");
    const csrfRes = await request("/hr-payroll/employees", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: csrfPayload.toString(),
    });
    csrfOk = [403, 400].includes(csrfRes.status);
  }

  let editOk = true;
  let toggleOk = true;
  let deleteOk = true;
  if (foundId) {
    const editPayload = new URLSearchParams({
      _csrf: csrf,
      name: `${name} Updated`,
      name_ur: "",
      cnic,
      phone,
      department_id: departments[0] ? departments[0].value : "",
      designation: "Sales Officer",
      payroll_type: "MONTHLY",
      basic_salary: "26000",
      branch_ids: branches[0] ? branches[0].value : "",
      status: "active",
    });
    const editRes = await request(`/hr-payroll/employees/${foundId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: editPayload.toString(),
    });
    const updated = await knex("erp.employees").select("name").where({ id: Number(foundId) }).first();
    editOk = editRes.status >= 200 && editRes.status < 400 && (updated?.name || "") === `${name} Updated`;

    const toggleRes = await request(`/hr-payroll/employees/${foundId}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const toggled = await knex("erp.employees").select("status").where({ id: Number(foundId) }).first();
    toggleOk = toggleRes.status >= 200 && toggleRes.status < 400 && String(toggled?.status || "").toLowerCase() === "inactive";

    const deleteRes = await request(`/hr-payroll/employees/${foundId}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const deleted = await knex("erp.employees").select("id").where({ id: Number(foundId) }).first();
    deleteOk = deleteRes.status >= 200 && deleteRes.status < 400 && !deleted;
  }

  const directOrQueued = Boolean(foundId) || Boolean(queuedId);
  if (!directOrQueued) {
    console.log(
      `DEBUG employees create status=${createRes.status} location=${createLocation} foundId=${foundId || "none"} queuedId=${queuedId || "none"} flashError=${createFlashError || "none"}`,
    );
  }
  return createOk && directOrQueued && csrfOk && editOk && toggleOk && deleteOk;
};

const runLabourPostScenario = async () => {
  const getRes = await request("/hr-payroll/labours", { method: "GET" });
  const html = await getRes.text();
  const csrf = extractCsrf(html);
  const departments = extractOptions(html, "dept_ids");
  const branches = extractOptions(html, "branch_ids");
  const suffix = Date.now().toString().slice(-6);
  const code = `E2ELAB${suffix}`;
  const name = `E2E Labour ${suffix}`;
  const cnic = buildCnic13("35202", "222");
  const phone = buildPhone11();

  const payload = new URLSearchParams({
    _csrf: csrf,
    code,
    name,
    cnic,
    phone,
    production_category: "finished",
    dept_ids: departments[0] ? departments[0].value : "",
    branch_ids: branches[0] ? branches[0].value : "",
    status: "active",
  });

  const createRes = await request("/hr-payroll/labours", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
  });
  const createOk = createRes.status >= 200 && createRes.status < 400;
  const createLocation = createRes.headers.get("location") || "";
  const createFlashError = extractFlashErrorFromResponse(createRes, "hr_hr_payroll_labours_flash");

  const inserted = await knex("erp.labours").select("id").where({ name }).orderBy("id", "desc").first();
  const foundId = inserted?.id ? String(inserted.id) : "";
  let queuedId = null;
  if (!foundId) {
    const queued = await knex("erp.approval_request")
      .select("id")
      .where({ entity_type: "LABOUR", status: "PENDING" })
      .whereRaw("(new_value ->> 'code') = ?", [code])
      .orderBy("id", "desc")
      .first();
    queuedId = queued?.id || null;
  }

  let csrfOk = true;
  if (doCsrfTest) {
    const csrfPayload = new URLSearchParams(payload.toString());
    csrfPayload.delete("_csrf");
    const csrfRes = await request("/hr-payroll/labours", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: csrfPayload.toString(),
    });
    csrfOk = [403, 400].includes(csrfRes.status);
  }

  let editOk = true;
  let toggleOk = true;
  let deleteOk = true;
  if (foundId) {
    const editPayload = new URLSearchParams({
      _csrf: csrf,
      name: `${name} Updated`,
      name_ur: "",
      cnic,
      phone,
      production_category: "finished",
      dept_ids: departments[0] ? departments[0].value : "",
      branch_ids: branches[0] ? branches[0].value : "",
      status: "active",
    });
    const editRes = await request(`/hr-payroll/labours/${foundId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: editPayload.toString(),
    });
    const updated = await knex("erp.labours").select("name").where({ id: Number(foundId) }).first();
    editOk = editRes.status >= 200 && editRes.status < 400 && (updated?.name || "") === `${name} Updated`;

    const toggleRes = await request(`/hr-payroll/labours/${foundId}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const toggled = await knex("erp.labours").select("status").where({ id: Number(foundId) }).first();
    toggleOk = toggleRes.status >= 200 && toggleRes.status < 400 && String(toggled?.status || "").toLowerCase() === "inactive";

    const deleteRes = await request(`/hr-payroll/labours/${foundId}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const deleted = await knex("erp.labours").select("id").where({ id: Number(foundId) }).first();
    deleteOk = deleteRes.status >= 200 && deleteRes.status < 400 && !deleted;
  }

  const directOrQueued = Boolean(foundId) || Boolean(queuedId);
  if (!directOrQueued) {
    console.log(
      `DEBUG labours create status=${createRes.status} location=${createLocation} foundId=${foundId || "none"} queuedId=${queuedId || "none"} flashError=${createFlashError || "none"}`,
    );
  }
  return createOk && directOrQueued && csrfOk && editOk && toggleOk && deleteOk;
};

const runCommissionPostScenario = async () => {
  const getRes = await request("/hr-payroll/employees/commissions", { method: "GET" });
  const html = await getRes.text();
  const csrf = extractCsrf(html);
  const employees = extractOptions(html, "employee_id");
  if (!employees.length) {
    console.log("DEBUG commissions create skipped no employee options available");
    return false;
  }
  const marker = Number(uniqueDigits(4));
  const valueStr = (10 + (marker % 70) / 100).toFixed(2);
  const payload = new URLSearchParams({
    _csrf: csrf,
    employee_id: employees[0].value,
    apply_on: "ALL",
    commission_basis: "NET_SALES_PERCENT",
    value: valueStr,
  });

  const createRes = await request("/hr-payroll/employees/commissions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
  });
  const createLocation = createRes.headers.get("location") || "";
  const createFlashError = extractFlashErrorFromResponse(createRes, "hr_hr_payroll_commissions_flash");

  const inserted = await knex("erp.employee_commission_rules")
    .select("id")
    .where({
      employee_id: Number(employees[0].value),
      apply_on: "ALL",
      commission_basis: "NET_SALES_PERCENT",
      value_type: "PERCENT",
      status: "active",
    })
    .whereRaw("value = ?", [Number(valueStr)])
    .orderBy("id", "desc")
    .first();

  let queuedId = null;
  if (!inserted?.id) {
    const queued = await knex("erp.approval_request")
      .select("id")
      .where({ status: "PENDING" })
      .whereRaw("new_value ->> 'employee_id' = ?", [String(employees[0].value)])
      .whereRaw("new_value ->> 'apply_on' = 'ALL'")
      .whereRaw("new_value ->> 'commission_basis' = 'NET_SALES_PERCENT'")
      .whereRaw("new_value ->> 'value' = ?", [valueStr])
      .orderBy("id", "desc")
      .first();
    queuedId = queued?.id || null;
  }

  let editOk = true;
  let toggleOk = true;
  let deleteOk = true;
  if (inserted?.id) {
    const editValue = (Number(valueStr) + 1).toFixed(2);
    const editPayload = new URLSearchParams({
      _csrf: csrf,
      employee_id: employees[0].value,
      apply_on: "ALL",
      commission_basis: "FIXED_PER_INVOICE",
      value: editValue,
      status: "active",
    });
    const editRes = await request(`/hr-payroll/employees/commissions/${inserted.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: editPayload.toString(),
    });
    const edited = await knex("erp.employee_commission_rules").select("commission_basis", "value_type", "value").where({ id: inserted.id }).first();
    editOk =
      editRes.status >= 200 &&
      editRes.status < 400 &&
      edited?.commission_basis === "FIXED_PER_INVOICE" &&
      edited?.value_type === "FIXED" &&
      Number(edited?.value || 0) === Number(editValue);

    const toggleRes = await request(`/hr-payroll/employees/commissions/${inserted.id}/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const toggled = await knex("erp.employee_commission_rules").select("status").where({ id: inserted.id }).first();
    toggleOk = toggleRes.status >= 200 && toggleRes.status < 400 && String(toggled?.status || "").toLowerCase() === "inactive";

    const deleteRes = await request(`/hr-payroll/employees/commissions/${inserted.id}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    const deleted = await knex("erp.employee_commission_rules").select("id").where({ id: inserted.id }).first();
    deleteOk = deleteRes.status >= 200 && deleteRes.status < 400 && !deleted;
  }

  const createOk = createRes.status >= 200 && createRes.status < 400;
  const directOrQueued = Boolean(inserted?.id) || Boolean(queuedId);
  if (!directOrQueued) {
    console.log(
      `DEBUG commissions create status=${createRes.status} location=${createLocation} insertedId=${inserted?.id || "none"} queuedId=${queuedId || "none"} flashError=${createFlashError || "none"}`,
    );
  }
  return createOk && directOrQueued && editOk && toggleOk && deleteOk;
};

const runAllowancePostScenario = async () => {
  const getRes = await request("/hr-payroll/employees/allowances", { method: "GET" });
  const html = await getRes.text();
  const csrf = extractCsrf(html);
  const employees = extractOptions(html, "employee_id");
  if (!employees.length) {
    console.log("DEBUG allowances create skipped no employee options available");
    return false;
  }
  const marker = uniqueDigits(6);
  const allowanceType = `E2E_ALLOW_${marker}`;
  const payload = new URLSearchParams({
    _csrf: csrf,
    employee_id: employees[0].value,
    allowance_type: allowanceType,
    amount_type: "FIXED",
    amount: "1100.00",
    frequency: "MONTHLY",
  });
  const createRes = await request("/hr-payroll/employees/allowances", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
  });
  const inserted = await knex("erp.employee_allowance_rules")
    .select("id")
    .where({ employee_id: Number(employees[0].value), allowance_type: allowanceType })
    .orderBy("id", "desc")
    .first();
  if (!inserted?.id) return false;

  const editPayload = new URLSearchParams({
    _csrf: csrf,
    employee_id: employees[0].value,
    allowance_type: allowanceType,
    amount_type: "PERCENT_BASIC",
    amount: "5.00",
    frequency: "DAILY",
    status: "active",
  });
  const editRes = await request(`/hr-payroll/employees/allowances/${inserted.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: editPayload.toString(),
  });
  const edited = await knex("erp.employee_allowance_rules").select("amount_type", "amount", "frequency").where({ id: inserted.id }).first();
  const editOk =
    editRes.status >= 200 &&
    editRes.status < 400 &&
    edited?.amount_type === "PERCENT_BASIC" &&
    Number(edited?.amount || 0) === 5 &&
    edited?.frequency === "DAILY";

  const toggleRes = await request(`/hr-payroll/employees/allowances/${inserted.id}/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  const toggled = await knex("erp.employee_allowance_rules").select("status").where({ id: inserted.id }).first();
  const toggleOk = toggleRes.status >= 200 && toggleRes.status < 400 && String(toggled?.status || "").toLowerCase() === "inactive";

  const deleteRes = await request(`/hr-payroll/employees/allowances/${inserted.id}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  const deleted = await knex("erp.employee_allowance_rules").select("id").where({ id: inserted.id }).first();
  const deleteOk = deleteRes.status >= 200 && deleteRes.status < 400 && !deleted;

  return createRes.status >= 200 && createRes.status < 400 && editOk && toggleOk && deleteOk;
};

const runLabourRatePostScenario = async () => {
  const getRes = await request("/hr-payroll/labours/rates", { method: "GET" });
  const html = await getRes.text();
  const csrf = extractCsrf(html);
  const depts = extractOptions(html, "dept_id");
  if (!depts.length) {
    console.log("DEBUG labour-rates create skipped no dept options available");
    return false;
  }
  const marker = Number(uniqueDigits(4));
  const rateValue = (12 + (marker % 25) / 100).toFixed(2);
  const payload = new URLSearchParams({
    _csrf: csrf,
    applies_to_all_labours: "on",
    dept_id: depts[0].value,
    apply_on: "FLAT",
    rate_type: "PER_PAIR",
    rate_value: rateValue,
  });
  const createRes = await request("/hr-payroll/labours/rates", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
  });
  const inserted = await knex("erp.labour_rate_rules")
    .select("id")
    .where({
      dept_id: Number(depts[0].value),
      apply_on: "FLAT",
      rate_type: "PER_PAIR",
    })
    .whereNull("labour_id")
    .whereRaw("rate_value = ?", [Number(rateValue)])
    .orderBy("id", "desc")
    .first();
  if (!inserted?.id) return false;

  const editRate = (Number(rateValue) + 1).toFixed(2);
  const editPayload = new URLSearchParams({
    _csrf: csrf,
    applies_to_all_labours: "on",
    dept_id: depts[0].value,
    apply_on: "FLAT",
    rate_type: "PER_DOZEN",
    rate_value: editRate,
    status: "active",
  });
  const editRes = await request(`/hr-payroll/labours/rates/${inserted.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: editPayload.toString(),
  });
  const edited = await knex("erp.labour_rate_rules").select("rate_type", "rate_value").where({ id: inserted.id }).first();
  const editOk =
    editRes.status >= 200 &&
    editRes.status < 400 &&
    edited?.rate_type === "PER_DOZEN" &&
    Number(edited?.rate_value || 0) === Number(editRate);

  const toggleRes = await request(`/hr-payroll/labours/rates/${inserted.id}/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  const toggled = await knex("erp.labour_rate_rules").select("status").where({ id: inserted.id }).first();
  const toggleOk = toggleRes.status >= 200 && toggleRes.status < 400 && String(toggled?.status || "").toLowerCase() === "inactive";

  const deleteRes = await request(`/hr-payroll/labours/rates/${inserted.id}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  const deleted = await knex("erp.labour_rate_rules").select("id").where({ id: inserted.id }).first();
  const deleteOk = deleteRes.status >= 200 && deleteRes.status < 400 && !deleted;

  return createRes.status >= 200 && createRes.status < 400 && editOk && toggleOk && deleteOk;
};

const runEmployeesInvalidCnicScenario = async () => {
  const getRes = await request("/hr-payroll/employees", { method: "GET" });
  if (getRes.status >= 300 && getRes.status < 400 && (getRes.headers.get("location") || "").includes("/auth/login")) return false;
  const html = await getRes.text();
  const csrf = extractCsrf(html);
  const departments = extractOptions(html, "department_id");
  const branches = extractOptions(html, "branch_ids");
  const suffix = Date.now().toString().slice(-6);
  const code = `E2EBAD${suffix}`;
  const payload = new URLSearchParams({
    _csrf: csrf,
    code,
    name: `Bad CNIC ${suffix}`,
    cnic: "123",
    phone: buildPhone11(),
    department_id: departments[0] ? departments[0].value : "",
    designation: "Sales Officer",
    payroll_type: "MONTHLY",
    basic_salary: "25000",
    branch_ids: branches[0] ? branches[0].value : "",
    status: "active",
  });
  const createRes = await request("/hr-payroll/employees", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
  });
  const location = createRes.headers.get("location") || "";
  const listRes = await request("/hr-payroll/employees", { method: "GET" });
  const listHtml = await listRes.text();
  const foundId = findRowIdByCode(listHtml, code);
  return createRes.status >= 300 && createRes.status < 400 && location.includes("/hr-payroll/employees") && !foundId;
};

const runEmployeesDuplicateScenario = async () => {
  const getRes = await request("/hr-payroll/employees", { method: "GET" });
  const html = await getRes.text();
  const csrf = extractCsrf(html);
  const departments = extractOptions(html, "department_id");
  const branches = extractOptions(html, "branch_ids");
  if (!departments.length || !branches.length) return false;
  const marker = uniqueDigits(6);
  const cnic = `35202${uniqueDigits(5)}909`;
  const phone = `03${uniqueDigits(9)}`;
  const name1 = `E2E Dup Emp A ${marker}`;
  const name2 = `E2E Dup Emp B ${marker}`;
  const payload1 = new URLSearchParams({
    _csrf: csrf,
    name: name1,
    cnic,
    phone,
    department_id: departments[0].value,
    payroll_type: "MONTHLY",
    basic_salary: "22000",
    branch_ids: branches[0].value,
  });
  const payload2 = new URLSearchParams({
    _csrf: csrf,
    name: name2,
    cnic,
    phone: `03${uniqueDigits(8)}8`,
    department_id: departments[0].value,
    payroll_type: "MONTHLY",
    basic_salary: "22000",
    branch_ids: branches[0].value,
  });
  const create1 = await request("/hr-payroll/employees", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: payload1.toString() });
  const first = await knex("erp.employees").select("id").where({ name: name1 }).orderBy("id", "desc").first();
  if (!first?.id) return false;
  const create2 = await request("/hr-payroll/employees", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: payload2.toString() });
  const second = await knex("erp.employees").select("id").where({ name: name2 }).first();
  const flashError = extractFlashErrorFromResponse(create2, "hr_hr_payroll_employees_flash");
  await request(`/hr-payroll/employees/${first.id}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  return create1.status >= 200 && create1.status < 400 && !second && Boolean(flashError);
};

const runLaboursDuplicateScenario = async () => {
  const getRes = await request("/hr-payroll/labours", { method: "GET" });
  const html = await getRes.text();
  const csrf = extractCsrf(html);
  const departments = extractOptions(html, "dept_ids");
  const branches = extractOptions(html, "branch_ids");
  if (!departments.length || !branches.length) return false;
  const marker = uniqueDigits(6);
  const cnic = `35202${uniqueDigits(5)}808`;
  const name1 = `E2E Dup Lab A ${marker}`;
  const name2 = `E2E Dup Lab B ${marker}`;
  const payload1 = new URLSearchParams({
    _csrf: csrf,
    name: name1,
    cnic,
    phone: `03${uniqueDigits(9)}`,
    production_category: "finished",
    dept_ids: departments[0].value,
    branch_ids: branches[0].value,
  });
  const payload2 = new URLSearchParams({
    _csrf: csrf,
    name: name2,
    cnic,
    phone: `03${uniqueDigits(8)}7`,
    production_category: "finished",
    dept_ids: departments[0].value,
    branch_ids: branches[0].value,
  });
  await request("/hr-payroll/labours", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: payload1.toString() });
  const first = await knex("erp.labours").select("id").where({ name: name1 }).orderBy("id", "desc").first();
  if (!first?.id) return false;
  const create2 = await request("/hr-payroll/labours", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: payload2.toString() });
  const second = await knex("erp.labours").select("id").where({ name: name2 }).first();
  const flashError = extractFlashErrorFromResponse(create2, "hr_hr_payroll_labours_flash");
  await request(`/hr-payroll/labours/${first.id}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  return !second && Boolean(flashError);
};

const runCommissionDuplicateScenario = async () => {
  const getRes = await request("/hr-payroll/employees/commissions", { method: "GET" });
  const html = await getRes.text();
  const csrf = extractCsrf(html);
  const employees = extractOptions(html, "employee_id");
  if (!employees.length) return false;
  const payload = new URLSearchParams({
    _csrf: csrf,
    employee_id: employees[0].value,
    apply_on: "ALL",
    commission_basis: "NET_SALES_PERCENT",
    value: "9.99",
  });
  await request("/hr-payroll/employees/commissions", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: payload.toString() });
  const first = await knex("erp.employee_commission_rules")
    .select("id")
    .where({ employee_id: Number(employees[0].value), apply_on: "ALL", commission_basis: "NET_SALES_PERCENT", value: 9.99 })
    .orderBy("id", "desc")
    .first();
  if (!first?.id) return false;
  const create2 = await request("/hr-payroll/employees/commissions", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: payload.toString() });
  const flashError = extractFlashErrorFromResponse(create2, "hr_hr_payroll_commissions_flash");
  await request(`/hr-payroll/employees/commissions/${first.id}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  return Boolean(flashError);
};

const runAllowanceDuplicateScenario = async () => {
  const getRes = await request("/hr-payroll/employees/allowances", { method: "GET" });
  const html = await getRes.text();
  const csrf = extractCsrf(html);
  const employees = extractOptions(html, "employee_id");
  if (!employees.length) return false;
  const type = `E2E_DUP_ALLOW_${uniqueDigits(6)}`;
  const payload = new URLSearchParams({
    _csrf: csrf,
    employee_id: employees[0].value,
    allowance_type: type,
    amount_type: "FIXED",
    amount: "100",
    frequency: "MONTHLY",
  });
  await request("/hr-payroll/employees/allowances", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: payload.toString() });
  const first = await knex("erp.employee_allowance_rules").select("id").where({ employee_id: Number(employees[0].value), allowance_type: type }).first();
  if (!first?.id) return false;
  const create2 = await request("/hr-payroll/employees/allowances", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: payload.toString() });
  const flashError = extractFlashErrorFromResponse(create2, "hr_hr_payroll_allowances_flash");
  await request(`/hr-payroll/employees/allowances/${first.id}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  return Boolean(flashError);
};

const runLabourRateDuplicateScenario = async () => {
  const getRes = await request("/hr-payroll/labours/rates", { method: "GET" });
  const html = await getRes.text();
  const csrf = extractCsrf(html);
  const depts = extractOptions(html, "dept_id");
  if (!depts.length) return false;
  const payload = new URLSearchParams({
    _csrf: csrf,
    applies_to_all_labours: "on",
    dept_id: depts[0].value,
    apply_on: "FLAT",
    rate_type: "PER_PAIR",
    rate_value: "7.77",
  });
  await request("/hr-payroll/labours/rates", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: payload.toString() });
  const first = await knex("erp.labour_rate_rules")
    .select("id")
    .where({ dept_id: Number(depts[0].value), apply_on: "FLAT", rate_type: "PER_PAIR", rate_value: 7.77 })
    .whereNull("labour_id")
    .orderBy("id", "desc")
    .first();
  if (!first?.id) return false;
  const create2 = await request("/hr-payroll/labours/rates", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: payload.toString() });
  const flashError = extractFlashErrorFromResponse(create2, "hr_hr_payroll_labour_rates_flash");
  await request(`/hr-payroll/labours/rates/${first.id}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ _csrf: csrf }).toString(),
  });
  return Boolean(flashError);
};

const classifyEmployeeCreateOutcome = async (cookieHeader, code) => {
  const listRes = await requestWithCookie(cookieHeader, "/hr-payroll/employees", { method: "GET" });
  const listHtml = await listRes.text();
  const foundId = findRowIdByCode(listHtml, code);
  if (foundId) return { outcome: "direct", foundId, queuedId: null };
  const queued = await knex("erp.approval_request")
    .select("id")
    .where({ entity_type: "EMPLOYEE", status: "PENDING" })
    .whereRaw("(new_value ->> 'code') = ?", [code])
    .orderBy("id", "desc")
    .first();
  if (queued?.id) return { outcome: "queued", foundId: null, queuedId: queued.id };
  return { outcome: "denied", foundId: null, queuedId: null };
};

const runRoleOutcomeScenario = async (label, username, password, expectedOutcome) => {
  const sessionCookie = await loginWithCredentials(username, password);
  if (!sessionCookie) {
    return { ok: false, message: `${label} login failed` };
  }
  const getRes = await requestWithCookie(sessionCookie, "/hr-payroll/employees", { method: "GET" });
  if (getRes.status >= 300 && getRes.status < 400 && (getRes.headers.get("location") || "").includes("/auth/login")) {
    return { ok: expectedOutcome === "denied", message: `${label} denied at GET` };
  }
  if (!(getRes.status >= 200 && getRes.status < 400)) {
    return { ok: false, message: `${label} GET status ${getRes.status}` };
  }
  const html = await getRes.text();
  const csrf = extractCsrf(html);
  const departments = extractOptions(html, "department_id");
  const branches = extractOptions(html, "branch_ids");
  const suffix = Date.now().toString().slice(-6);
  const code = `E2EROLE${suffix}`;
  const payload = new URLSearchParams({
    _csrf: csrf,
    code,
    name: `Role Employee ${suffix}`,
    cnic: buildCnic13("35202", "888"),
    phone: buildPhone11(),
    department_id: departments[0] ? departments[0].value : "",
    designation: "Officer",
    payroll_type: "MONTHLY",
    basic_salary: "22000",
    branch_ids: branches[0] ? branches[0].value : "",
    status: "active",
  });
  const createRes = await requestWithCookie(sessionCookie, "/hr-payroll/employees", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
  });
  const location = createRes.headers.get("location") || "";
  const classified = await classifyEmployeeCreateOutcome(sessionCookie, code);
  if (classified.outcome === "direct" && classified.foundId) {
    await requestWithCookie(sessionCookie, `/hr-payroll/employees/${classified.foundId}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
  }
  if (classified.outcome === "denied") {
    const deniedByResponse = createRes.status === 403 || (createRes.status >= 300 && createRes.status < 400 && location.includes("/auth/login"));
    if (deniedByResponse) return { ok: expectedOutcome === "denied", message: `${label} denied` };
  }
  return {
    ok: classified.outcome === expectedOutcome,
    message: `${label} expected ${expectedOutcome}, got ${classified.outcome} (status=${createRes.status} location=${location || "-"})`,
  };
};

const run = async () => {
  let pass = 0;
  let fail = 0;

  if (!cookie) {
    console.warn("WARN: SESSION_COOKIE not set; authenticated screens may return redirect/401.");
  }
  if (cookieRaw && cookieRaw !== cookie) {
    console.log(`INFO: SESSION_COOKIE had no name; using ${sessionCookieName}=<token> format automatically.`);
  }
  seedCookieJar();

  try {
    const preflight = await request("/", { method: "GET" });
    console.log(`INFO: preflight ${baseUrl}/ -> ${preflight.status}`);
    if (preflight.status === 302 && (!cookie || !hasSessionCookie())) {
      const loggedIn = await loginForSessionCookie();
      if (loggedIn) {
        const preflightAfterLogin = await request("/", { method: "GET" });
        console.log(`INFO: preflight after auth ${baseUrl}/ -> ${preflightAfterLogin.status}`);
      } else if (authUsername || authPassword) {
        console.log(`WARN: auto-login failed for AUTH_USERNAME=${authUsername || "<empty>"}`);
      }
    }
  } catch (err) {
    console.log(`FAIL  preflight -> ${err.message}`);
    console.log("HINT  Start backend server or set BASE_URL correctly before running this script.");
    process.exitCode = 1;
    return;
  }

  for (const page of pages) {
    try {
      const result = await assertPage(page);
      if (result.ok) {
        pass += 1;
        console.log(`OK    ${page.path}`);
        if (doDeepPageChecks) {
          const deepFailures = runDeepChecks(page.path, result.html, page.deepChecks || []);
          if (deepFailures.length) {
            deepFailures.forEach((msg) => console.log(`FAIL  ${msg}`));
            fail += deepFailures.length;
          } else if ((page.deepChecks || []).length) {
            pass += (page.deepChecks || []).length;
            console.log(`OK    ${page.path} deep-checks (${(page.deepChecks || []).length})`);
          }
        }
      } else {
        fail += 1;
        console.log(`FAIL  ${result.message}`);
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  ${page.path} -> ${err.message || err}`);
    }
  }

  for (const redirect of redirects) {
    try {
      const result = await assertRedirect(redirect);
      if (result.ok) {
        pass += 1;
        console.log(`OK    ${redirect.path} redirect`);
      } else {
        fail += 1;
        console.log(`FAIL  ${result.message}`);
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  ${redirect.path} -> ${err.message || err}`);
    }
  }

  if (doPost) {
    try {
      const employeesOk = await runEmployeePostScenario();
      if (employeesOk) {
        pass += 1;
        console.log("OK    employees create/delete/csrf");
      } else {
        fail += 1;
        console.log("FAIL  employees create/delete/csrf");
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  employees post scenario -> ${err.message || err}`);
    }

    try {
      const laboursOk = await runLabourPostScenario();
      if (laboursOk) {
        pass += 1;
        console.log("OK    labours create/delete/csrf");
      } else {
        fail += 1;
        console.log("FAIL  labours create/delete/csrf");
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  labours post scenario -> ${err.message || err}`);
    }

    try {
      const commissionsOk = await runCommissionPostScenario();
      if (commissionsOk) {
        pass += 1;
        console.log("OK    commissions create/edit/deactivate/delete");
      } else {
        fail += 1;
        console.log("FAIL  commissions create/edit/deactivate/delete");
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  commissions post scenario -> ${err.message || err}`);
    }

    try {
      const allowancesOk = await runAllowancePostScenario();
      if (allowancesOk) {
        pass += 1;
        console.log("OK    allowances create/edit/deactivate/delete");
      } else {
        fail += 1;
        console.log("FAIL  allowances create/edit/deactivate/delete");
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  allowances post scenario -> ${err.message || err}`);
    }

    try {
      const labourRatesOk = await runLabourRatePostScenario();
      if (labourRatesOk) {
        pass += 1;
        console.log("OK    labour-rates create/edit/deactivate/delete");
      } else {
        fail += 1;
        console.log("FAIL  labour-rates create/edit/deactivate/delete");
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  labour-rates post scenario -> ${err.message || err}`);
    }
  }

  if (doEdgeCases) {
    try {
      const invalidCnicOk = await runEmployeesInvalidCnicScenario();
      if (invalidCnicOk) {
        pass += 1;
        console.log("OK    employees invalid-cnic validation");
      } else {
        fail += 1;
        console.log("FAIL  employees invalid-cnic validation");
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  employees invalid-cnic scenario -> ${err.message || err}`);
    }

    try {
      const ok = await runEmployeesDuplicateScenario();
      if (ok) {
        pass += 1;
        console.log("OK    employees duplicate-cnic/phone validation");
      } else {
        fail += 1;
        console.log("FAIL  employees duplicate-cnic/phone validation");
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  employees duplicate scenario -> ${err.message || err}`);
    }

    try {
      const ok = await runLaboursDuplicateScenario();
      if (ok) {
        pass += 1;
        console.log("OK    labours duplicate-cnic validation");
      } else {
        fail += 1;
        console.log("FAIL  labours duplicate-cnic validation");
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  labours duplicate scenario -> ${err.message || err}`);
    }

    try {
      const ok = await runCommissionDuplicateScenario();
      if (ok) {
        pass += 1;
        console.log("OK    commissions duplicate-rule validation");
      } else {
        fail += 1;
        console.log("FAIL  commissions duplicate-rule validation");
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  commissions duplicate scenario -> ${err.message || err}`);
    }

    try {
      const ok = await runAllowanceDuplicateScenario();
      if (ok) {
        pass += 1;
        console.log("OK    allowances duplicate-rule validation");
      } else {
        fail += 1;
        console.log("FAIL  allowances duplicate-rule validation");
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  allowances duplicate scenario -> ${err.message || err}`);
    }

    try {
      const ok = await runLabourRateDuplicateScenario();
      if (ok) {
        pass += 1;
        console.log("OK    labour-rates duplicate-rule validation");
      } else {
        fail += 1;
        console.log("FAIL  labour-rates duplicate-rule validation");
      }
    } catch (err) {
      fail += 1;
      console.log(`FAIL  labour-rates duplicate scenario -> ${err.message || err}`);
    }
  }

  if (doRoleTests) {
    const roleCases = [
      { label: "role direct", username: roleDirectUsername, password: roleDirectPassword, expected: "direct" },
      { label: "role queued", username: roleQueuedUsername, password: roleQueuedPassword, expected: "queued" },
      { label: "role denied", username: roleDeniedUsername, password: roleDeniedPassword, expected: "denied" },
    ];
    for (const roleCase of roleCases) {
      if (!roleCase.username || !roleCase.password) {
        console.log(`WARN  ${roleCase.label} skipped (missing env credentials)`);
        continue;
      }
      try {
        const result = await runRoleOutcomeScenario(roleCase.label, roleCase.username, roleCase.password, roleCase.expected);
        if (result.ok) {
          pass += 1;
          console.log(`OK    ${roleCase.label} ${roleCase.expected}`);
        } else {
          fail += 1;
          console.log(`FAIL  ${result.message}`);
        }
      } catch (err) {
        fail += 1;
        console.log(`FAIL  ${roleCase.label} scenario -> ${err.message || err}`);
      }
    }
  }

  console.log(`\nSummary: ${pass} OK, ${fail} failed`);
  await knex.destroy();
  if (fail > 0) process.exitCode = 1;
};

run();
