const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");

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

const targetText = fs.readFileSync(targetPath, "utf8");

const mojibakeMarkers = /[ØÙÛÃâÚ¢€ž┌┘╪\u2500-\u257f]/g;
const arabicScript = /[\u0600-\u06FF]/g;
const controlGarbage = /[\u0080-\u009f]/g;
const replacementChar = /�/g;
const suspiciousAscii = /[&R]/g;
const MOJIBAKE_OR_REPLACEMENT = /[ØÙÛÃâÚ¢€ž┌┘╪�\u2500-\u257f]/;

const WIN1252_REVERSE = {
  "€": 0x80,
  "‚": 0x82,
  "ƒ": 0x83,
  "„": 0x84,
  "…": 0x85,
  "†": 0x86,
  "‡": 0x87,
  "ˆ": 0x88,
  "‰": 0x89,
  "Š": 0x8a,
  "‹": 0x8b,
  "Œ": 0x8c,
  "Ž": 0x8e,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "˜": 0x98,
  "™": 0x99,
  "š": 0x9a,
  "›": 0x9b,
  "œ": 0x9c,
  "ž": 0x9e,
  "Ÿ": 0x9f,
};

const toLegacyByteBuffer = (text) => {
  const bytes = [];
  for (const ch of String(text || "")) {
    const code = ch.charCodeAt(0);
    if (code <= 0xff) {
      bytes.push(code);
      continue;
    }
    bytes.push(
      Object.prototype.hasOwnProperty.call(WIN1252_REVERSE, ch)
        ? WIN1252_REVERSE[ch]
        : null
    );
    if (bytes[bytes.length - 1] === null) {
      bytes.pop();
      bytes.push(...Buffer.from(ch, "utf8"));
    }
  }
  return Buffer.from(bytes);
};

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
    return toLegacyByteBuffer(input).toString("utf8");
  } catch {
    return String(input || "");
  }
};

const decodeWithEncoding = (input, encoding) => {
  try {
    return iconv.encode(String(input || ""), encoding).toString("utf8");
  } catch {
    return String(input || "");
  }
};

const decodeCandidatesOnce = (input) => {
  const source = String(input || "");
  const out = [decodeOnce(source)];
  out.push(decodeWithEncoding(source, "cp437"));
  return [...new Set(out.filter(Boolean))];
};

const bestDecode = (input) => {
  if (typeof input !== "string") return input;
  if (!MOJIBAKE_OR_REPLACEMENT.test(input)) return input;

  const candidates = [input];
  const seen = new Set([input]);
  let frontier = [input];
  for (let i = 0; i < 4; i += 1) {
    const nextFrontier = [];
    for (const current of frontier) {
      const decodedOptions = decodeCandidatesOnce(current);
      for (const option of decodedOptions) {
        if (seen.has(option)) continue;
        seen.add(option);
        candidates.push(option);
        nextFrontier.push(option);
      }
    }
    if (!nextFrontier.length) break;
    frontier = nextFrontier;
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

const valueLiteralRegex = /(:\s*)"([^"\\]*(?:\\.[^"\\]*)*)"/g;
const decodeValueLiterals = (segment) =>
  String(segment || "").replace(valueLiteralRegex, (full, prefix, rawValue) => {
    const decoded = bestDecode(rawValue);
    const escaped = decoded.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${prefix}"${escaped}"`;
  });

const translationsUrMarker = "translations.ur = {";
let cursor = 0;
let fixedText = "";
while (cursor < targetText.length) {
  const markerIndex = targetText.indexOf(translationsUrMarker, cursor);
  if (markerIndex < 0) {
    fixedText += targetText.slice(cursor);
    break;
  }

  fixedText += targetText.slice(cursor, markerIndex);

  const openBraceIndex = targetText.indexOf("{", markerIndex);
  if (openBraceIndex < 0) {
    fixedText += targetText.slice(markerIndex);
    break;
  }
  const closeBraceIndex = findMatchingBrace(targetText, openBraceIndex);
  if (closeBraceIndex < 0) {
    fixedText += targetText.slice(markerIndex);
    break;
  }

  const segment = targetText.slice(markerIndex, closeBraceIndex + 1);
  fixedText += decodeValueLiterals(segment);
  cursor = closeBraceIndex + 1;
}

fs.writeFileSync(targetPath, fixedText, "utf8");

const remaining = (fixedText.match(mojibakeMarkers) || []).length;
const replacementRemaining = (fixedText.match(replacementChar) || []).length;
console.log(`locale.js rewritten. Remaining mojibake markers: ${remaining}`);
console.log(`Replacement characters in file: ${replacementRemaining}`);
