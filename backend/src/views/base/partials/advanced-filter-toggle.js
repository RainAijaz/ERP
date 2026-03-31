(function initAdvancedFilterToggleGlobal() {
  if (typeof window === "undefined") return;
  if (typeof window.initAdvancedFilterToggle === "function") return;

  window.initAdvancedFilterToggle = function initAdvancedFilterToggle(options = {}) {
    const root = options.root || document;
    const toggleSelector = options.toggleSelector || "[data-advanced-filter-toggle]";
    const panelSelector = options.panelSelector || "[data-advanced-filter-panel]";
    const toggle = root.querySelector(toggleSelector);
    const panel = root.querySelector(panelSelector);
    if (!toggle || !panel) return;

    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      panel.classList.toggle("hidden", expanded);
    });
  };
})();
