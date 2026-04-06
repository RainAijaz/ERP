const fs = require("fs");
const path = require("path");

const localeMiddleware = require("../middleware/core/locale");

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = [
  path.join(ROOT, "views"),
  path.join(ROOT, "routes"),
  path.join(ROOT, "services"),
  path.join(ROOT, "middleware"),
];
const FILE_EXTENSIONS = new Set([".ejs", ".js"]);

const translations = (localeMiddleware && localeMiddleware.translations) || {
  en: {},
  ur: {},
};
const enMap = translations.en || {};
const urMap = translations.ur || {};

const strict = process.argv.includes("--strict");

const keyRegexes = [
  /\bt\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  /\bres\.locals\.t\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
];

const hardcodedFallbackPatterns = [
  /t\(\s*["'`][^"'`]+["'`]\s*\)\s*===\s*["'`][^"'`]+["'`]\s*\?/,
  /res\.locals\.t\(\s*["'`][^"'`]+["'`]\s*\)\s*\|\|\s*["'`][A-Za-z]/,
  /\bt\(\s*["'`][^"'`]+["'`]\s*\)\s*\|\|\s*["'`][A-Za-z]/,
];

const collectFiles = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, out);
      continue;
    }
    if (FILE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(fullPath);
    }
  }
  return out;
};

const relative = (absPath) =>
  path.relative(path.resolve(__dirname, "..", ".."), absPath);

const keyOccurrences = new Map();
const hardcodedFallbackHits = [];

for (const scanDir of SCAN_DIRS) {
  const files = collectFiles(scanDir);
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    for (const regex of keyRegexes) {
      regex.lastIndex = 0;
      let match = regex.exec(content);
      while (match) {
        const key = String(match[1] || "").trim();
        if (key) {
          keyOccurrences.set(key, (keyOccurrences.get(key) || 0) + 1);
        }
        match = regex.exec(content);
      }
    }

    lines.forEach((line, idx) => {
      for (const pattern of hardcodedFallbackPatterns) {
        if (!pattern.test(line)) continue;
        hardcodedFallbackHits.push({
          file: relative(filePath),
          line: idx + 1,
          snippet: line.trim().slice(0, 220),
        });
        break;
      }
    });
  }
}

const allKeys = Array.from(keyOccurrences.keys()).sort();
const isCoveredDynamicTemplateKey = (key) =>
  key.startsWith("production_category_${") ||
  key.startsWith("return_reason_${");

const effectiveKeys = allKeys.filter(
  (key) => !isCoveredDynamicTemplateKey(key),
);

const missingUrdu = effectiveKeys.filter(
  (key) => !Object.prototype.hasOwnProperty.call(urMap, key),
);
const missingInBoth = allKeys.filter(
  (key) =>
    !isCoveredDynamicTemplateKey(key) &&
    !Object.prototype.hasOwnProperty.call(urMap, key) &&
    !Object.prototype.hasOwnProperty.call(enMap, key),
);

console.log("\n[urdu-audit] Summary");
console.log(`- keys found in code: ${allKeys.length}`);
console.log(
  `- dynamic template keys (covered by runtime mapping): ${allKeys.length - effectiveKeys.length}`,
);
console.log(`- keys missing in Urdu map: ${missingUrdu.length}`);
console.log(
  `- keys missing in both Urdu/English maps: ${missingInBoth.length}`,
);
console.log(
  `- hardcoded English fallback lines: ${hardcodedFallbackHits.length}`,
);

if (missingUrdu.length) {
  console.log("\n[urdu-audit] Missing Urdu keys (first 120):");
  missingUrdu.slice(0, 120).forEach((key) => {
    const fallbackEn = Object.prototype.hasOwnProperty.call(enMap, key)
      ? ` | en=${JSON.stringify(enMap[key])}`
      : "";
    console.log(`- ${key}${fallbackEn}`);
  });
}

if (hardcodedFallbackHits.length) {
  console.log("\n[urdu-audit] Hardcoded fallback lines (first 120):");
  hardcodedFallbackHits.slice(0, 120).forEach((hit) => {
    console.log(`- ${hit.file}:${hit.line} | ${hit.snippet}`);
  });
}

if (strict && (missingUrdu.length || hardcodedFallbackHits.length)) {
  console.error("\n[urdu-audit] strict mode failed.");
  process.exitCode = 1;
}
