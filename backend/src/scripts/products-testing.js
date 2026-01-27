/* eslint-disable no-console */
const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const cookie = process.env.SESSION_COOKIE || "";
const authUsername = process.env.AUTH_USERNAME || "";
const authPassword = process.env.AUTH_PASSWORD || "";
const doPost = process.env.DO_POST === "1";

const cookieJar = {};

const loadInitialCookies = () => {
  if (!cookie) return;
  cookie.split(";").forEach((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    if (!name || !rest.length) return;
    cookieJar[name] = rest.join("=");
  });
};

const updateCookies = (setCookieHeaders) => {
  if (!setCookieHeaders) return;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  headers.forEach((header) => {
    if (!header) return;
    const [pair] = header.split(";");
    const [name, ...rest] = pair.trim().split("=");
    if (!name || !rest.length) return;
    cookieJar[name] = rest.join("=");
  });
};

const cookieHeader = () =>
  Object.entries(cookieJar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

const fetchWithCookies = async (path, options = {}) => {
  const url = `${baseUrl}${path}`;
  const headers = {
    ...(options.headers || {}),
    cookie: cookieHeader(),
  };
  const response = await fetch(url, { ...options, headers });
  updateCookies(response.headers.getSetCookie?.() || response.headers.get("set-cookie"));
  return response;
};

const readText = async (res) => {
  const text = await res.text();
  return text || "";
};

const postForm = async (path, body) => {
  const payload = new URLSearchParams();
  Object.entries(body || {}).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => payload.append(key, item));
      return;
    }
    if (value !== undefined && value !== null) {
      payload.append(key, String(value));
    }
  });
  const res = await fetchWithCookies(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
    redirect: "manual",
  });
  return res;
};
const testPage = async (path) => {
  const res = await fetchWithCookies(path);
  const ok = res.ok;
  console.log(`${ok ? "OK" : "ERR"} ${res.status} ${path}`);
  const html = await readText(res);
  return html;
};

const extractCsrf = (html) => {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : "";
};

const fetchHtml = async (path) => {
  const res = await fetchWithCookies(path);
  const html = await readText(res);
  return { res, html };
};

const extractOptions = (html, fieldName) => {
  const selectRegex = new RegExp(`<select[^>]*name="${fieldName}"[^>]*>([\\s\\S]*?)<\\/select>`, "i");
  const selectMatch = html.match(selectRegex);
  if (!selectMatch) return [];
  const options = [];
  const optionRegex = new RegExp('<option[^>]*value="([^"]*)"[^>]*>([\\s\\S]*?)<\\/option>', "gi");
  let match;
  while ((match = optionRegex.exec(selectMatch[1]))) {
    const value = match[1];
    const label = match[2].replace(/<[^>]+>/g, "").trim();
    if (value) {
      options.push({ value, label });
    }
  }
  return options;
};

const extractDataIdByAttr = (html, attrName, attrValue) => {
  const escaped = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forward = new RegExp(`data-id="(\\d+)"[\\s\\S]*?data-${attrName}="${escaped}"`, "i");
  const backward = new RegExp(`data-${attrName}="${escaped}"[\\s\\S]*?data-id="(\\d+)"`, "i");
  const match = html.match(forward) || html.match(backward);
  return match ? Number(match[1]) : null;
};

const loginIfNeeded = async () => {
  if (cookieJar.erp_session) return true;
  if (!authUsername || !authPassword) {
    console.log("Missing SESSION_COOKIE or AUTH_USERNAME/AUTH_PASSWORD.");
    return false;
  }
  const loginUrl = "/auth/login";
  await fetchWithCookies(loginUrl);
  const res = await postForm(loginUrl, {
    username: authUsername,
    password: authPassword,
  });
  const ok = [200, 302].includes(res.status);
  console.log(`${ok ? "LOGIN OK" : "LOGIN ERR"} ${res.status}`);
  return ok;
};

const ensureBasicRow = async (path, matchAttr, matchValue, payloadBuilder) => {
  const { html } = await fetchHtml(path);
  const existingId = extractDataIdByAttr(html, matchAttr, matchValue);
  if (existingId) return existingId;
  const csrf = extractCsrf(html);
  if (!csrf) return null;
  const payload = payloadBuilder(csrf);
  const res = await postForm(path, payload);
  if (![200, 302].includes(res.status)) {
    console.log(`SEED ERR ${res.status} ${path} (${matchAttr}=${matchValue})`);
    return null;
  }
  const { html: htmlAfter } = await fetchHtml(path);
  return extractDataIdByAttr(htmlAfter, matchAttr, matchValue);
};

const ensureBasicData = async () => {
  const uomId = await ensureBasicRow("/master-data/basic-info/units", "code", "PR", (csrf) => ({ _csrf: csrf, code: "PR", name: "PAIRS", name_ur: "PAIRS" }));

  const sizeId = await ensureBasicRow("/master-data/basic-info/sizes", "name", "7/10", (csrf) => ({ _csrf: csrf, name: "7/10", name_ur: "7/10" }));

  const colorId = await ensureBasicRow("/master-data/basic-info/colors", "name", "BLACK", (csrf) => ({ _csrf: csrf, name: "BLACK", name_ur: "BLACK" }));

  const gradeId = await ensureBasicRow("/master-data/basic-info/grades", "name", "A", (csrf) => ({ _csrf: csrf, name: "A", name_ur: "A" }));

  const packingId = await ensureBasicRow("/master-data/basic-info/packing-types", "name", "BOX", (csrf) => ({ _csrf: csrf, name: "BOX", name_ur: "BOX" }));

  const groupId = await ensureBasicRow("/master-data/basic-info/product-groups", "name", "TEST GROUP", (csrf) => ({
    _csrf: csrf,
    name: "TEST GROUP",
    name_ur: "TEST GROUP",
    item_types: ["RM", "SFG", "FG"],
  }));

  let subgroupId = null;
  if (groupId) {
    subgroupId = await ensureBasicRow("/master-data/basic-info/product-subgroups", "name", "TEST SUB", (csrf) => ({
      _csrf: csrf,
      group_id: groupId,
      name: "TEST SUB",
      name_ur: "TEST SUB",
      item_types: ["SFG", "FG"],
    }));
  }

  const typeId = await ensureBasicRow("/master-data/basic-info/product-types", "name", "TEST TYPE", (csrf) => ({ _csrf: csrf, name: "TEST TYPE", name_ur: "TEST TYPE" }));

  return { uomId, sizeId, colorId, gradeId, packingId, groupId, subgroupId, typeId };
};

const createRawMaterial = async (pageHtml, csrf) => {
  const subgroups = extractOptions(pageHtml, "subgroup_id");
  const uoms = extractOptions(pageHtml, "base_uom_id");
  const colors = extractOptions(pageHtml, "color_ids");
  if (!subgroups.length || !uoms.length || !colors.length) {
    console.log("SKIP RM: missing subgroups/uoms/colors");
    return null;
  }
  const code = `rm_test_${Date.now()}`;
  const name = `RM Test ${Date.now()}`;
  const res = await postForm("/master-data/products/raw-materials", {
    _csrf: csrf,
    code,
    name,
    subgroup_id: subgroups[0].value,
    base_uom_id: uoms[0].value,
    min_stock_level: "5",
    color_ids: colors[0].value,
    purchase_rates: "100",
  });
  logResult("raw-materials", res);
  return { code, name };
};

const createSemiFinished = async (pageHtml, csrf) => {
  const groups = extractOptions(pageHtml, "group_id");
  const uoms = extractOptions(pageHtml, "base_uom_id");
  const sizes = extractOptions(pageHtml, "size_ids");
  if (!groups.length || !uoms.length || !sizes.length) {
    console.log("SKIP SFG: missing groups/uoms/sizes");
    return null;
  }
  const code = `sfg_test_${Date.now()}`;
  const name = `SFG Test ${Date.now()}`;
  const res = await postForm("/master-data/products/semi-finished", {
    _csrf: csrf,
    code,
    name,
    group_id: groups[0].value,
    base_uom_id: uoms[0].value,
    size_ids: sizes[0].value,
  });
  logResult("semi-finished", res);
  return { code, name };
};

const createFinished = async (pageHtml, csrf) => {
  const groups = extractOptions(pageHtml, "group_id");
  const uoms = extractOptions(pageHtml, "base_uom_id");
  const subgroups = extractOptions(pageHtml, "subgroup_id");
  const types = extractOptions(pageHtml, "product_type_id");
  if (!groups.length || !uoms.length || !subgroups.length || !types.length) {
    console.log("SKIP FG: missing groups/uoms/subgroups/types");
    return null;
  }
  const name = `FG Test ${Date.now()}`;
  const res = await postForm("/master-data/products/finished", {
    _csrf: csrf,
    name,
    group_id: groups[0].value,
    subgroup_id: subgroups[0].value,
    base_uom_id: uoms[0].value,
    product_type_id: types[0].value,
    uses_sfg: "true",
    sfg_part_type: "UPPER",
  });
  logResult("finished", res);
  return { name };
};

const createSku = async (pageHtml, csrf) => {
  const items = extractOptions(pageHtml, "item_id");
  const sizes = extractOptions(pageHtml, "size_id");
  const grades = extractOptions(pageHtml, "grade_id");
  if (!items.length || !sizes.length || !grades.length) {
    console.log("SKIP SKU: missing items/sizes/grades");
    return null;
  }
  const res = await postForm("/master-data/products/skus", {
    _csrf: csrf,
    item_id: items[0].value,
    size_id: sizes[0].value,
    grade_id: grades[0].value,
    sale_rate: "250",
  });
  logResult("skus", res);
  return true;
};

const getCsrf = async () => {
  const { html } = await fetchHtml("/master-data/products/raw-materials");
  return extractCsrf(html);
};

const main = async () => {
  console.log("Products testing");
  loadInitialCookies();
  const loggedIn = await loginIfNeeded();
  if (!loggedIn) return;

  await ensureBasicData();
  const csrf = await getCsrf();
  const rmHtml = await testPage("/master-data/products/raw-materials");
  const sfgHtml = await testPage("/master-data/products/semi-finished");
  const fgHtml = await testPage("/master-data/products/finished");
  const skuHtml = await testPage("/master-data/products/skus");

  if (!doPost) return;

  await createRawMaterial(rmHtml, csrf);
  await createSemiFinished(sfgHtml, csrf);
  const fg = await createFinished(fgHtml, csrf);
  const skuHtmlAfter = fg ? await testPage("/master-data/products/skus") : skuHtml;
  await createSku(skuHtmlAfter, csrf);

  console.log("Done");
};

main().catch((err) => {
  console.error("Script failed", err);
  process.exitCode = 1;
});
