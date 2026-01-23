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

const transliterateToUrdu = async (text) => {
  const apiKey = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION;
  if (!apiKey || !region || !text) {
    throw new Error("Azure transliteration not configured");
  }

  const endpoint =
    process.env.AZURE_TRANSLATOR_ENDPOINT || "https://api.cognitive.microsofttranslator.com";
  const normalizedEndpoint = endpoint.replace(/\/+$/, "");
  const url =
    `${normalizedEndpoint}/transliterate` +
    "?api-version=3.0&language=ur&fromScript=Latn&toScript=Arab";

  const response = await fetch(url, {
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

  const transliteration =
    data && data[0] && data[0].text ? data[0].text : null;
  if (!transliteration) {
    throw new Error(`Azure empty transliteration: ${raw}`);
  }
  return transliteration;
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

  const response = await fetch(baseUrl, {
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

module.exports = { translateToUrdu, transliterateToUrdu };
