require("dotenv").config();
const { test, expect } = require("@playwright/test");

const getCredentials = (prefix) => {
  const username = process.env[`${prefix}_USER`];
  const password =
    process.env[`${prefix}_PASSWORD`] || process.env[`${prefix}_PASS`];
  if (!username || !password) {
    test.skip(
      true,
      `Missing ${prefix}_USER and ${prefix}_PASSWORD/${prefix}_PASS env vars. Example: $env:${prefix}_USER="admin"; $env:${prefix}_PASSWORD="password"`,
    );
  }
  return { username, password };
};

const login = async (page, prefix) => {
  const { username, password } = getCredentials(prefix);
  await page.goto("/auth/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form[action="/auth/login"] button[type="submit"]').click();

  await expect(page).not.toHaveURL(/\/auth\/login/i);
  await expect(page.locator('form[action="/auth/logout"] button[type="submit"]')).toBeVisible();
};

module.exports = { getCredentials, login };
