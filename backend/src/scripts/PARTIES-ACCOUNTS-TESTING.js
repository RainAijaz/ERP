const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const username = process.env.AUTH_USERNAME || "";
const password = process.env.AUTH_PASSWORD || "";
const doPost = process.env.DO_POST !== "0";
const doAuthTest = process.env.DO_AUTH_TEST !== "0";
const doCsrfTest = process.env.DO_CSRF_TEST !== "0";
const doUpdateTest = process.env.DO_UPDATE_TEST !== "0";
const doToggleTest = process.env.DO_TOGGLE_TEST !== "0";
const doCleanup = process.env.DO_CLEANUP !== "0";

const cookieJar = new Map();

const getCookieHeader = () =>
  Array.from(cookieJar.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");

const ingestSetCookies = (res) => {
  const setCookies =
    (typeof res.headers.getSetCookie === "function" && res.headers.getSetCookie()) ||
    (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  setCookies
    .filter(Boolean)
    .forEach((header) => {
      const [cookiePair] = header.split(";");
      if (!cookiePair) return;
      const [key, value] = cookiePair.split("=");
      if (!key) return;
      cookieJar.set(key.trim(), (value || "").trim());
    });
};

const routes = {
  parties: "/master-data/basic-info/parties",
  accounts: "/master-data/basic-info/accounts",
};

const isOkStatus = (status) => status >= 200 && status < 400;

const extractCsrf = (html) => {
  const match = html.match(/name="_csrf"\s+value="([^"]+)"/i);
  return match ? match[1] : "";
};

const extractOptions = (html, name) => {
  const selectMatch = html.match(
    new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)<\\/select>`, "i")
  );
  if (!selectMatch) return [];
  const optionsHtml = selectMatch[1];
  const options = [];
  const optionRegex = /<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/gi;
  let match;
  while ((match = optionRegex.exec(optionsHtml))) {
    const value = match[1].trim();
    const label = match[2].trim();
    if (value) {
      options.push({ value, label });
    }
  }
  return options;
};

const hasMultipleSelect = (html, name) =>
  new RegExp(`<select[^>]*name="${name}"[^>]*multiple`, "i").test(html);

const parseButtonAttributes = (buttonHtml) => {
  const attrs = {};
  const attrRegex = /([a-z0-9_-]+)="([^"]*)"/gi;
  let match;
  while ((match = attrRegex.exec(buttonHtml))) {
    attrs[match[1]] = match[2];
  }
  return attrs;
};

const findEditButtons = (html) => {
  const buttons = [];
  const buttonRegex = /<button[^>]*data-edit[^>]*>/gi;
  let match;
  while ((match = buttonRegex.exec(html))) {
    buttons.push(parseButtonAttributes(match[0]));
  }
  return buttons;
};

const findEditButtonByField = (html, field, value, caseInsensitive = false) => {
  const buttons = findEditButtons(html);
  const compare = (a, b) =>
    caseInsensitive
      ? (a || "").toLowerCase() === (b || "").toLowerCase()
      : (a || "") === (b || "");
  return buttons.find((btn) => compare(btn[`data-${field}`], value)) || null;
};

const fetchHtml = async (url, withCookie = true, extraHeaders = {}) => {
  const res = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      ...(withCookie ? { Cookie: getCookieHeader() } : {}),
      ...extraHeaders,
    },
  });
  ingestSetCookies(res);
  const text = await res.text();
  return { res, text };
};

const postForm = async (url, payload) => {
  const res = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...(getCookieHeader() ? { Cookie: getCookieHeader() } : {}),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: payload.toString(),
  });
  ingestSetCookies(res);
  return res;
};

const logResult = (ok, label, detail = "") => {
  if (ok) {
    console.log(`OK  ${label}${detail ? ` ${detail}` : ""}`);
  } else {
    console.log(`ERR ${label}${detail ? ` ${detail}` : ""}`);
  }
};

const deviceProfiles = [
  {
    label: "desktop",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  },
  {
    label: "ipad",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    },
  },
  {
    label: "mobile",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    },
  },
];

const runRouteTests = async (key, route) => {
  const url = `${baseUrl}${route}`;
  const start = Date.now();
  const { res, text } = await fetchHtml(url);
  const ms = Date.now() - start;

  if (!isOkStatus(res.status)) {
    console.log(`ERR ${res.status} ${route} (${ms}ms)`);
    return false;
  }

  const requiredNeedles = [
    "data-table",
    "data-modal",
    "data-search-input",
    "data-filter-toggle",
  ];
  const missing = requiredNeedles.filter((needle) => !text.includes(needle));
  if (missing.length) {
    console.log(`WARN ${route} missing: ${missing.join(", ")}`);
  } else {
    console.log(`OK  200  ${route} (${ms}ms)`);
  }

  if (doAuthTest) {
    const { res: authRes } = await fetchHtml(url, false);
    logResult([401, 302].includes(authRes.status), `AUTH ${authRes.status} ${route}`);
  }

  // Urdu + device checks (GET only).
  for (const profile of deviceProfiles) {
    const langUrl = `${url}?lang=ur`;
    const { res: langRes, text: langHtml } = await fetchHtml(
      langUrl,
      true,
      profile.headers
    );
    const ok = isOkStatus(langRes.status);
    logResult(ok, `GET urdu ${profile.label} ${route}`);
    if (ok) {
      const missingUr = requiredNeedles.filter((needle) => !langHtml.includes(needle));
      if (missingUr.length) {
        console.log(`WARN urdu ${profile.label} ${route} missing: ${missingUr.join(", ")}`);
      }
    }
  }

  const csrf = extractCsrf(text);
  if (!csrf) {
    console.log(`ERR ${route} missing CSRF token`);
    return false;
  }

  if (!doPost) return true;

  if (key === "accounts") {
    const groups = extractOptions(text, "subgroup_id");
    const branches = extractOptions(text, "branch_ids");
    const multiBranch = hasMultipleSelect(text, "branch_ids");

    logResult(groups.length > 0, "account groups available");
    logResult(branches.length > 0, "branches available");
    logResult(multiBranch, "branch_ids is multiple select");

    if (!groups.length || !branches.length) {
      console.log("SKIP accounts POST: missing group or branch options");
      return false;
    }

    const suffix = Date.now().toString().slice(-6);
    const name = `Test Account ${suffix}`;
    const nameUr = `Test Account Urdu ${suffix}`;

    const payload = new URLSearchParams();
    payload.append("_csrf", csrf);
    payload.append("subgroup_id", groups[0].value);
    payload.append("name", name);
    payload.append("name_ur", nameUr);
    payload.append("branch_ids", branches[0].value);
    if (branches[1]) payload.append("branch_ids", branches[1].value);

    const postRes = await postForm(url, payload);
    logResult(isOkStatus(postRes.status), `POST ${postRes.status} ${route}`);

    const { text: refresh } = await fetchHtml(url);
    const inserted = findEditButtonByField(refresh, "name", name);
    logResult(Boolean(inserted), "CHECK INSERT accounts");

    if (inserted && branches[1]) {
      const branchIds = inserted["data-branch_ids"] || "";
      const hasBoth =
        branchIds.includes(branches[0].value) && branchIds.includes(branches[1].value);
      logResult(hasBoth, "branch_ids saved (multi)");
    }

    // Negative: missing name
    const missingName = new URLSearchParams();
    missingName.append("_csrf", csrf);
    missingName.append("subgroup_id", groups[0].value);
    missingName.append("name", "");
    missingName.append("name_ur", "");
    missingName.append("branch_ids", branches[0].value);
    const missingNameRes = await postForm(url, missingName);
    logResult(isOkStatus(missingNameRes.status), "NEGATIVE missing_name submitted");

    // Negative: missing branches
    const missingBranch = new URLSearchParams();
    missingBranch.append("_csrf", csrf);
    missingBranch.append("subgroup_id", groups[0].value);
    missingBranch.append("name", `Test Account Missing Branch ${suffix}`);
    missingBranch.append("name_ur", `Test Account Missing Branch Urdu ${suffix}`);
    const missRes = await postForm(url, missingBranch);
    logResult(!isOkStatus(missRes.status) || missRes.status === 200, "NEGATIVE missing_branch submitted");

    // Negative: duplicate case
    const dupCase = new URLSearchParams();
    dupCase.append("_csrf", csrf);
    dupCase.append("subgroup_id", groups[0].value);
    dupCase.append("name", name.toLowerCase());
    dupCase.append("name_ur", `Test Account Urdu ${suffix} Case`);
    dupCase.append("branch_ids", branches[0].value);
    const dupRes = await postForm(url, dupCase);
    logResult(isOkStatus(dupRes.status), "NEGATIVE duplicate_case submitted");

    // Negative: invalid group id
    const invalidGroup = new URLSearchParams();
    invalidGroup.append("_csrf", csrf);
    invalidGroup.append("subgroup_id", "999999");
    invalidGroup.append("name", `Test Account Bad Group ${suffix}`);
    invalidGroup.append("name_ur", `Test Account Bad Group Urdu ${suffix}`);
    invalidGroup.append("branch_ids", branches[0].value);
    const invalidRes = await postForm(url, invalidGroup);
    logResult(isOkStatus(invalidRes.status), "NEGATIVE invalid_group submitted");

    if (doUpdateTest && inserted) {
      const updateName = `Test Account Updated ${suffix}`;
      const updatePayload = new URLSearchParams();
      updatePayload.append("_csrf", csrf);
      updatePayload.append("subgroup_id", groups[0].value);
      updatePayload.append("name", updateName);
      updatePayload.append("name_ur", `Test Account Updated Urdu ${suffix}`);
      updatePayload.append("branch_ids", branches[0].value);
      const updateRes = await postForm(`${url}/${inserted["data-id"]}`, updatePayload);
      logResult(isOkStatus(updateRes.status), "UPDATE accounts");

      const { text: updatedHtml } = await fetchHtml(url);
      const updatedRow = findEditButtonByField(updatedHtml, "name", updateName);
      logResult(Boolean(updatedRow), "CHECK UPDATE accounts");
    }

    if (doToggleTest && inserted) {
      const toggleRes = await postForm(`${url}/${inserted["data-id"]}/toggle`, new URLSearchParams({ _csrf: csrf }));
      logResult(isOkStatus(toggleRes.status), "TOGGLE accounts");
    }

    if (doCsrfTest) {
      const csrfPayload = new URLSearchParams(payload.toString());
      csrfPayload.delete("_csrf");
      const csrfRes = await postForm(url, csrfPayload);
      logResult([403, 400].includes(csrfRes.status), `CSRF ${csrfRes.status} ${route}`);
    }

    if (doCleanup && inserted) {
      const delRes = await postForm(`${url}/${inserted["data-id"]}/delete`, new URLSearchParams({ _csrf: csrf }));
      logResult(isOkStatus(delRes.status), "DELETE accounts");
    }

    return true;
  }

  if (key === "parties") {
    const groups = extractOptions(text, "group_id");
    const branches = extractOptions(text, "branch_ids");
    const multiBranch = hasMultipleSelect(text, "branch_ids");

    logResult(groups.length > 0, "party groups available");
    logResult(branches.length > 0, "branches available");
    logResult(multiBranch, "branch_ids is multiple select");

    if (!groups.length || !branches.length) {
      console.log("SKIP parties POST: missing group or branch options");
      return false;
    }

    const suffix = Date.now().toString().slice(-6);
    const name = `Test Party ${suffix}`;
    const nameUr = `Test Party Urdu ${suffix}`;

    const payload = new URLSearchParams();
    payload.append("_csrf", csrf);
    payload.append("party_type", "CUSTOMER");
    payload.append("group_id", groups[0].value);
    payload.append("name", name);
    payload.append("name_ur", nameUr);
    payload.append("branch_ids", branches[0].value);
    if (branches[1]) payload.append("branch_ids", branches[1].value);
    payload.append("address", `Street ${suffix}`);

    const postRes = await postForm(url, payload);
    logResult(isOkStatus(postRes.status), `POST ${postRes.status} ${route}`);

    const { text: refresh } = await fetchHtml(url);
    const inserted = findEditButtonByField(refresh, "name", name);
    logResult(Boolean(inserted), "CHECK INSERT parties");

    if (inserted && branches[1]) {
      const branchIds = inserted["data-branch_ids"] || "";
      const hasBoth =
        branchIds.includes(branches[0].value) && branchIds.includes(branches[1].value);
      logResult(hasBoth, "branch_ids saved (multi)");
    }

    // Negative: missing name
    const missingName = new URLSearchParams();
    missingName.append("_csrf", csrf);
    missingName.append("party_type", "CUSTOMER");
    missingName.append("group_id", groups[0].value);
    missingName.append("name", "");
    missingName.append("name_ur", "");
    missingName.append("branch_ids", branches[0].value);
    const missingNameRes = await postForm(url, missingName);
    logResult(isOkStatus(missingNameRes.status), "NEGATIVE missing_name submitted");

    // Negative: missing group
    const missingGroup = new URLSearchParams();
    missingGroup.append("_csrf", csrf);
    missingGroup.append("party_type", "CUSTOMER");
    missingGroup.append("name", `Test Party Missing Group ${suffix}`);
    missingGroup.append("name_ur", `Test Party Missing Group Urdu ${suffix}`);
    missingGroup.append("branch_ids", branches[0].value);
    const missingGroupRes = await postForm(url, missingGroup);
    logResult(isOkStatus(missingGroupRes.status), "NEGATIVE missing_group submitted");

    // Negative: invalid group id
    const invalidGroup = new URLSearchParams();
    invalidGroup.append("_csrf", csrf);
    invalidGroup.append("party_type", "CUSTOMER");
    invalidGroup.append("group_id", "999999");
    invalidGroup.append("name", `Test Party Bad Group ${suffix}`);
    invalidGroup.append("name_ur", `Test Party Bad Group Urdu ${suffix}`);
    invalidGroup.append("branch_ids", branches[0].value);
    const invalidGroupRes = await postForm(url, invalidGroup);
    logResult(isOkStatus(invalidGroupRes.status), "NEGATIVE invalid_group submitted");

    // Negative: missing branches
    const missingBranch = new URLSearchParams();
    missingBranch.append("_csrf", csrf);
    missingBranch.append("party_type", "CUSTOMER");
    missingBranch.append("group_id", groups[0].value);
    missingBranch.append("name", `Test Party Missing Branch ${suffix}`);
    missingBranch.append("name_ur", `Test Party Missing Branch Urdu ${suffix}`);
    const missingBranchRes = await postForm(url, missingBranch);
    logResult(isOkStatus(missingBranchRes.status), "NEGATIVE missing_branch submitted");

    // Negative: duplicate case
    const dupCase = new URLSearchParams();
    dupCase.append("_csrf", csrf);
    dupCase.append("party_type", "CUSTOMER");
    dupCase.append("group_id", groups[0].value);
    dupCase.append("name", name.toLowerCase());
    dupCase.append("name_ur", `Test Party Urdu ${suffix} Case`);
    dupCase.append("branch_ids", branches[0].value);
    const dupRes = await postForm(url, dupCase);
    logResult(isOkStatus(dupRes.status), "NEGATIVE duplicate_case submitted");

    if (doUpdateTest && inserted) {
      const updateName = `Test Party Updated ${suffix}`;
      const updatePayload = new URLSearchParams();
      updatePayload.append("_csrf", csrf);
      updatePayload.append("party_type", "CUSTOMER");
      updatePayload.append("group_id", groups[0].value);
      updatePayload.append("name", updateName);
      updatePayload.append("name_ur", `Test Party Updated Urdu ${suffix}`);
      updatePayload.append("branch_ids", branches[0].value);
      updatePayload.append("address", `Updated Street ${suffix}`);
      const updateRes = await postForm(`${url}/${inserted["data-id"]}`, updatePayload);
      logResult(isOkStatus(updateRes.status), "UPDATE parties");

      const { text: updatedHtml } = await fetchHtml(url);
      const updatedRow = findEditButtonByField(updatedHtml, "name", updateName);
      logResult(Boolean(updatedRow), "CHECK UPDATE parties");
    }

    if (doToggleTest && inserted) {
      const toggleRes = await postForm(`${url}/${inserted["data-id"]}/toggle`, new URLSearchParams({ _csrf: csrf }));
      logResult(isOkStatus(toggleRes.status), "TOGGLE parties");
    }

    if (doCsrfTest) {
      const csrfPayload = new URLSearchParams(payload.toString());
      csrfPayload.delete("_csrf");
      const csrfRes = await postForm(url, csrfPayload);
      logResult([403, 400].includes(csrfRes.status), `CSRF ${csrfRes.status} ${route}`);
    }

    if (doCleanup && inserted) {
      const delRes = await postForm(`${url}/${inserted["data-id"]}/delete`, new URLSearchParams({ _csrf: csrf }));
      logResult(isOkStatus(delRes.status), "DELETE parties");
    }

    return true;
  }

  return false;
};

const run = async () => {
  if (!username || !password) {
    console.warn("WARN: AUTH_USERNAME or AUTH_PASSWORD not set. Auth-protected routes may redirect.");
  }

  if (username && password) {
    const loginUrl = `${baseUrl}/auth/login`;
    // Prime CSRF cookie (not required for login, but sets csrf_token).
    await fetchHtml(loginUrl, false);
    const payload = new URLSearchParams({
      username,
      password,
    });
    const loginRes = await postForm(loginUrl, payload);
    const ok = [200, 302].includes(loginRes.status);
    logResult(ok, `LOGIN ${loginRes.status}`);
    if (!ok) {
      console.log("ERR Login failed. Check AUTH_USERNAME / AUTH_PASSWORD.");
    }
  }

  let pass = 0;
  let fail = 0;

  for (const [key, route] of Object.entries(routes)) {
    try {
      const ok = await runRouteTests(key, route);
      if (ok) {
        pass += 1;
      } else {
        fail += 1;
      }
    } catch (err) {
      fail += 1;
      console.log(`ERR ---- ${route}`);
      console.error(err.message || err);
    }
  }

  console.log(`\nSummary: ${pass} OK, ${fail} failed`);
  if (fail) {
    process.exitCode = 1;
  }
};

run();
