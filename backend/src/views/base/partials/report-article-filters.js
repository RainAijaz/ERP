(() => {
  const script = document.currentScript;
  const form = script?.closest("form");
  if (!form) return;
  const start = () => {
    const article = form.querySelector("[data-report-article-select]");
    const sku = form.querySelector("[data-report-sku-select]");
    if (!article || !sku || article.dataset.articleFiltersReady) return;
    article.dataset.articleFiltersReady = "true";
    const type = form.querySelector('[name="stock_type"], [name="stock_type_filter"], [name="plan_kind"], [name="type"]');
    const group = form.querySelector('[name="product_group_ids"]');
    const subgroup = form.querySelector('[name="product_subgroup_ids"]');
    const sourceMode = article.closest("[data-report-article-filter]").dataset.sourceArticles === "true";
    const all = "__ALL__";
    const selected = select => Array.from(select?.selectedOptions || []).map(option => option.value).filter(value => value && value !== all);
    const setAll = select => {
      Array.from(select.options).forEach(option => { option.selected = option.value === all; });
      select.dataset.prevHasAll = "1";
    };
    const filter = (select, accepts) => {
      for (const option of select.options) {
        const visible = option.value === all || accepts(option);
        option.hidden = !visible;
        option.disabled = !visible;
        if (!visible) option.selected = false;
      }
      if (!selected(select).length) setAll(select);
    };
    const sync = () => {
      const value = String(type?.value || "ALL").toUpperCase();
      const itemType = sourceMode ? (["FG", "SFG"].includes(value) ? value : "ALL")
        : ({ SEMIFINISHED: "SFG", RAWMATERIAL: "RM" }[value] || value);
      const groups = sourceMode ? [] : selected(group);
      const subgroups = sourceMode ? [] : selected(subgroup);
      const accepts = option => (itemType === "ALL" || option.dataset.itemType === itemType)
        && (!groups.length || groups.includes(option.dataset.groupId))
        && (!subgroups.length || subgroups.includes(option.dataset.subgroupId));
      filter(article, accepts);
      const articles = selected(article);
      filter(sku, option => accepts(option) && (!articles.length || articles.includes(option.dataset.articleId)));
      const rawMaterial = itemType === "RM";
      sku.disabled = rawMaterial;
      sku.closest("[data-report-sku-filter]").classList.toggle("hidden", rawMaterial);
      if (rawMaterial) setAll(sku);
      if (typeof window.refreshSearchableSelects === "function") window.refreshSearchableSelects(form);
    };
    for (const select of [type, group, subgroup, article]) select?.addEventListener("change", sync);
    form.addEventListener("reset", () => queueMicrotask(() => { setAll(article); setAll(sku); sync(); }));
    sync();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
