const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { generateUniqueCode, slugifyCode } = require("../utils/entity-code");
const { translateUrduWithFallback } = require("../utils/translate");

const withFetchMock = async (handlers, fn) => {
  const originalFetch = global.fetch;
  let index = 0;
  global.fetch = async () => {
    const handler = handlers[index] || handlers[handlers.length - 1];
    index += 1;
    return handler();
  };
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
};

const response = ({ ok = true, status = 200, body = "" }) => ({
  ok,
  status,
  text: async () => body,
});

const testTranslateFallbacks = async () => {
  process.env.AZURE_TRANSLATOR_KEY = "test";
  process.env.AZURE_TRANSLATOR_REGION = "test";
  process.env.DEEPL_API_KEY = "test";
  process.env.DEEPL_API_URL = "https://example.com/deepl";

  const azureTransliterate = () => response({ body: JSON.stringify([{ text: "اردو" }]) });
  const azureTranslate = () => response({ body: JSON.stringify([{ translations: [{ text: "ترجمہ" }] }]) });
  const deeplTranslate = () => response({ body: JSON.stringify({ translations: [{ text: "fallback" }] }) });

  await withFetchMock([azureTransliterate], async () => {
    const out = await translateUrduWithFallback({ text: "urdu", mode: "transliterate", logger: { error() {} } });
    assert.equal(out.provider, "azure");
    assert.equal(out.translated, "اردو");
    assert.equal(out.azure_error, null);
  });

  await withFetchMock(
    [
      () => response({ ok: false, status: 500, body: "azure fail" }),
      deeplTranslate,
    ],
    async () => {
      const out = await translateUrduWithFallback({ text: "urdu", mode: "transliterate", logger: { error() {} } });
      assert.equal(out.provider, "deepl");
      assert.equal(out.translated, "fallback");
      assert.ok(out.azure_error && out.azure_error.includes("Azure"));
    },
  );

  await withFetchMock([azureTranslate], async () => {
    const out = await translateUrduWithFallback({ text: "hello", mode: "translate", logger: { error() {} } });
    assert.equal(out.provider, "azure");
    assert.equal(out.translated, "ترجمہ");
  });

  await withFetchMock(
    [
      () => response({ ok: false, status: 503, body: "azure down" }),
      deeplTranslate,
    ],
    async () => {
      const out = await translateUrduWithFallback({ text: "hello", mode: "translate", logger: { error() {} } });
      assert.equal(out.provider, "deepl");
      assert.equal(out.translated, "fallback");
    },
  );
};

const testCodeGeneration = async () => {
  assert.equal(slugifyCode(" Cash & Bank "), "cash_bank");

  const seen = new Set(["emp_ali", "emp_ali_2"]);
  const code = await generateUniqueCode({
    name: "Ali",
    prefix: "emp",
    exists: async (candidate) => seen.has(candidate),
  });
  assert.equal(code, "emp_ali_3");

  const short = await generateUniqueCode({
    name: "Very Long Employee Name For Stress Testing",
    prefix: "lab",
    maxLen: 12,
    exists: async () => false,
  });
  assert.ok(short.length <= 12);
  assert.ok(short.startsWith("lab_"));
};

const testNoManualCodeFields = async () => {
  const employeesPath = path.join(__dirname, "../routes/hr-payroll/employees.js");
  const laboursPath = path.join(__dirname, "../routes/hr-payroll/labours.js");
  const employeesSource = fs.readFileSync(employeesPath, "utf8");
  const laboursSource = fs.readFileSync(laboursPath, "utf8");

  assert.ok(employeesSource.includes("autoCodeFromName: true"));
  assert.ok(laboursSource.includes("autoCodeFromName: true"));
  assert.ok(!employeesSource.includes('name: "code"'));
  assert.ok(!laboursSource.includes('name: "code"'));
};

const run = async () => {
  await testTranslateFallbacks();
  await testCodeGeneration();
  await testNoManualCodeFields();
  console.log("PASS test-approval-translation-code-policy");
};

run().catch((err) => {
  console.error("FAIL test-approval-translation-code-policy", err);
  process.exit(1);
});
