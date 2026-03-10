(function () {
  const SKIP_DATE_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "OPTION"]);
  const ISO_DATE_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})(?!\d)\b/g;

  const trimNumericString = (value) => {
    const text = String(value ?? "").trim();
    if (!text) return "";
    if (!text.includes(".")) return text === "-0" ? "0" : text;
    const normalized = text
      .replace(/(\.\d*?[1-9])0+$/, "$1")
      .replace(/\.0+$/, "")
      .replace(/\.$/, "");
    return normalized === "-0" ? "0" : normalized;
  };

  const formatNumber = (value, options = {}) => {
    const fallback = Object.prototype.hasOwnProperty.call(options, "fallback") ? options.fallback : "";
    if (value === null || value === undefined || value === "") return fallback;
    const decimals = Number.isInteger(options.decimals) && options.decimals >= 0 ? options.decimals : null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      const raw = String(value).trim();
      return raw || fallback;
    }
    const rounded = decimals === null ? numeric : Number(numeric.toFixed(decimals));
    return trimNumericString(String(rounded));
  };

  const formatDate = (value, fallback = "-") => {
    if (value === null || value === undefined || value === "") return fallback;
    const text = String(value).trim();
    const ymdMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (ymdMatch) return ymdMatch[3] + "-" + ymdMatch[2] + "-" + ymdMatch[1];
    const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})[T\s].*$/);
    if (isoMatch) return isoMatch[3] + "-" + isoMatch[2] + "-" + isoMatch[1];
    const dt = new Date(text);
    if (Number.isNaN(dt.getTime())) return text || fallback;
    const dd = String(dt.getDate()).padStart(2, "0");
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const yyyy = String(dt.getFullYear());
    return dd + "-" + mm + "-" + yyyy;
  };

  const normalizeNumericInput = (input) => {
    if (!(input instanceof HTMLInputElement) || input.type !== "number") return;
    if (input.dataset.erpUserEdited === "true") return;
    const nextValue = trimNumericString(input.value);
    if (nextValue !== input.value) input.value = nextValue;
  };

  const normalizeNumericInputs = (root) => {
    const scope = root instanceof Element || root instanceof Document ? root : document;
    scope.querySelectorAll('input[type="number"]').forEach(normalizeNumericInput);
  };

  const shouldSkipDateTextNode = (node) => {
    const parent = node?.parentElement;
    if (!parent) return true;
    if (parent.closest("[data-keep-iso-date]")) return true;
    if (parent.isContentEditable) return true;
    return SKIP_DATE_TAGS.has(parent.tagName);
  };

  const normalizeDateTextNode = (node) => {
    if (!(node instanceof Text) || shouldSkipDateTextNode(node)) return;
    const original = String(node.nodeValue || "");
    if (!original || !ISO_DATE_PATTERN.test(original)) return;
    ISO_DATE_PATTERN.lastIndex = 0;
    const nextValue = original.replace(ISO_DATE_PATTERN, (_match, yyyy, mm, dd) => dd + "-" + mm + "-" + yyyy);
    if (nextValue !== original) node.nodeValue = nextValue;
  };

  const normalizeDateText = (root) => {
    if (!root) return;
    if (root instanceof Text) {
      normalizeDateTextNode(root);
      return;
    }
    const scope = root instanceof Element || root instanceof Document ? root : document.body;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let current = walker.nextNode();
    while (current) {
      nodes.push(current);
      current = walker.nextNode();
    }
    nodes.forEach(normalizeDateTextNode);
  };

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === "characterData") {
        normalizeDateTextNode(mutation.target);
        return;
      }
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Text) {
          normalizeDateTextNode(node);
          return;
        }
        if (node instanceof Element) {
          normalizeNumericInputs(node);
          normalizeDateText(node);
        }
      });
    });
  });

  const init = () => {
    normalizeNumericInputs(document);
    normalizeDateText(document.body);
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  };

  document.addEventListener(
    "input",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === "number") {
        target.dataset.erpUserEdited = "true";
      }
    },
    true,
  );

  window.erpDisplay = {
    trimNumericString,
    formatNumber,
    formatDate,
    normalizeNumericInput,
    normalizeNumericInputs,
    normalizeDateText,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
