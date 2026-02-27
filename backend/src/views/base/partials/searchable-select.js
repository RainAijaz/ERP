(() => {
  const i18nSearch = '<%= t("search") %>';
  const isWithinModal = (select) => !!select.closest("[data-modal-form]");
  const isSearchableOptIn = (select) =>
    String(select?.dataset?.searchableSelect || "").toLowerCase() === "true";
  const isMultiSelectWrapper = (select) =>
    !!select.closest("[data-multi-select]");
  const unifiedVariantClass =
    "h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-700 transition focus:border-black focus:outline-none focus:ring-2 focus:ring-black/20";

  const makePlaceholder = (select) => {
    const label = select.closest("label")?.querySelector("span");
    const labelText = label ? label.textContent.trim() : "";
    return labelText ? `${i18nSearch} ${labelText}` : i18nSearch;
  };

  const createSearchableSelect = (select) => {
    if (!select) return;
    if (
      (!isWithinModal(select) && !isSearchableOptIn(select)) ||
      isMultiSelectWrapper(select)
    )
      return;
    if (select.dataset.searchableReady === "true") return;

    const isMulti = select.multiple;
    let placeholderText = makePlaceholder(select);
    const emptyOption = Array.from(select.options).find((opt) => !opt.value);
    if (emptyOption && emptyOption.textContent.trim()) {
      placeholderText = emptyOption.textContent.trim();
    }

    const wrapper = document.createElement("div");
    wrapper.className = "relative w-full group";
    wrapper.setAttribute("data-searchable-wrapper", "true");

    const input = document.createElement("input");
    input.type = "text";
    const variant = String(select.dataset.searchableVariant || "")
      .trim()
      .toLowerCase();
    if (variant === "unified") {
      input.className = `${unifiedVariantClass} pr-10`;
    } else {
      input.className =
        select.className.replace("appearance-none", "") + " pr-10";
      if (!input.className.includes("border")) {
        input.className +=
          " w-full rounded-lg border border-slate-200 bg-slate-50/50 px-3 py-2.5 text-sm text-slate-800 transition focus:border-black focus:bg-white focus:outline-none focus:ring-2 focus:ring-black/20";
      }
    }
    input.placeholder = placeholderText;
    input.autocomplete = "off";

    if (select.hasAttribute("required")) {
      input.required = true;
      if (!isMulti) select.removeAttribute("required");
    }

    const icon = document.createElement("div");
    icon.className =
      "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition-transform duration-200 group-focus-within:rotate-180";
    icon.innerHTML =
      '<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>';

    const menu = document.createElement("div");
    menu.className =
      "absolute left-0 right-0 z-50 hidden max-h-60 overflow-y-auto overflow-x-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl ring-1 ring-black/5";
    const customMenuZIndex = Number.parseInt(
      select.dataset.searchableMenuZIndex || "",
      10,
    );
    if (Number.isFinite(customMenuZIndex)) {
      menu.style.zIndex = String(customMenuZIndex);
    }

    const getBoundaryRect = () => {
      const modalForm = select.closest("[data-modal-form]");
      const modalContent = modalForm
        ? modalForm.querySelector("#modal-content")
        : null;
      if (modalContent) {
        return modalContent.getBoundingClientRect();
      }
      return {
        top: 8,
        bottom: window.innerHeight - 8,
      };
    };

    const positionMenu = () => {
      const inputRect = input.getBoundingClientRect();
      const boundaryRect = getBoundaryRect();
      const safeGap = 8;
      const minMenuHeight = 120;
      const preferredMaxHeight = 240;

      const availableBelow = Math.floor(
        boundaryRect.bottom - inputRect.bottom - safeGap,
      );
      const availableAbove = Math.floor(
        inputRect.top - boundaryRect.top - safeGap,
      );
      const openUpward =
        availableBelow < minMenuHeight && availableAbove > availableBelow;

      const availableSpace = openUpward ? availableAbove : availableBelow;
      const boundedHeight = Math.min(
        preferredMaxHeight,
        availableSpace > 0 ? availableSpace : preferredMaxHeight,
      );
      const maxHeight = Math.max(100, boundedHeight);

      menu.style.maxHeight = `${maxHeight}px`;
      menu.style.marginTop = "0";
      menu.style.marginBottom = "0";

      if (openUpward) {
        menu.style.top = "auto";
        menu.style.bottom = "calc(100% + 0.25rem)";
      } else {
        menu.style.top = "calc(100% + 0.25rem)";
        menu.style.bottom = "auto";
      }
    };

    let activeIndex = -1;

    const syncToInput = () => {
      if (isMulti) {
        const labels = Array.from(select.selectedOptions).map((opt) =>
          opt.textContent.trim(),
        );
        input.value = labels.length ? labels.join(", ") : "";
      } else {
        const selected = select.options[select.selectedIndex];
        input.value = selected ? selected.textContent.trim() : "";
      }
    };

    const getFilteredOptions = ({ showAll = false } = {}) => {
      let filter = showAll ? "" : input.value.trim().toLowerCase();
      if (isMulti) {
        const currentString = Array.from(select.selectedOptions)
          .map((opt) => opt.textContent.trim())
          .join(", ")
          .toLowerCase();
        if (filter === currentString) filter = "";
      } else {
        const selected = select.options[select.selectedIndex];
        const selectedLabel = String(selected?.textContent || "")
          .trim()
          .toLowerCase();
        const selectedValue = String(selected?.value || "").trim();
        if (!selectedValue && selectedLabel && filter === selectedLabel) {
          filter = "";
        }
      }

      return Array.from(select.options).filter((opt) => {
        const isEmptyOption = !opt.value;
        if (isEmptyOption && isMulti) return false;
        const label = opt.textContent.trim();
        const isMatch = !filter || label.toLowerCase().includes(filter);
        const isExactMatch = !isMulti && input.value.trim() === label;
        return isMatch || isExactMatch;
      });
    };

    const getDefaultActiveIndex = (filteredOptions) => {
      if (filteredOptions.length === 0) return -1;
      if (isMulti) return -1;
      const selectedIndex = filteredOptions.findIndex(
        (opt) => opt.selected && !!opt.value,
      );
      if (selectedIndex >= 0) return selectedIndex;
      return filteredOptions.findIndex((opt) => !!opt.value);
    };

    const renderMenu = ({ showAll = false, preserveActive = false } = {}) => {
      menu.innerHTML = "";
      const filteredOptions = getFilteredOptions({ showAll });

      if (!preserveActive) {
        activeIndex = getDefaultActiveIndex(filteredOptions);
      } else if (activeIndex >= filteredOptions.length) {
        activeIndex = filteredOptions.length - 1;
      }

      filteredOptions.forEach((opt, index) => {
        const label = opt.textContent.trim();
        const isActive = !isMulti && index === activeIndex;
        const stateClass = isActive
          ? "bg-slate-100 text-slate-900 font-semibold"
          : opt.selected
            ? "bg-slate-50 text-slate-900 font-medium"
            : "text-slate-600";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `flex w-full min-w-0 items-center justify-between gap-2 px-4 py-2.5 text-left text-sm transition hover:bg-slate-50 ${stateClass}`;
        btn.setAttribute("data-searchable-option", "true");
        btn.setAttribute("data-active", isActive ? "true" : "false");
        btn.title = label;

        let iconHtml = "";
        if (isMulti) {
          iconHtml = opt.selected
            ? '<svg class="h-4 w-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>'
            : '<span class="h-4 w-4 block border border-slate-300 rounded-sm"></span>';
        } else if (opt.selected) {
          iconHtml =
            '<svg class="h-4 w-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>';
        }
        btn.innerHTML = `<span class="block min-w-0 flex-1 truncate">${label}</span><span class="flex-none">${iconHtml}</span>`;

        btn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          activeIndex = index;
          if (isMulti) {
            opt.selected = !opt.selected;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            syncToInput();
            renderMenu({ preserveActive: true });
            input.focus();
          } else {
            select.value = opt.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            syncToInput();
            menu.classList.add("hidden");
          }
        });
        menu.appendChild(btn);
      });

      if (filteredOptions.length === 0) {
        const empty = document.createElement("div");
        empty.className =
          "px-4 py-3 text-xs text-slate-400 text-center italic select-none";
        empty.textContent = "<%= t('no_records_found') %>";
        menu.appendChild(empty);
      }

      positionMenu();
    };

    input.addEventListener("focus", () => {
      if (input.dataset.searchableSuppressOpenOnce === "1") {
        input.dataset.searchableSuppressOpenOnce = "0";
        return;
      }
      input.select();
      renderMenu({ showAll: true });
      menu.classList.remove("hidden");
    });
    input.addEventListener("click", () => {
      renderMenu({ showAll: true });
      menu.classList.remove("hidden");
    });
    input.addEventListener("input", () => {
      renderMenu({ showAll: false });
      menu.classList.remove("hidden");
    });
    input.addEventListener("keydown", (e) => {
      if (isMulti) return;

      if (e.key === "Enter" && menu.classList.contains("hidden")) {
        if (input.dataset.searchableAdvanceNext === "1") {
          input.dataset.searchableAdvanceNext = "0";
          return;
        }
        const selected = select.options[select.selectedIndex];
        const selectedValue = String(selected?.value || "").trim();
        if (!selectedValue) {
          e.preventDefault();
          e.stopPropagation();
          renderMenu({ showAll: true });
          menu.classList.remove("hidden");
          return;
        }
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();

        if (menu.classList.contains("hidden")) {
          renderMenu({ showAll: true });
          menu.classList.remove("hidden");
          return;
        }

        const filteredOptions = getFilteredOptions({ showAll: false });
        if (filteredOptions.length === 0) return;

        if (activeIndex < 0 || activeIndex >= filteredOptions.length) {
          activeIndex = getDefaultActiveIndex(filteredOptions);
        } else if (e.key === "ArrowDown") {
          activeIndex = (activeIndex + 1) % filteredOptions.length;
        } else {
          activeIndex =
            (activeIndex - 1 + filteredOptions.length) % filteredOptions.length;
        }

        const current = filteredOptions[activeIndex];
        if (current && !current.value) {
          const direction = e.key === "ArrowDown" ? 1 : -1;
          let idx = activeIndex;
          for (let step = 0; step < filteredOptions.length; step += 1) {
            idx =
              (idx + direction + filteredOptions.length) %
              filteredOptions.length;
            if (filteredOptions[idx]?.value) {
              activeIndex = idx;
              break;
            }
          }
        }

        renderMenu({ showAll: false, preserveActive: true });
        const activeButton = menu.querySelector(
          '[data-searchable-option][data-active="true"]',
        );
        if (activeButton) {
          activeButton.scrollIntoView({ block: "nearest" });
        }
        return;
      }

      if (e.key === "Escape") {
        menu.classList.add("hidden");
        return;
      }

      if (e.key !== "Enter") return;
      if (menu.classList.contains("hidden")) return;

      const filteredOptions = getFilteredOptions({ showAll: false });
      if (filteredOptions.length === 0) return;

      if (activeIndex < 0 || activeIndex >= filteredOptions.length) {
        activeIndex = getDefaultActiveIndex(filteredOptions);
      }

      const match =
        filteredOptions[activeIndex] && filteredOptions[activeIndex].value
          ? filteredOptions[activeIndex]
          : filteredOptions.find((opt) => !!opt.value);
      if (!match) return;

      e.preventDefault();
      select.value = match.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      syncToInput();
      menu.classList.add("hidden");
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        menu.classList.add("hidden");
        if (isMulti) {
          syncToInput();
        } else {
          const val = input.value.trim().toLowerCase();
          const match = Array.from(select.options).find(
            (opt) => opt.value && opt.textContent.trim().toLowerCase() === val,
          );
          if (match) {
            if (select.value !== match.value) {
              select.value = match.value;
              select.dispatchEvent(new Event("change", { bubbles: true }));
            }
          } else if (val === "") {
            select.value = "";
            select.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            syncToInput();
          }
        }
      }, 150);
    });

    const modalForm = select.closest("[data-modal-form]");
    const modalContent = modalForm
      ? modalForm.querySelector("#modal-content")
      : null;
    if (modalContent) {
      modalContent.addEventListener(
        "scroll",
        () => {
          if (menu.classList.contains("hidden")) return;
          positionMenu();
        },
        { passive: true },
      );
    }

    window.addEventListener(
      "resize",
      () => {
        if (menu.classList.contains("hidden")) return;
        positionMenu();
      },
      { passive: true },
    );

    select.addEventListener("change", syncToInput);
    select.classList.add("sr-only");
    select.dataset.searchableReady = "true";
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(input);
    wrapper.appendChild(icon);
    wrapper.appendChild(menu);
    wrapper.appendChild(select);
    syncToInput();
  };

  const initSearchableSelects = () => {
    document.querySelectorAll("select").forEach((select) => {
      if (!select) return;
      if (select.dataset.searchableSkip === "true") return;
      createSearchableSelect(select);
    });
  };

  if (typeof window !== "undefined") {
    if (!window.initSearchableSelects) {
      document.addEventListener("DOMContentLoaded", initSearchableSelects);
    }
    window.initSearchableSelects = initSearchableSelects;
  }
})();
