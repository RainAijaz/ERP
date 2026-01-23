const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const cookie = process.env.SESSION_COOKIE || "";
const doPost = process.env.DO_POST === "1";
const doAuthTest = process.env.DO_AUTH_TEST !== "0";
const doCsrfTest = process.env.DO_CSRF_TEST !== "0";

const routes = [
  "/master-data/basic-info/units",
  "/master-data/basic-info/sizes",
  "/master-data/basic-info/colors",
  "/master-data/basic-info/grades",
  "/master-data/basic-info/packing-types",
  "/master-data/basic-info/cities",
  "/master-data/basic-info/uom-conversions",
  "/master-data/basic-info/product-groups",
  "/master-data/basic-info/product-subgroups",
  "/master-data/basic-info/product-types",
  "/master-data/basic-info/party-groups",
  "/master-data/basic-info/account-groups",
  "/master-data/basic-info/parties",
  "/master-data/basic-info/accounts",
  "/master-data/basic-info/departments",
];

const baseChecks = [
  { name: "table", needle: "data-table" },
  { name: "print", needle: "data-print-area" },
  { name: "modal", needle: "data-modal" },
  { name: "search", needle: "data-search-input" },
  { name: "pager", needle: "data-page-size" },
];

const routeChecks = {
  "/master-data/basic-info/uom-conversions": [
    { name: "from_uom", needle: "from_uom_id" },
    { name: "to_uom", needle: "to_uom_id" },
    { name: "factor", needle: "data-field=\"factor\"" },
  ],
  "/master-data/basic-info/product-groups": [
    { name: "applies_to", needle: "item_types" },
  ],
  "/master-data/basic-info/product-subgroups": [
    { name: "group_select", needle: "group_id" },
    { name: "applies_to", needle: "item_types" },
  ],
  "/master-data/basic-info/account-groups": [
    { name: "account_type", needle: "account_type" },
    { name: "code", needle: "data-field=\"code\"" },
  ],
  "/master-data/basic-info/accounts": [
    { name: "account_group", needle: "subgroup_id" },
  ],
  "/master-data/basic-info/parties": [
    { name: "party_type", needle: "party_type" },
    { name: "branches", needle: "branch_ids" },
    { name: "city", needle: "city_id" },
  ],
  "/master-data/basic-info/cities": [
    { name: "name", needle: "data-field=\"name\"" },
  ],
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

const extractDataAttrValues = (html, field) => {
  if (!field) return [];
  const values = [];
  const regex = new RegExp(`data-${field}="([^"]*)"`, "gi");
  let match;
  while ((match = regex.exec(html))) {
    values.push(match[1]);
  }
  return values;
};

const buildPostPayload = (route, html) => {
  const suffix = Date.now().toString().slice(-6);
  const csrf = extractCsrf(html);
  if (!csrf) {
    return { error: "Missing CSRF token" };
  }

  if (route.endsWith("/uom-conversions")) {
    const uomsFrom = extractOptions(html, "from_uom_id");
    const uomsTo = extractOptions(html, "to_uom_id");
    if (uomsFrom.length < 2 || uomsTo.length < 2) {
      return { error: "Need at least 2 active UOMs to create conversion" };
    }
    return {
      csrf,
      keyFields: [
        { name: "from_uom_id", value: uomsFrom[0].value },
        { name: "to_uom_id", value: uomsTo[1].value },
        { name: "factor", value: "10" },
      ],
      payload: new URLSearchParams({
        _csrf: csrf,
        from_uom_id: uomsFrom[0].value,
        to_uom_id: uomsTo[1].value,
        factor: "10",
      }),
      negativeTests: [
        {
          label: "factor_zero",
          keyFields: [
            { name: "from_uom_id", value: uomsFrom[0].value },
            { name: "to_uom_id", value: uomsTo[1].value },
            { name: "factor", value: "0" },
          ],
          payload: new URLSearchParams({
            _csrf: csrf,
            from_uom_id: uomsFrom[0].value,
            to_uom_id: uomsTo[1].value,
            factor: "0",
          }),
          expectMax: 0,
        },
        {
          label: "same_units",
          keyFields: [
            { name: "from_uom_id", value: uomsFrom[0].value },
            { name: "to_uom_id", value: uomsFrom[0].value },
            { name: "factor", value: "5" },
          ],
          payload: new URLSearchParams({
            _csrf: csrf,
            from_uom_id: uomsFrom[0].value,
            to_uom_id: uomsFrom[0].value,
            factor: "5",
          }),
          expectMax: 0,
        },
      ],
    };
  }

  if (route.endsWith("/product-groups")) {
    return {
      csrf,
      keyField: "name",
      keyValue: `Test Group ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        name: `Test Group ${suffix}`,
        name_ur: `Test Group Urdu ${suffix}`,
        item_types: "RM",
      }),
      negativeTests: [
        {
          label: "missing_item_types",
          keyField: "name",
          keyValue: `Test Group ${suffix}`,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `Test Group ${suffix}`,
            name_ur: `Test Group Urdu ${suffix}`,
          }),
          expectMax: 1,
        },
        {
          label: "invalid_item_types",
          keyField: "name",
          keyValue: `Test Group ${suffix} Bad`,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `Test Group ${suffix} Bad`,
            name_ur: `Test Group Urdu ${suffix} Bad`,
            item_types: "XXX",
          }),
          expectMax: 0,
        },
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test group ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `test group ${suffix}`,
            name_ur: `Test Group Urdu ${suffix} Case`,
            item_types: "RM",
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/product-subgroups")) {
    const groups = extractOptions(html, "group_id");
    return {
      csrf,
      keyField: "name",
      keyValue: `Test Subgroup ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        group_id: groups[0] ? groups[0].value : "",
        name: `Test Subgroup ${suffix}`,
        name_ur: `Test Subgroup Urdu ${suffix}`,
        item_types: "SFG",
      }),
      negativeTests: [
        {
          label: "missing_item_types",
          keyField: "name",
          keyValue: `Test Subgroup ${suffix}`,
          payload: new URLSearchParams({
            _csrf: csrf,
            group_id: groups[0] ? groups[0].value : "",
            name: `Test Subgroup ${suffix}`,
            name_ur: `Test Subgroup Urdu ${suffix}`,
          }),
          expectMax: 1,
        },
        {
          label: "invalid_item_types",
          keyField: "name",
          keyValue: `Test Subgroup ${suffix} Bad`,
          payload: new URLSearchParams({
            _csrf: csrf,
            group_id: groups[0] ? groups[0].value : "",
            name: `Test Subgroup ${suffix} Bad`,
            name_ur: `Test Subgroup Urdu ${suffix} Bad`,
            item_types: "ZZZ",
          }),
          expectMax: 0,
        },
        {
          label: "invalid_group_id",
          keyField: "name",
          keyValue: `Test Subgroup ${suffix} BadGroup`,
          payload: new URLSearchParams({
            _csrf: csrf,
            group_id: "999999",
            name: `Test Subgroup ${suffix} BadGroup`,
            name_ur: `Test Subgroup Urdu ${suffix} BadGroup`,
            item_types: "RM",
          }),
          expectMax: 0,
        },
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test subgroup ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            group_id: groups[0] ? groups[0].value : "",
            name: `test subgroup ${suffix}`,
            name_ur: `Test Subgroup Urdu ${suffix} Case`,
            item_types: "SFG",
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/product-types")) {
    return {
      csrf,
      keyField: "name",
      keyValue: `Test Type ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        name: `Test Type ${suffix}`,
        name_ur: `Test Type Urdu ${suffix}`,
      }),
      negativeTests: [
        {
          label: "duplicate_name",
          keyField: "name",
          keyValue: `Test Type ${suffix}`,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `Test Type ${suffix}`,
            name_ur: `Test Type Urdu ${suffix}`,
          }),
          expectMax: 1,
        },
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test type ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `test type ${suffix}`,
            name_ur: `Test Type Urdu ${suffix} Case`,
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/party-groups")) {
    return {
      csrf,
      keyField: "name",
      keyValue: `Test Party ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        party_type: "BOTH",
        name: `Test Party ${suffix}`,
        name_ur: `Test Party Urdu ${suffix}`,
      }),
      negativeTests: [
        {
          label: "invalid_type",
          keyField: "name",
          keyValue: `Test Party ${suffix} Bad`,
          payload: new URLSearchParams({
            _csrf: csrf,
            party_type: "WRONG",
            name: `Test Party ${suffix} Bad`,
            name_ur: `Test Party Urdu ${suffix} Bad`,
          }),
          expectMax: 0,
        },
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test party ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            party_type: "BOTH",
            name: `test party ${suffix}`,
            name_ur: `Test Party Urdu ${suffix} Case`,
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/account-groups")) {
    return {
      csrf,
      keyField: "name",
      keyValue: `Test Account ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        account_type: "ASSET",
        name: `Test Account ${suffix}`,
        name_ur: `Test Account Urdu ${suffix}`,
        code: `test_account_${suffix}`,
        is_contra: "on",
      }),
      negativeTests: [
        {
          label: "invalid_account_type",
          keyField: "name",
          keyValue: `Test Account ${suffix} Bad`,
          payload: new URLSearchParams({
            _csrf: csrf,
            account_type: "WRONG",
            name: `Test Account ${suffix} Bad`,
            name_ur: `Test Account Urdu ${suffix} Bad`,
            code: `bad_account_${suffix}`,
          }),
          expectMax: 0,
        },
        {
          label: "missing_code",
          keyField: "name",
          keyValue: `Test Account ${suffix}`,
          payload: new URLSearchParams({
            _csrf: csrf,
            account_type: "ASSET",
            name: `Test Account ${suffix}`,
            name_ur: `Test Account Urdu ${suffix}`,
          }),
          expectMax: 1,
        },
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test account ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            account_type: "ASSET",
            name: `test account ${suffix}`,
            name_ur: `Test Account Urdu ${suffix} Case`,
            code: `test_account_${suffix}_case`,
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/accounts")) {
    const groups = extractOptions(html, "subgroup_id");
    if (!groups.length) {
      return { error: "No account groups available" };
    }
    const branches = extractOptions(html, "branch_ids");
    return {
      csrf,
      keyField: "name",
      keyValue: `Test Account ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        subgroup_id: groups[0].value,
        ...(branches[0] ? { branch_ids: branches[0].value } : {}),
        name: `Test Account ${suffix}`,
        name_ur: `Test Account Urdu ${suffix}`,
        lock_posting: "",
      }),
      negativeTests: [
        {
          label: "invalid_group_id",
          keyField: "name",
          keyValue: `Test Account ${suffix} Bad`,
          payload: new URLSearchParams({
            _csrf: csrf,
            subgroup_id: "999999",
            name: `Test Account ${suffix} Bad`,
            name_ur: `Test Account Urdu ${suffix} Bad`,
          }),
          expectMax: 0,
        },
        {
          label: "duplicate_name",
          keyField: "name",
          keyValue: `Test Account ${suffix}`,
          payload: new URLSearchParams({
            _csrf: csrf,
            subgroup_id: groups[0].value,
            name: `Test Account ${suffix} Dup`,
            name_ur: `Test Account Urdu ${suffix} Dup`,
          }),
          expectMax: 1,
        },
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test account ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            subgroup_id: groups[0].value,
            name: `test account ${suffix}`,
            name_ur: `Test Account Urdu ${suffix} Case`,
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/parties")) {
    const groups = extractOptions(html, "group_id");
    const branches = extractOptions(html, "branch_ids");
    const cities = extractOptions(html, "city_id");
    return {
      csrf,
      keyField: "name",
      keyValue: `Test Party ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        party_type: "CUSTOMER",
        group_id: groups[0] ? groups[0].value : "",
        ...(branches[0] ? { branch_ids: branches[0].value } : {}),
        name: `Test Party ${suffix}`,
        name_ur: `Test Party Urdu ${suffix}`,
        ...(cities[0] ? { city_id: cities[0].value } : {}),
        address: `Street ${suffix}`,
        phone1: "0300-0000000",
        phone2: "",
        credit_allowed: "on",
        credit_limit: "5000",
      }),
      negativeTests: [
        {
          label: "invalid_type",
          keyField: "name",
          keyValue: `Test Party ${suffix} Bad`,
          payload: new URLSearchParams({
            _csrf: csrf,
            party_type: "INVALID",
            group_id: groups[0] ? groups[0].value : "",
            name: `Test Party ${suffix} Bad`,
            name_ur: `Test Party Urdu ${suffix} Bad`,
          }),
          expectMax: 0,
        },
        {
          label: "credit_not_customer",
          keyField: "name",
          keyValue: `Test Party ${suffix} Credit`,
          payload: new URLSearchParams({
            _csrf: csrf,
            party_type: "SUPPLIER",
            group_id: groups[0] ? groups[0].value : "",
            name: `Test Party ${suffix} Credit`,
            name_ur: `Test Party Urdu ${suffix} Credit`,
            credit_allowed: "on",
            credit_limit: "1000",
          }),
          expectMax: 0,
        },
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test party ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            party_type: "CUSTOMER",
            group_id: groups[0] ? groups[0].value : "",
            name: `test party ${suffix}`,
            name_ur: `Test Party Urdu ${suffix} Case`,
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/departments")) {
    return {
      csrf,
      keyField: "name",
      keyValue: `Test Dept ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        name: `Test Dept ${suffix}`,
        name_ur: `Test Dept Urdu ${suffix}`,
        is_production: "on",
      }),
      negativeTests: [
        {
          label: "missing_name",
          keyField: "name",
          keyValue: `Test Dept ${suffix}`,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: "",
            name_ur: "",
            is_production: "on",
          }),
          expectMax: 1,
        },
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test dept ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `test dept ${suffix}`,
            name_ur: `Test Dept Urdu ${suffix} Case`,
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/units")) {
    return {
      csrf,
      keyField: "code",
      keyValue: `TU${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        code: `TU${suffix}`,
        name: `Test Unit ${suffix}`,
        name_ur: `Test Unit Urdu ${suffix}`,
      }),
      negativeTests: [
        {
          label: "missing_fields",
          keyField: "code",
          keyValue: `TU${suffix}`,
          payload: new URLSearchParams({
            _csrf: csrf,
            code: "",
            name: "",
            name_ur: "",
          }),
          expectMax: 1,
        },
        {
          label: "duplicate_code",
          keyField: "code",
          keyValue: `TU${suffix}`,
          payload: new URLSearchParams({
            _csrf: csrf,
            code: `TU${suffix}`,
            name: `Test Unit ${suffix} Duplicate`,
            name_ur: `Test Unit Urdu ${suffix} Duplicate`,
          }),
          expectMax: 1,
        },
        {
          label: "duplicate_case",
          keyField: "code",
          keyValue: `tu${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            code: `tu${suffix}`,
            name: `Test Unit ${suffix} Case`,
            name_ur: `Test Unit Urdu ${suffix} Case`,
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/sizes")) {
    return {
      csrf,
      keyField: "name",
      keyValue: `Test Size ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        name: `Test Size ${suffix}`,
        name_ur: `Test Size Urdu ${suffix}`,
      }),
      negativeTests: [
        {
          label: "duplicate_name",
          keyField: "name",
          keyValue: `Test Size ${suffix}`,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `Test Size ${suffix}`,
            name_ur: `Test Size Urdu ${suffix}`,
          }),
          expectMax: 1,
        },
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test size ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `test size ${suffix}`,
            name_ur: `Test Size Urdu ${suffix} Case`,
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/colors")) {
    return {
      csrf,
      keyField: "name",
      keyValue: `Test Color ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        name: `Test Color ${suffix}`,
        name_ur: `Test Color Urdu ${suffix}`,
      }),
      negativeTests: [
        {
          label: "duplicate_name",
          keyField: "name",
          keyValue: `Test Color ${suffix}`,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `Test Color ${suffix}`,
            name_ur: `Test Color Urdu ${suffix}`,
          }),
          expectMax: 1,
        },
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test color ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `test color ${suffix}`,
            name_ur: `Test Color Urdu ${suffix} Case`,
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/grades")) {
    return {
      csrf,
      keyField: "name",
      keyValue: `Test Grade ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        name: `Test Grade ${suffix}`,
        name_ur: `Test Grade Urdu ${suffix}`,
      }),
      negativeTests: [
        {
          label: "duplicate_name",
          keyField: "name",
          keyValue: `Test Grade ${suffix}`,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `Test Grade ${suffix}`,
            name_ur: `Test Grade Urdu ${suffix}`,
          }),
          expectMax: 1,
        },
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test grade ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `test grade ${suffix}`,
            name_ur: `Test Grade Urdu ${suffix} Case`,
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/packing-types")) {
    return {
      csrf,
      keyField: "name",
      keyValue: `Test Pack ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        name: `Test Pack ${suffix}`,
        name_ur: `Test Pack Urdu ${suffix}`,
      }),
      negativeTests: [
        {
          label: "duplicate_name",
          keyField: "name",
          keyValue: `Test Pack ${suffix}`,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `Test Pack ${suffix}`,
            name_ur: `Test Pack Urdu ${suffix}`,
          }),
          expectMax: 1,
        },
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test pack ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `test pack ${suffix}`,
            name_ur: `Test Pack Urdu ${suffix} Case`,
          }),
          expectMax: 1,
        },
      ],
    };
  }

  if (route.endsWith("/cities")) {
    return {
      csrf,
      keyField: "name",
      keyValue: `Test City ${suffix}`,
      payload: new URLSearchParams({
        _csrf: csrf,
        name: `Test City ${suffix}`,
        name_ur: `Test City Urdu ${suffix}`,
      }),
      negativeTests: [
        {
          label: "duplicate_case",
          keyField: "name",
          keyValue: `test city ${suffix}`,
          caseInsensitive: true,
          payload: new URLSearchParams({
            _csrf: csrf,
            name: `test city ${suffix}`,
            name_ur: `Test City Urdu ${suffix} Case`,
          }),
          expectMax: 1,
        },
      ],
    };
  }

  return { error: "No POST handler for route" };
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

const findRowIdByField = (html, field, value) => {
  if (!field || !value) return "";
  const buttonRegex = /<button[^>]*data-edit[^>]*>/gi;
  let match;
  while ((match = buttonRegex.exec(html))) {
    const attrs = parseButtonAttributes(match[0]);
    if (attrs[`data-${field}`] === value && attrs["data-id"]) {
      return attrs["data-id"];
    }
  }
  return "";
};

const findRowIdByFields = (html, fields) => {
  if (!fields || !fields.length) return "";
  const buttonRegex = /<button[^>]*data-edit[^>]*>/gi;
  let match;
  while ((match = buttonRegex.exec(html))) {
    const attrs = parseButtonAttributes(match[0]);
    const ok = fields.every(
      (field) => attrs[`data-${field.name}`] === field.value
    );
    if (ok && attrs["data-id"]) {
      return attrs["data-id"];
    }
  }
  return "";
};

const countEditMatches = (html, field, value, caseInsensitive) => {
  if (!field || !value) return 0;
  const safeValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = caseInsensitive ? "gi" : "g";
  const regex = new RegExp(
    `<button[^>]*data-edit[^>]*data-${field}="${safeValue}"`,
    flags
  );
  const matches = html.match(regex);
  return matches ? matches.length : 0;
};

const countEditMatchesByFields = (html, fields) => {
  if (!fields || !fields.length) return 0;
  const buttonRegex = /<button[^>]*data-edit[^>]*>/gi;
  let match;
  let count = 0;
  while ((match = buttonRegex.exec(html))) {
    const attrs = parseButtonAttributes(match[0]);
    const ok = fields.every(
      (field) => attrs[`data-${field.name}`] === field.value
    );
    if (ok) count += 1;
  }
  return count;
};

const run = async () => {
  if (!cookie) {
    console.warn(
      "WARN: SESSION_COOKIE not set. If routes require auth, you may see 302/401."
    );
  }

  let pass = 0;
  let fail = 0;

  for (const route of routes) {
    const url = `${baseUrl}${route}`;
    try {
      const start = Date.now();
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: cookie ? { Cookie: cookie } : {},
      });
      const ms = Date.now() - start;
      const location = res.headers.get("location");

      if (!isOkStatus(res.status)) {
        fail += 1;
        console.log(`ERR ${res.status} ${route} ${location ? `-> ${location}` : ""} (${ms}ms)`);
        continue;
      }

      const html = await res.text();
      const checks = [...baseChecks, ...(routeChecks[route] || [])];
      const missing = checks.filter((check) => !html.includes(check.needle));

      if (missing.length) {
        fail += 1;
        console.log(
          `WARN ${res.status} ${route} (${ms}ms) missing: ${missing
            .map((item) => item.name)
            .join(", ")}`
        );
      } else {
        pass += 1;
        console.log(`OK  ${res.status}  ${route} (${ms}ms)`);
      }

      if (doAuthTest) {
        const authRes = await fetch(url, { method: "GET", redirect: "manual" });
        if ([401, 302].includes(authRes.status)) {
          console.log(`AUTH OK ${authRes.status} ${route}`);
        } else {
          console.log(`AUTH ERR ${authRes.status} ${route}`);
          fail += 1;
        }
      }

      if (doPost) {
        const postPayload = buildPostPayload(route, html);
        if (postPayload.error) {
          console.log(`SKIP POST ${route}: ${postPayload.error}`);
          continue;
        }
        const postRes = await fetch(url, {
          method: "POST",
          redirect: "manual",
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: postPayload.payload.toString(),
        });
        const postOk = postRes.status >= 200 && postRes.status < 400;
        if (postOk) {
          console.log(`POST OK  ${postRes.status} ${route}`);
        } else {
          console.log(`POST ERR ${postRes.status} ${route}`);
          fail += 1;
        }

        const refresh = await fetch(url, {
          method: "GET",
          redirect: "manual",
          headers: cookie ? { Cookie: cookie } : {},
        });
        const refreshHtml = await refresh.text();
        if (postPayload.keyFields && postPayload.keyFields.length) {
          const matchCount = countEditMatchesByFields(
            refreshHtml,
            postPayload.keyFields
          );
          console.log(
            `CHECK INSERT ${route}: ${matchCount > 0 ? "FOUND" : "NOT FOUND"}`
          );
        } else if (postPayload.keyField && postPayload.keyValue) {
          const matchCount = countEditMatches(
            refreshHtml,
            postPayload.keyField,
            postPayload.keyValue
          );
          console.log(
            `CHECK INSERT ${route}: ${matchCount > 0 ? "FOUND" : "NOT FOUND"}`
          );
        }

        if (postPayload.negativeTests && postPayload.negativeTests.length) {
          for (const testCase of postPayload.negativeTests) {
            const invalidRes = await fetch(url, {
              method: "POST",
              redirect: "manual",
              headers: {
                ...(cookie ? { Cookie: cookie } : {}),
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: testCase.payload.toString(),
            });
            const invalidOk = invalidRes.status >= 200 && invalidRes.status < 400;
            const invalidHtml = await (
              await fetch(url, {
                method: "GET",
                redirect: "manual",
                headers: cookie ? { Cookie: cookie } : {},
              })
            ).text();
            const keyFields = testCase.keyFields || postPayload.keyFields;
            const keyField = testCase.keyField || postPayload.keyField;
            const keyValue = testCase.keyValue || postPayload.keyValue;
            const invalidCount = keyFields && keyFields.length
              ? countEditMatchesByFields(invalidHtml, keyFields)
              : countEditMatches(
                  invalidHtml,
                  keyField,
                  keyValue,
                  testCase.caseInsensitive
                );
            const expectedMax = typeof testCase.expectMax === "number" ? testCase.expectMax : 0;
            if (invalidOk && invalidCount > expectedMax) {
              console.log(`NEGATIVE ERR ${route} (${testCase.label})`);
              fail += 1;
            } else {
              console.log(`NEGATIVE OK  ${route} (${testCase.label})`);
            }
          }
        }

        if (doCsrfTest) {
          const csrfPayload = new URLSearchParams(postPayload.payload.toString());
          csrfPayload.delete("_csrf");
          const csrfRes = await fetch(url, {
            method: "POST",
            redirect: "manual",
            headers: {
              ...(cookie ? { Cookie: cookie } : {}),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: csrfPayload.toString(),
          });
          if ([403, 400].includes(csrfRes.status)) {
            console.log(`CSRF OK ${csrfRes.status} ${route}`);
          } else {
            console.log(`CSRF ERR ${csrfRes.status} ${route}`);
            fail += 1;
          }
        }

        if (postPayload.keyFields && postPayload.keyFields.length) {
          const targetId = findRowIdByFields(refreshHtml, postPayload.keyFields);
          if (targetId) {
            const delRes = await fetch(`${url}/${targetId}/delete`, {
              method: "POST",
              redirect: "manual",
              headers: {
                ...(cookie ? { Cookie: cookie } : {}),
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({ _csrf: postPayload.csrf }).toString(),
            });
            const delOk = delRes.status >= 200 && delRes.status < 400;
            console.log(`DELETE ${delOk ? "OK" : "ERR"} ${delRes.status} ${route}`);
          } else {
            console.log(`DELETE SKIP ${route}: cannot locate row id`);
          }
        } else if (postPayload.keyField && postPayload.keyValue) {
          const targetId = findRowIdByField(
            refreshHtml,
            postPayload.keyField,
            postPayload.keyValue
          );
          if (targetId) {
            const delRes = await fetch(`${url}/${targetId}/delete`, {
              method: "POST",
              redirect: "manual",
              headers: {
                ...(cookie ? { Cookie: cookie } : {}),
                "Content-Type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({ _csrf: postPayload.csrf }).toString(),
            });
            const delOk = delRes.status >= 200 && delRes.status < 400;
            console.log(`DELETE ${delOk ? "OK" : "ERR"} ${delRes.status} ${route}`);
          } else {
            console.log(`DELETE SKIP ${route}: cannot locate row id`);
          }
        }
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
