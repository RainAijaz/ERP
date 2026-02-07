const { test, expect } = require("@playwright/test");

const getCredentials = (prefix) => {
  const username = process.env[`${prefix}_USER`];
  const password = process.env[`${prefix}_PASS`];
  if (!username || !password) {
    test.skip(true, `Missing ${prefix}_USER or ${prefix}_PASS env vars. Example: $env:${prefix}_USER="admin"; $env:${prefix}_PASS="password"`);
  }
  return { username, password };
};

const login = async (page, prefix) => {
  const { username, password } = getCredentials(prefix);
  await page.goto("/auth/login", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Username", { exact: false }).fill(username);
  await page.getByLabel("Password", { exact: false }).fill(password);
  await page.getByRole("button", { name: /login/i }).click();
  // await page.waitForLoadState("networkidle");
  // await page.waitForURL("**/administration/**", { timeout: 30000 });
  await expect(page.getByRole("button", { name: /logout/i })).toBeVisible();
};

module.exports = { getCredentials, login };
