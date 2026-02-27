// translate.js
// Purpose: Provides translation and transliteration utilities for Urdu and other languages.
// Integrates with Azure Translator and DeepL APIs for text translation and script conversion.
// Used by the UI and backend to support multilingual features and transliteration in forms.
//
// Exports:
// - transliterateToUrdu: Transliterates Latin text to Urdu script using Azure.
// - azureTranslateToUrdu: Translates text to Urdu using Azure.
// - translateToUrdu: Translates text to Urdu using DeepL.
// - translateUrduWithFallback: Azure-first translation with DeepL fallback.
// - resolveBaseUrl: Helper to determine the correct API endpoint for DeepL.

const resolveBaseUrl = (apiKey) => {
  if (process.env.DEEPL_API_URL) {
    return process.env.DEEPL_API_URL;
  }
  if (!apiKey) {
    return null;
  }
  return apiKey.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";
};

const TRANSLATION_CACHE_TTL_MS = Number(
  process.env.TRANSLATION_CACHE_TTL_MS || 0,
);
const TRANSLATION_HTTP_TIMEOUT_MS = Number(
  process.env.TRANSLATION_HTTP_TIMEOUT_MS || 8000,
);
const translationCache = new Map();

const readEnvValue = (...keys) => {
  for (const key of keys) {
    const raw = process.env[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const unquoted = trimmed.replace(/^['\"]|['\"]$/g, "").trim();
    if (unquoted) return unquoted;
  }
  return "";
};

const resolveAzureConfig = () => {
  const apiKey = readEnvValue(
    "AZURE_TRANSLATOR_KEY",
    "AZURE_TRANSLATOR_API_KEY",
    "AZURE_AI_TRANSLATOR_KEY",
  );
  const region = readEnvValue(
    "AZURE_TRANSLATOR_REGION",
    "AZURE_TRANSLATOR_LOCATION",
    "AZURE_REGION",
  );
  const endpoint =
    readEnvValue(
      "AZURE_TRANSLATOR_ENDPOINT",
      "AZURE_TRANSLATOR_BASE_URL",
      "AZURE_AI_TRANSLATOR_ENDPOINT",
    ) || "https://api.cognitive.microsofttranslator.com";
  return {
    apiKey,
    region,
    endpoint,
  };
};

const normalizeAzureEndpoint = (endpoint) => {
  const normalized = String(
    endpoint || "https://api.cognitive.microsofttranslator.com",
  )
    .trim()
    .replace(/\/+$/, "");
  return normalized.replace(/\/(translate|transliterate)$/i, "");
};

const buildAzureHeaders = ({ apiKey, region, includeRegion = true }) => {
  const headers = {
    "Ocp-Apim-Subscription-Key": apiKey,
    "Content-Type": "application/json",
  };
  if (includeRegion && region) {
    headers["Ocp-Apim-Subscription-Region"] = region;
  }
  return headers;
};

const azureRequestWithAuthRetry = async ({ url, body, apiKey, region }) => {
  const normalizedRegion = String(region || "").trim();
  const attempts = [];
  if (normalizedRegion) {
    attempts.push({ includeRegion: true, region: normalizedRegion });
    if (normalizedRegion.toLowerCase() !== "global") {
      attempts.push({ includeRegion: true, region: "global" });
    }
  }
  attempts.push({ includeRegion: false, region: "" });
  let lastError = "Azure request failed";
  let lastStatus = 0;

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: buildAzureHeaders({
        apiKey,
        region: attempt.region,
        includeRegion: attempt.includeRegion,
      }),
      body: JSON.stringify(body),
    });

    const raw = await response.text();
    if (response.ok) {
      return raw;
    }

    lastStatus = Number(response.status || 0);
    lastError = `Azure ${response.status}: ${raw}`;
    const hasAnotherAttempt = index < attempts.length - 1;
    if (!hasAnotherAttempt || response.status !== 401) {
      break;
    }
  }

  if (lastStatus === 401) {
    throw new Error(
      `${lastError} | Verify AZURE translator key/region from the Azure Translator resource (try region 'global' if your resource is global).`,
    );
  }
  throw new Error(lastError);
};

const fetchWithTimeout = async (
  url,
  options = {},
  timeoutMs = TRANSLATION_HTTP_TIMEOUT_MS,
) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

const readCache = (mode, text) => {
  if (TRANSLATION_CACHE_TTL_MS <= 0) return null;
  const key = `${mode}:${text}`;
  const cached = translationCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts > TRANSLATION_CACHE_TTL_MS) {
    translationCache.delete(key);
    return null;
  }
  return cached.value;
};

const writeCache = (mode, text, value) => {
  if (TRANSLATION_CACHE_TTL_MS <= 0) return;
  const key = `${mode}:${text}`;
  translationCache.set(key, { value, ts: Date.now() });
};

const transliterateToUrdu = async (text) => {
  const { apiKey, region, endpoint } = resolveAzureConfig();
  if (!apiKey || !text) {
    throw new Error("Azure transliteration not configured");
  }

  const normalizedEndpoint = normalizeAzureEndpoint(endpoint);
  const url =
    `${normalizedEndpoint}/transliterate` +
    "?api-version=3.0&language=ur&fromScript=Latn&toScript=Arab";
  const raw = await azureRequestWithAuthRetry({
    url,
    body: [{ text }],
    apiKey,
    region,
  });

  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (err) {
    throw new Error(`Azure invalid JSON: ${raw}`);
  }

  const transliteration = data && data[0] && data[0].text ? data[0].text : null;
  if (!transliteration) {
    throw new Error(`Azure empty transliteration: ${raw}`);
  }
  return transliteration;
};

const azureTranslateToUrdu = async (text) => {
  const { apiKey, region, endpoint } = resolveAzureConfig();
  if (!apiKey || !text) {
    throw new Error("Azure translation not configured");
  }

  const normalizedEndpoint = normalizeAzureEndpoint(endpoint);
  const url = `${normalizedEndpoint}/translate?api-version=3.0&to=ur`;
  const raw = await azureRequestWithAuthRetry({
    url,
    body: [{ text }],
    apiKey,
    region,
  });

  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (err) {
    throw new Error(`Azure invalid JSON: ${raw}`);
  }

  const translated =
    data &&
    data[0] &&
    data[0].translations &&
    data[0].translations[0] &&
    data[0].translations[0].text;
  if (!translated) {
    throw new Error(`Azure empty translation: ${raw}`);
  }
  return translated;
};

const translateToUrdu = async (text) => {
  const apiKey = process.env.DEEPL_API_KEY;
  const baseUrl = resolveBaseUrl(apiKey);
  if (!apiKey || !baseUrl || !text) {
    return null;
  }

  const payload = new URLSearchParams();
  payload.append("text", text);
  payload.append("target_lang", "UR");
  payload.append("preserve_formatting", "1");

  const response = await fetchWithTimeout(baseUrl, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: payload.toString(),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`DeepL ${response.status}: ${raw}`);
  }

  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (err) {
    throw new Error(`DeepL invalid JSON: ${raw}`);
  }

  const translated =
    data &&
    data.translations &&
    data.translations[0] &&
    data.translations[0].text;
  if (!translated) {
    throw new Error(`DeepL empty translation: ${raw}`);
  }
  return translated;
};

const translateUrduWithFallback = async ({
  text,
  mode = "translate",
  logger = console,
}) => {
  const resolvedMode = mode === "transliterate" ? "transliterate" : "translate";
  const cached = readCache(resolvedMode, text);
  if (cached) {
    return {
      translated: cached.translated,
      provider: cached.provider,
      azure_error: null,
    };
  }
  let azureError = null;

  try {
    const translated =
      resolvedMode === "transliterate"
        ? await transliterateToUrdu(text)
        : await azureTranslateToUrdu(text);
    writeCache(resolvedMode, text, { translated, provider: "azure" });
    return { translated, provider: "azure", azure_error: null };
  } catch (err) {
    azureError = err?.message || "Azure failed";
    logger.error("[translate] azure fallback triggered", {
      mode: resolvedMode,
      error: azureError,
    });
  }

  try {
    const translated = await translateToUrdu(text);
    if (!translated) {
      throw new Error("DeepL not configured or returned empty.");
    }
    writeCache(resolvedMode, text, { translated, provider: "deepl" });
    return { translated, provider: "deepl", azure_error: azureError };
  } catch (deeplErr) {
    const deeplError = deeplErr?.message || "DeepL failed";
    logger.error("[translate] deepl fallback failed", {
      mode: resolvedMode,
      azure_error: azureError,
      deepl_error: deeplError,
    });
    throw new Error(
      `Fallback unavailable. Azure error: ${azureError || "unknown"}. DeepL error: ${deeplError}`,
    );
  }
};

module.exports = {
  translateToUrdu,
  transliterateToUrdu,
  azureTranslateToUrdu,
  translateUrduWithFallback,
};
