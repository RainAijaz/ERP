const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const targetPath = path.resolve(__dirname, "../src/middleware/core/locale.js");

const findMatchingBrace = (input, openIndex) => {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIndex; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    const prev = input[i - 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inSingle) {
      if (ch === "'" && prev !== "\\") inSingle = false;
      continue;
    }

    if (inDouble) {
      if (ch === '"' && prev !== "\\") inDouble = false;
      continue;
    }

    if (inTemplate) {
      if (ch === "`" && prev !== "\\") inTemplate = false;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (ch === "`") {
      inTemplate = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
};

const findObjectSpan = (input, key) => {
  const rx = new RegExp(`\\b${key}\\s*:\\s*\\{`, "m");
  const match = rx.exec(input);
  if (!match) return null;
  const start = match.index;
  const openBraceIndex = input.indexOf("{", start);
  if (openBraceIndex < 0) return null;
  const closeBraceIndex = findMatchingBrace(input, openBraceIndex);
  if (closeBraceIndex < 0) return null;
  return { start, openBraceIndex, closeBraceIndex };
};

const targetText = fs.readFileSync(targetPath, "utf8");

const readSourceFromGit = () => {
  const repoRoot = path.resolve(__dirname, "../..");
  const candidates = ["HEAD:backend/src/middleware/core/locale.js", "HEAD:src/middleware/core/locale.js"];
  for (const spec of candidates) {
    try {
      const result = execSync(`git show ${spec}`, {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 30 * 1024 * 1024,
      });
      if (result && result.includes("const translations =")) return result;
    } catch (err) {
      continue;
    }
  }
  throw new Error("Could not read locale.js from git HEAD");
};

const sourceText = readSourceFromGit();

const targetSpan = findObjectSpan(targetText, "ur");
if (!targetSpan) throw new Error("Could not find target ur block");

const sourceSpan = findObjectSpan(sourceText, "ur");
if (!sourceSpan) throw new Error("Could not find source ur block");

const sourceBlock = sourceText.slice(sourceSpan.start, sourceSpan.closeBraceIndex + 1);

const mojibakeMarkers = /[ØÙÛÃâÚ¢€ž┌┘╪]/g;
const arabicScript = /[\u0600-\u06FF]/g;
const controlGarbage = /[\u0080-\u009f]/g;
const replacementChar = /�/g;
const suspiciousAscii = /[&R]/g;

const score = (input) => {
  const value = String(input || "");
  return (
    (value.match(arabicScript) || []).length * 14 -
    (value.match(replacementChar) || []).length * 60 -
    (value.match(mojibakeMarkers) || []).length * 8 -
    (value.match(controlGarbage) || []).length * 20 -
    (value.match(suspiciousAscii) || []).length * 3
  );
};

const decodeOnce = (input) => {
  try {
    return Buffer.from(String(input || ""), "latin1").toString("utf8");
  } catch {
    return String(input || "");
  }
};

const bestDecode = (input) => {
  if (typeof input !== "string") return input;
  if (!MOJIBAKE_OR_REPLACEMENT.test(input)) return input;

  const candidates = [input];
  let current = input;
  for (let i = 0; i < 4; i += 1) {
    current = decodeOnce(current);
    if (!candidates.includes(current)) candidates.push(current);
  }

  let best = input;
  let bestScore = score(input);
  const baseReplacementCount = (input.match(replacementChar) || []).length;

  for (const candidate of candidates) {
    const cleaned = String(candidate).replace(controlGarbage, "");
    const replacementCount = (cleaned.match(replacementChar) || []).length;
    if (replacementCount > baseReplacementCount) continue;
    const candidateScore = score(cleaned);
    if (candidateScore > bestScore) {
      best = cleaned;
      bestScore = candidateScore;
    }
  }

  return bestScore > score(input) + 3 ? best : input;
};

const MOJIBAKE_OR_REPLACEMENT = /[ØÙÛÃâÚ¢€ž┌┘╪�]/;

const valueLiteralRegex = /(:\s*)"([^"\\]*(?:\\.[^"\\]*)*)"/g;
const fixedBlock = sourceBlock.replace(valueLiteralRegex, (full, prefix, rawValue) => {
  const decoded = bestDecode(rawValue);
  const escaped = decoded.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${prefix}"${escaped}"`;
});

const nextText =
  targetText.slice(0, targetSpan.start) +
  fixedBlock +
  targetText.slice(targetSpan.closeBraceIndex + 1);
fs.writeFileSync(targetPath, nextText, "utf8");

const startAfter = /\bur\s*:\s*\{/m.exec(nextText);
const openAfter = startAfter ? nextText.indexOf("{", startAfter.index) : -1;
const closeAfter = openAfter >= 0 ? findMatchingBrace(nextText, openAfter) : -1;
const urBlockAfter =
  startAfter && openAfter >= 0 && closeAfter >= 0
    ? nextText.slice(startAfter.index, closeAfter + 1)
    : "";
const remaining = (urBlockAfter.match(mojibakeMarkers) || []).length;
const replacementRemaining = (urBlockAfter.match(replacementChar) || []).length;
console.log(`Urdu block rewritten. Remaining mojibake markers in ur block: ${remaining}`);
console.log(`Replacement characters in ur block: ${replacementRemaining}`);
