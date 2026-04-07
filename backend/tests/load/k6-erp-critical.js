import http from "k6/http";
import { check, group, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = (__ENV.ERP_BASE_URL || "http://localhost:3000").replace(
  /\/$/,
  "",
);
const USERNAME = __ENV.ERP_USERNAME || "";
const PASSWORD = __ENV.ERP_PASSWORD || "";
const LOGIN_REDIRECTS = Number(__ENV.ERP_LOGIN_REDIRECTS || 0);

const REPORT_ENDPOINTS = String(
  __ENV.ERP_REPORT_ENDPOINTS ||
    "/reports/financial/profit_and_loss,/reports/sales/customer-listings,/reports/inventory/stock-balances",
)
  .split(",")
  .map((path) => path.trim())
  .filter(Boolean);

const VOUCHER_SAVE_ENABLED =
  String(__ENV.ERP_VOUCHER_SAVE_ENABLED || "0") === "1";
const VOUCHER_FORM_PATH = __ENV.ERP_VOUCHER_FORM_PATH || "/vouchers/cash?new=1";
const VOUCHER_POST_PATH = __ENV.ERP_VOUCHER_POST_PATH || "/vouchers/engine";
const VOUCHER_PAYLOAD = (() => {
  try {
    return JSON.parse(__ENV.ERP_VOUCHER_PAYLOAD_JSON || "{}");
  } catch (_) {
    return {};
  }
})();

const loginDuration = new Trend("erp_login_duration", true);
const reportDuration = new Trend("erp_report_duration", true);
const voucherDuration = new Trend("erp_voucher_save_duration", true);
const voucherFailureRate = new Rate("erp_voucher_save_failed");

const loginStages = JSON.parse(
  __ENV.ERP_LOGIN_STAGES_JSON ||
    '[{"duration":"20s","target":10},{"duration":"40s","target":25},{"duration":"20s","target":0}]',
);
const reportStages = JSON.parse(
  __ENV.ERP_REPORT_STAGES_JSON ||
    '[{"duration":"20s","target":5},{"duration":"60s","target":20},{"duration":"20s","target":0}]',
);
const voucherStages = JSON.parse(
  __ENV.ERP_VOUCHER_STAGES_JSON ||
    '[{"duration":"20s","target":2},{"duration":"40s","target":6},{"duration":"20s","target":0}]',
);

export const options = {
  thresholds: {
    http_req_failed: ["rate<0.02"],
    http_req_duration: ["p(95)<1200", "p(99)<2500"],
    checks: ["rate>0.98"],
    erp_login_duration: ["p(95)<1500"],
    erp_report_duration: ["p(95)<2000"],
    erp_voucher_save_duration: ["p(95)<2500"],
    erp_voucher_save_failed: ["rate<0.05"],
  },
  scenarios: {
    login_heavy: {
      executor: "ramping-vus",
      exec: "loginHeavy",
      startVUs: 1,
      stages: loginStages,
      gracefulRampDown: "10s",
    },
    report_load: {
      executor: "ramping-vus",
      exec: "reportLoad",
      startVUs: 1,
      stages: reportStages,
      gracefulRampDown: "10s",
    },
    ...(VOUCHER_SAVE_ENABLED
      ? {
          voucher_save: {
            executor: "ramping-vus",
            exec: "voucherSave",
            startVUs: 1,
            stages: voucherStages,
            gracefulRampDown: "10s",
          },
        }
      : {}),
  },
};

function ensureCreds() {
  if (!USERNAME || !PASSWORD) {
    throw new Error("Missing ERP_USERNAME or ERP_PASSWORD");
  }
}

function cookieToken(baseUrl, cookieName) {
  const jar = http.cookieJar();
  const cookies = jar.cookiesForURL(baseUrl);
  const values = cookies[cookieName] || [];
  return values.length ? values[0] : "";
}

function loginAndGetCsrf() {
  ensureCreds();

  const loginPage = http.get(`${BASE_URL}/auth/login`, {
    tags: { flow: "login", step: "open_login_page" },
  });
  check(loginPage, {
    "login page reachable": (r) => r.status >= 200 && r.status < 400,
  });

  const formBody =
    `username=${encodeURIComponent(USERNAME)}` +
    `&password=${encodeURIComponent(PASSWORD)}`;

  const loginRes = http.post(`${BASE_URL}/auth/login`, formBody, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirects: LOGIN_REDIRECTS,
    tags: { flow: "login", step: "submit_login" },
  });

  check(loginRes, {
    "login accepted": (r) =>
      r.status === 200 || r.status === 302 || r.status === 303,
  });

  const whoami = http.get(`${BASE_URL}/whoami`, {
    tags: { flow: "login", step: "whoami" },
  });
  check(whoami, {
    "whoami authorized": (r) => r.status === 200,
  });

  let csrf = cookieToken(BASE_URL, "csrf_token");
  if (!csrf) {
    const root = http.get(`${BASE_URL}/`, {
      tags: { flow: "login", step: "fetch_root_for_csrf" },
    });
    check(root, {
      "root reachable": (r) => r.status >= 200 && r.status < 400,
    });
    csrf = cookieToken(BASE_URL, "csrf_token");
  }
  return csrf;
}

function timed(name, fn) {
  const start = Date.now();
  const result = fn();
  const elapsed = Date.now() - start;
  if (name === "login") loginDuration.add(elapsed);
  if (name === "report") reportDuration.add(elapsed);
  if (name === "voucher") voucherDuration.add(elapsed);
  return result;
}

export function loginHeavy() {
  group("login-heavy", () => {
    timed("login", () => loginAndGetCsrf());
    sleep(0.2 + Math.random() * 0.5);
  });
}

export function reportLoad() {
  group("report-load", () => {
    timed("login", () => loginAndGetCsrf());

    for (const endpoint of REPORT_ENDPOINTS) {
      timed("report", () => {
        const res = http.get(`${BASE_URL}${endpoint}`, {
          tags: { flow: "report", endpoint },
        });
        check(res, {
          [`report ${endpoint} ok`]: (r) => r.status >= 200 && r.status < 400,
        });
      });
      sleep(0.1 + Math.random() * 0.4);
    }
  });
}

export function voucherSave() {
  group("voucher-save", () => {
    const csrf = timed("login", () => loginAndGetCsrf());

    const formRes = http.get(`${BASE_URL}${VOUCHER_FORM_PATH}`, {
      tags: { flow: "voucher", step: "open_form" },
    });
    check(formRes, {
      "voucher form reachable": (r) => r.status >= 200 && r.status < 400,
    });

    const hasPayload =
      VOUCHER_PAYLOAD &&
      typeof VOUCHER_PAYLOAD === "object" &&
      Object.keys(VOUCHER_PAYLOAD).length > 0;

    if (!hasPayload) {
      voucherFailureRate.add(false);
      return;
    }

    const saveRes = timed("voucher", () =>
      http.post(
        `${BASE_URL}${VOUCHER_POST_PATH}`,
        JSON.stringify(VOUCHER_PAYLOAD),
        {
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrf || "",
          },
          tags: { flow: "voucher", step: "save" },
        },
      ),
    );

    const ok = saveRes.status === 201 || saveRes.status === 202;
    voucherFailureRate.add(!ok);
    check(saveRes, {
      "voucher save accepted": () => ok,
    });

    sleep(0.2 + Math.random() * 0.6);
  });
}
