import {
  options as baseOptions,
  loginHeavy,
  reportLoad,
  voucherSave,
} from "./k6-erp-critical.js";

export { loginHeavy, reportLoad, voucherSave };

export const options = {
  ...baseOptions,
  scenarios: {
    login_heavy: {
      executor: "ramping-vus",
      exec: "loginHeavy",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 4 },
        { duration: "15s", target: 8 },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
    report_load: {
      executor: "ramping-vus",
      exec: "reportLoad",
      startVUs: 1,
      stages: [
        { duration: "10s", target: 3 },
        { duration: "15s", target: 6 },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
};
