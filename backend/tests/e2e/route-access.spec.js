const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const { login } = require("./utils/auth");

const configPath = path.join(__dirname, "route-access.json");

const loadConfig = () => {
  if (!fs.existsSync(configPath)) {
    return { routes: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`Invalid JSON in ${configPath}: ${err.message}`);
  }
};

const { routes } = loadConfig();

test.describe("Route access smoke", () => {
  if (!routes.length) {
    test("no routes configured", async () => {
      test.skip(true, "Add routes to tests/e2e/route-access.json to enable this suite.");
    });
    return;
  }

  for (const route of routes) {
    test(`${route.name} (${route.path})`, async ({ page }) => {
      await login(page, route.userPrefix || "E2E_LIMITED");
      const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });

      if (route.expectedStatus) {
        expect(response.status()).toBe(route.expectedStatus);
      }

      if (route.expectText) {
        await expect(page.getByText(route.expectText, { exact: false })).toBeVisible();
      }

      if (route.denyText) {
        await expect(page.getByText(route.denyText, { exact: false })).toBeVisible();
      }
    });
  }
});
