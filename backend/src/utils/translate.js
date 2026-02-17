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
  return apiKey.endsWith(":fx") ? "https://api-free.deepl.com/v2/translate" : "https://api.deepl.com/v2/translate";
};

const TRANSLATION_CACHE_TTL_MS = Number(process.env.TRANSLATION_CACHE_TTL_MS || 0);
const TRANSLATION_HTTP_TIMEOUT_MS = Number(process.env.TRANSLATION_HTTP_TIMEOUT_MS || 8000);
const translationCache = new Map();

const fetchWithTimeout = async (url, options = {}, timeoutMs = TRANSLATION_HTTP_TIMEOUT_MS) => {
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
  const apiKey = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION;
  if (!apiKey || !region || !text) {
    throw new Error("Azure transliteration not configured");
  }

  const endpoint = process.env.AZURE_TRANSLATOR_ENDPOINT || "https://api.cognitive.microsofttranslator.com";
  const normalizedEndpoint = endpoint.replace(/\/+$/, "");
  const url = `${normalizedEndpoint}/transliterate` + "?api-version=3.0&language=ur&fromScript=Latn&toScript=Arab";

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      "Ocp-Apim-Subscription-Region": region,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ text }]),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Azure ${response.status}: ${raw}`);
  }

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
  const apiKey = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION;
  if (!apiKey || !region || !text) {
    throw new Error("Azure translation not configured");
  }

  const endpoint = process.env.AZURE_TRANSLATOR_ENDPOINT || "https://api.cognitive.microsofttranslator.com";
  const normalizedEndpoint = endpoint.replace(/\/+$/, "");
  const url = `${normalizedEndpoint}/translate?api-version=3.0&to=ur`;

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      "Ocp-Apim-Subscription-Region": region,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([{ text }]),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Azure ${response.status}: ${raw}`);
  }

  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (err) {
    throw new Error(`Azure invalid JSON: ${raw}`);
  }

  const translated = data && data[0] && data[0].translations && data[0].translations[0] && data[0].translations[0].text;
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

  const translated = data && data.translations && data.translations[0] && data.translations[0].text;
  if (!translated) {
    throw new Error(`DeepL empty translation: ${raw}`);
  }
  return translated;
};

const translateUrduWithFallback = async ({ text, mode = "translate", logger = console }) => {
  const resolvedMode = mode === "transliterate" ? "transliterate" : "translate";
  const cached = readCache(resolvedMode, text);
  if (cached) {
    return { translated: cached.translated, provider: cached.provider, azure_error: null };
  }
  let azureError = null;

  try {
    const translated = resolvedMode === "transliterate" ? await transliterateToUrdu(text) : await azureTranslateToUrdu(text);
    writeCache(resolvedMode, text, { translated, provider: "azure" });
    return { translated, provider: "azure", azure_error: null };
  } catch (err) {
    azureError = err?.message || "Azure failed";
    logger.error("[translate] azure fallback triggered", { mode: resolvedMode, error: azureError });
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
    throw new Error(`Fallback unavailable. Azure error: ${azureError || "unknown"}. DeepL error: ${deeplError}`);
  }
};

module.exports = { translateToUrdu, transliterateToUrdu, azureTranslateToUrdu, translateUrduWithFallback };
