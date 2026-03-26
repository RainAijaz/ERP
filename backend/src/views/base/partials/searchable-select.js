(() => {
  const i18nSearch = '<%= t("search") %>';
  const i18nRequiredFields = '<%= t("error_required_fields") %>';
  const i18nSelect = '<%= t("select") %>';
  const i18nSelected = '<%= t("selected") || "selected" %>';

  if (typeof window !== "undefined") {
    const existing = window.VoucherValidation || {};
    window.VoucherValidation = {
      ...existing,
      requiredMessage(fieldLabel) {
        const label = String(fieldLabel || "").trim();
        return label ? `${i18nRequiredFields}: ${label}` : i18nRequiredFields;
      },
    };
  }

  const isWithinModal = (select) => !!select.closest("[data-modal-form]");
  const isSearchableOptIn = (select) =>
    String(select?.dataset?.searchableSelect || "").toLowerCase() === "true";
  const isMultiSelectWrapper = (select) =>
    !!select.closest("[data-multi-select]");
  const unifiedVariantClass =
    "h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-700 transition focus:border-black focus:outline-none focus:ring-2 focus:ring-black/20";
  const escapeAttributeValue = (value) => {
    const text = String(value || "");
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(text);
    }
    return text.replace(/["\\]/g, "\\$&");
  };

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
    const isVoucherContext = Boolean(
      select.closest(
        "[data-voucher-form], [data-purchase-voucher-form], [data-sales-voucher-form]",
      ),
    );

    const getFocusableFields = () => {
      const scope =
        select.closest("form") ||
        select.closest("[data-modal-form]") ||
        document.body;
      return Array.from(
        scope.querySelectorAll(
          "input, select, textarea, button, [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((el) => {
        if (!(el instanceof HTMLElement)) return false;
        if (el === select) return false;
        if (el.hasAttribute("disabled")) return false;
        if (el.getAttribute("aria-hidden") === "true") return false;
        if (el instanceof HTMLInputElement && el.type === "hidden")
          return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden")
          return false;
        if (el.offsetParent === null && style.position !== "fixed")
          return false;
        return true;
      });
    };

    const resolveTarget = (el) => {
      if (!el) return null;
      if (
        el instanceof HTMLSelectElement &&
        el.dataset.searchableReady === "true"
      ) {
        const wrapper =
          el.closest("[data-searchable-wrapper]") ||
          (el.parentElement?.matches("[data-searchable-wrapper]")
            ? el.parentElement
            : null);
        const searchableInput = wrapper?.querySelector(
          'input[type="text"]:not([readonly])',
        );
        return searchableInput || el;
      }
      return el;
    };

    const advanceFocusToNextField = () => {
      if (!isVoucherContext) return;
      const fields = getFocusableFields();
      const current = input;
      const idx = fields.indexOf(current);
      if (idx < 0) return;
      for (let i = idx + 1; i < fields.length; i += 1) {
        const nextField = fields[i];
        if (nextField === select) continue;
        const target = resolveTarget(nextField);
        if (!target || !(target instanceof HTMLElement)) continue;
        if (target === current) continue;
        target.focus();
        if (target instanceof HTMLInputElement) {
          const wrapper = target.closest("[data-searchable-wrapper]");
          if (wrapper) {
            target.dataset.searchableSuppressOpenOnce = "0";
            target.click();
          }
        }
        break;
      }
    };
    const isFocusableControl = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) {
        return false;
      }
      if (el.hasAttribute("disabled")) return false;
      if (el instanceof HTMLInputElement && el.type === "hidden") return false;
      if (el instanceof HTMLInputElement && el.readOnly) return false;
      if (el instanceof HTMLTextAreaElement && el.readOnly) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
      return el.offsetParent !== null || style.position === "fixed";
    };
    const focusControl = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      if (!el.isConnected) return false;
      if (el instanceof HTMLSelectElement) {
        const selectWrapper =
          el.closest("[data-searchable-wrapper]") ||
          (el.parentElement?.matches("[data-searchable-wrapper]")
            ? el.parentElement
            : null);
        const searchableInput = selectWrapper?.querySelector(
          'input[type="text"]:not([readonly])',
        );
        if (
          searchableInput instanceof HTMLInputElement &&
          searchableInput.isConnected
        ) {
          searchableInput.focus();
          searchableInput.click();
          return true;
        }
      }
      if (!isFocusableControl(el)) return false;
      el.focus();
      if (el instanceof HTMLInputElement && typeof el.select === "function") {
        el.select();
      }
      return true;
    };
    const resolveRowFieldAttrName = () => {
      const candidates = [
        "data-col",
        "data-sku-rule-col",
        "data-labour-rule-col",
        "data-row-field",
      ];
      for (let index = 0; index < candidates.length; index += 1) {
        const attrName = candidates[index];
        if (select.hasAttribute(attrName)) return attrName;
      }
      return "data-col";
    };
    const rowFieldAttrName = resolveRowFieldAttrName();
    const advanceFocusWithinRow = () => {
      const fieldKey = String(select.getAttribute(rowFieldAttrName) || "").trim();
      if (!fieldKey) return false;
      const row = select.closest("tr");
      if (!(row instanceof HTMLElement)) return false;
      const rowFields = Array.from(
        row.querySelectorAll(`[${rowFieldAttrName}]`),
      );
      if (!rowFields.length) return false;
      const currentIndex = rowFields.findIndex((field) => {
        if (!(field instanceof HTMLElement)) return false;
        const key = String(field.getAttribute(rowFieldAttrName) || "").trim();
        return key === fieldKey;
      });
      if (currentIndex < 0) return false;
      for (let idx = currentIndex + 1; idx < rowFields.length; idx += 1) {
        const candidate = rowFields[idx];
        if (!(candidate instanceof HTMLElement)) continue;
        if (focusControl(candidate)) return true;
      }
      return false;
    };
    const getNextRowFieldMeta = () => {
      const fieldKey = String(select.getAttribute(rowFieldAttrName) || "").trim();
      if (!fieldKey) return null;
      const row = select.closest("tr[data-row-index]");
      if (!(row instanceof HTMLElement)) return null;
      const rowIndexRaw = row.getAttribute("data-row-index");
      if (rowIndexRaw === null) return null;
      const rowIndex = String(rowIndexRaw).trim();
      if (rowIndex.length === 0) return null;
      const linesBody = row.closest("[data-lines-body]");
      if (!(linesBody instanceof HTMLElement)) return null;
      const linesType = String(linesBody.getAttribute("data-lines-body") || "").trim();
      if (!linesType) return null;

      const rowFields = Array.from(
        row.querySelectorAll(`[${rowFieldAttrName}]`),
      );
      if (!rowFields.length) return null;
      const currentIndex = rowFields.findIndex((field) => field === select);
      if (currentIndex < 0) return null;
      for (let idx = currentIndex + 1; idx < rowFields.length; idx += 1) {
        const candidate = rowFields[idx];
        if (!(candidate instanceof HTMLElement)) continue;
        const nextKey = String(candidate.getAttribute(rowFieldAttrName) || "").trim();
        if (!nextKey) continue;
        if (candidate instanceof HTMLSelectElement || isFocusableControl(candidate)) {
          return { linesType, rowIndex, nextKey };
        }
      }
      return null;
    };
    const focusNextRowFieldByMeta = (meta) => {
      if (!meta || typeof meta !== "object") return false;
      const linesType = String(meta.linesType || "").trim();
      const rowIndex = String(meta.rowIndex ?? "").trim();
      const nextKey = String(meta.nextKey || "").trim();
      if (!linesType || rowIndex.length === 0 || !nextKey) return false;
      const linesBody = document.querySelector(
        `[data-lines-body="${escapeAttributeValue(linesType)}"]`,
      );
      if (!(linesBody instanceof HTMLElement)) return false;
      const row = linesBody.querySelector(
        `tr[data-row-index="${escapeAttributeValue(rowIndex)}"]`,
      );
      if (!(row instanceof HTMLElement)) return false;
      const nextField = row.querySelector(
        `[${rowFieldAttrName}="${escapeAttributeValue(nextKey)}"]`,
      );
      return focusControl(nextField);
    };
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
      // Keep browser validation on the visible control, not the hidden original <select>.
      select.removeAttribute("required");
    }
    if (select.disabled) {
      input.readOnly = true;
      input.classList.add("bg-slate-50", "text-slate-600");
      input.classList.remove("cursor-text");
      input.classList.add("cursor-not-allowed");
      // Force disabled visual state even when base utility classes include bg-white.
      input.style.backgroundColor = "rgb(248 250 252)";
      input.style.color = "rgb(71 85 105)";
      input.style.caretColor = "transparent";
    }

    const icon = document.createElement("div");
    icon.className =
      "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition-transform duration-200 group-focus-within:rotate-180";
    icon.innerHTML =
      '<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" /></svg>';

    const menu = document.createElement("div");
    menu.className =
      "fixed z-50 hidden overflow-y-auto overflow-x-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl ring-1 ring-black/5";
    const customMenuZIndex = Number.parseInt(
      select.dataset.searchableMenuZIndex || "",
      10,
    );
    menu.style.zIndex = Number.isFinite(customMenuZIndex)
      ? String(customMenuZIndex)
      : "2400";

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
      const safeEdge = 8;
      const safeGap = 4;
      const minimumPreferredHeight = 160;
      const minimumFallbackHeight = 96;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const preferredMaxHeight = Math.max(
        minimumPreferredHeight,
        Math.floor(viewportHeight - safeEdge * 2),
      );

      const availableBelow = Math.floor(
        boundaryRect.bottom - inputRect.bottom - safeGap,
      );
      const availableAbove = Math.floor(
        inputRect.top - boundaryRect.top - safeGap,
      );
      let openUpward =
        availableBelow < minimumPreferredHeight && availableAbove > availableBelow;

      let availableSpace = openUpward ? availableAbove : availableBelow;
      if (availableSpace < minimumFallbackHeight) {
        const alternateSpace = openUpward ? availableBelow : availableAbove;
        if (alternateSpace > availableSpace) {
          openUpward = !openUpward;
          availableSpace = alternateSpace;
        }
      }

      const normalizedSpace = Math.max(0, availableSpace);
      const maxHeight = normalizedSpace >= minimumFallbackHeight
        ? Math.min(preferredMaxHeight, normalizedSpace)
        : Math.max(56, normalizedSpace);
      const targetWidth = Math.max(140, Math.floor(inputRect.width));
      const maxAllowedWidth = Math.max(140, viewportWidth - safeEdge * 2);
      const menuWidth = Math.min(targetWidth, maxAllowedWidth);
      let menuLeft = Math.floor(inputRect.left);
      if (menuLeft + menuWidth > viewportWidth - safeEdge) {
        menuLeft = Math.floor(viewportWidth - safeEdge - menuWidth);
      }
      if (menuLeft < safeEdge) menuLeft = safeEdge;

      menu.style.maxHeight = `${maxHeight}px`;
      menu.style.width = `${menuWidth}px`;
      menu.style.left = `${menuLeft}px`;
      if (openUpward) {
        // Anchor to the input's top edge to avoid visible gaps when menu content
        // is shorter than available upward space.
        const bottom = Math.floor(viewportHeight - inputRect.top + safeGap);
        menu.style.top = "auto";
        menu.style.bottom = `${Math.max(safeEdge, bottom)}px`;
      } else {
        let menuTop = Math.floor(inputRect.bottom + safeGap);
        const maxTop = Math.floor(viewportHeight - safeEdge - maxHeight);
        if (menuTop > maxTop) menuTop = maxTop;
        if (menuTop < safeEdge) menuTop = safeEdge;
        menu.style.top = `${menuTop}px`;
        menu.style.bottom = "auto";
      }
    };

    let activeIndex = -1;
    let keyboardNavigatedMenu = false;
    let multiSearchValue = "";

    const hasAllMultiSelect = isMulti
      && String(select.dataset.allMultiSelect || "").toLowerCase() === "true";
    const getAllOption = () => {
      if (!hasAllMultiSelect) return null;
      return Array.from(select.options).find((opt) => {
        const value = String(opt.value || "").trim().toLowerCase();
        return value === "__all__" || value === "all";
      }) || null;
    };
    const normalizeMultiSelectAll = (changedOption = null) => {
      if (!hasAllMultiSelect) return;
      const allOption = getAllOption();
      if (!allOption) return;
      const options = Array.from(select.options);
      const nonAllOptions = options.filter((opt) => opt !== allOption);

      if (changedOption === allOption && allOption.selected) {
        nonAllOptions.forEach((opt) => {
          opt.selected = false;
        });
        return;
      }

      if (
        changedOption
        && changedOption !== allOption
        && changedOption.selected
      ) {
        allOption.selected = false;
      }

      const hasNonAllSelected = nonAllOptions.some((opt) => opt.selected);
      if (!hasNonAllSelected) {
        allOption.selected = true;
      } else if (allOption.selected) {
        allOption.selected = false;
      }
    };

    const syncToInput = () => {
      if (isMulti) {
        normalizeMultiSelectAll(null);
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
      const rawFilterSource = isMulti ? multiSearchValue : input.value;
      let filter = showAll ? "" : String(rawFilterSource || "").trim().toLowerCase();
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
      if (isMulti) {
        const searchWrap = document.createElement("div");
        searchWrap.className = "sticky top-0 z-10 bg-white px-2 pt-2";
        const searchInput = document.createElement("input");
        searchInput.type = "search";
        searchInput.className =
          "h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 focus:border-black focus:bg-white focus:outline-none focus:ring-2 focus:ring-black/20";
        searchInput.placeholder = i18nSearch;
        searchInput.autocomplete = "off";
        searchInput.value = String(multiSearchValue || "");
        searchInput.setAttribute("data-searchable-multi-search", "true");
        searchInput.addEventListener("input", () => {
          multiSearchValue = searchInput.value || "";
          renderMenu({ showAll: false, preserveActive: true });
          menu.classList.remove("hidden");
          const replacement = menu.querySelector('[data-searchable-multi-search="true"]');
          if (replacement instanceof HTMLInputElement) {
            replacement.focus();
            const caretPos = replacement.value.length;
            replacement.setSelectionRange(caretPos, caretPos);
          }
        });
        searchWrap.appendChild(searchInput);
        menu.appendChild(searchWrap);
      }
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
            normalizeMultiSelectAll(opt);
            select.dispatchEvent(new Event("change", { bubbles: true }));
            syncToInput();
            renderMenu({ preserveActive: true });
            input.focus();
          } else {
            select.value = opt.value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            syncToInput();
            menu.classList.add("hidden");
            input.dataset.searchableSuppressOpenOnce = "1";
            window.setTimeout(() => {
              if (!input.isConnected) return;
              input.focus();
              input.select();
            }, 0);
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
      if (select.disabled) return;
      keyboardNavigatedMenu = false;
      if (input.dataset.searchableSuppressOpenOnce === "1") {
        input.dataset.searchableSuppressOpenOnce = "0";
        return;
      }
      input.select();
      renderMenu({ showAll: true });
      menu.classList.remove("hidden");
      if (isMulti) {
        window.setTimeout(() => {
          const multiSearchInput = menu.querySelector('[data-searchable-multi-search="true"]');
          if (multiSearchInput instanceof HTMLInputElement) {
            multiSearchInput.focus();
          }
        }, 0);
      }
    });
    input.addEventListener("click", () => {
      if (select.disabled) return;
      keyboardNavigatedMenu = false;
      renderMenu({ showAll: true });
      menu.classList.remove("hidden");
      if (isMulti) {
        window.setTimeout(() => {
          const multiSearchInput = menu.querySelector('[data-searchable-multi-search="true"]');
          if (multiSearchInput instanceof HTMLInputElement) {
            multiSearchInput.focus();
          }
        }, 0);
      }
    });
    input.addEventListener("input", () => {
      if (select.disabled) return;
      if (isMulti) {
        multiSearchValue = input.value || "";
      }
      keyboardNavigatedMenu = false;
      renderMenu({ showAll: false });
      menu.classList.remove("hidden");
    });
    input.addEventListener("keydown", (e) => {
      if (select.disabled) return;
      if (isMulti) return;
      const isGridArrowNavContext = Boolean(
        input.closest('[data-grid-arrow-nav="true"]'),
      );

      if (e.key === "Enter" && menu.classList.contains("hidden")) {
        if (isGridArrowNavContext) {
          // In row-grid contexts, let voucher-row-enter-navigation own Enter.
          return;
        }
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
        e.preventDefault();
        if (advanceFocusWithinRow()) {
          e.stopPropagation();
          return;
        }
        advanceFocusToNextField();
        return;
      }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (menu.classList.contains("hidden") && isGridArrowNavContext) {
          // Let voucher-row-enter-navigation handle row/column arrow movement.
          return;
        }
        e.preventDefault();

        if (menu.classList.contains("hidden")) {
          keyboardNavigatedMenu = false;
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
        keyboardNavigatedMenu = true;

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
        keyboardNavigatedMenu = false;
        return;
      }

      if (e.key !== "Enter") return;
      if (menu.classList.contains("hidden")) return;

      const filteredOptions = getFilteredOptions({ showAll: false });
      if (filteredOptions.length === 0) return;

      if (!keyboardNavigatedMenu) {
        activeIndex = getDefaultActiveIndex(filteredOptions);
      } else if (activeIndex < 0 || activeIndex >= filteredOptions.length) {
        activeIndex = getDefaultActiveIndex(filteredOptions);
      }

      const match =
        filteredOptions[activeIndex] && filteredOptions[activeIndex].value
          ? filteredOptions[activeIndex]
          : filteredOptions.find((opt) => !!opt.value);
      if (!match) return;

      e.preventDefault();
      const nextRowFieldMeta = getNextRowFieldMeta();
      const previousValue = String(select.value || "");
      const nextValue = String(match.value || "");
      select.value = nextValue;
      const valueChanged = previousValue !== nextValue;
      if (valueChanged) {
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      syncToInput();
      menu.classList.add("hidden");
      keyboardNavigatedMenu = false;
      if (isGridArrowNavContext) {
        e.stopPropagation();
        if (nextRowFieldMeta) {
          window.setTimeout(() => {
            if (focusNextRowFieldByMeta(nextRowFieldMeta)) return;
            if (advanceFocusWithinRow()) return;
            advanceFocusToNextField();
          }, 0);
          return;
        }
        if (advanceFocusWithinRow()) return;
        advanceFocusToNextField();
        return;
      }
      if (valueChanged && nextRowFieldMeta) {
        window.setTimeout(() => {
          if (focusNextRowFieldByMeta(nextRowFieldMeta)) return;
          advanceFocusToNextField();
        }, 0);
        return;
      }
      if (advanceFocusWithinRow()) return;
      advanceFocusToNextField();
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        menu.classList.add("hidden");
        keyboardNavigatedMenu = false;
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
    const handleViewportReposition = () => {
      if (menu.classList.contains("hidden")) return;
      positionMenu();
    };
    if (modalContent) {
      modalContent.addEventListener(
        "scroll",
        handleViewportReposition,
        { passive: true },
      );
    }

    window.addEventListener(
      "resize",
      handleViewportReposition,
      { passive: true },
    );
    window.addEventListener(
      "scroll",
      handleViewportReposition,
      { passive: true, capture: true },
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

  const initDataMultiSelects = (root = document) => {
    const scope = root && typeof root.querySelectorAll === "function" ? root : document;
    const wraps = Array.from(scope.querySelectorAll("[data-multi-select]"));
    let openRoot = null;

    const closeAll = () => {
      wraps.forEach((wrap) => {
        wrap.querySelector("[data-multi-panel]")?.classList.add("hidden");
      });
      openRoot = null;
    };

    wraps.forEach((wrap) => {
      if (wrap.dataset.dataMultiReady === "true") return;
      const trigger = wrap.querySelector("[data-multi-trigger]");
      const panel = wrap.querySelector("[data-multi-panel]");
      const hidden = wrap.querySelector("[data-multi-hidden]");
      const checkboxes = Array.from(wrap.querySelectorAll('[data-multi-panel] input[type="checkbox"]'));
      if (!trigger || !panel || !hidden) return;

      wrap.dataset.dataMultiReady = "true";
      const allValue = String(wrap.dataset.multiAllValue || "").trim();
      const autoAll = String(wrap.dataset.multiAutoAll || "").trim() === "1";
      const optionsContainer = panel.querySelector("[data-multi-options]") || panel;
      const optionRows = checkboxes
        .map((cb) => cb.closest("label"))
        .filter((label) => label && optionsContainer.contains(label));

      const searchInput = document.createElement("input");
      searchInput.type = "search";
      searchInput.className =
        "mb-2 h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 focus:border-black focus:bg-white focus:outline-none focus:ring-2 focus:ring-black/20";
      searchInput.placeholder = i18nSearch;
      searchInput.autocomplete = "off";
      searchInput.setAttribute("data-multi-search", "true");

      const noResults = document.createElement("div");
      noResults.className = "hidden px-2 py-2 text-center text-xs italic text-slate-400";
      noResults.textContent = "<%= t('no_records_found') %>";

      if (!panel.querySelector("[data-multi-search]")) {
        panel.insertBefore(searchInput, panel.firstChild);
      }
      if (!panel.querySelector("[data-multi-no-results]")) {
        noResults.setAttribute("data-multi-no-results", "true");
        panel.appendChild(noResults);
      }

      const searchField = panel.querySelector("[data-multi-search]");
      const noResultsNode = panel.querySelector("[data-multi-no-results]");

      const applyFilter = () => {
        const query = String(searchField?.value || "").trim().toLowerCase();
        let visibleCount = 0;
        optionRows.forEach((row) => {
          const label = String(row.textContent || "").trim().toLowerCase();
          const matched = !query || label.includes(query);
          row.classList.toggle("hidden", !matched);
          if (matched) visibleCount += 1;
        });
        if (noResultsNode) {
          noResultsNode.classList.toggle("hidden", visibleCount > 0);
        }
      };

      const getAllCheckbox = () => {
        if (!allValue) return null;
        return checkboxes.find((cb) => String(cb.value || "").trim() === allValue) || null;
      };

      const normalizeSelection = (changedCheckbox) => {
        const allCheckbox = getAllCheckbox();
        if (!allCheckbox) return;

        const nonAllCheckboxes = checkboxes.filter((cb) => cb !== allCheckbox);
        if (changedCheckbox === allCheckbox && allCheckbox.checked) {
          nonAllCheckboxes.forEach((cb) => {
            cb.checked = false;
          });
          return;
        }

        if (changedCheckbox && changedCheckbox !== allCheckbox && changedCheckbox.checked) {
          allCheckbox.checked = false;
        }

        const checkedNonAll = nonAllCheckboxes.filter((cb) => cb.checked);
        if (!checkedNonAll.length && autoAll) {
          allCheckbox.checked = true;
          return;
        }

        if (checkedNonAll.length && allCheckbox.checked) {
          allCheckbox.checked = false;
        }
      };

      const refresh = () => {
        const selected = checkboxes.filter((cb) => cb.checked);
        const selectedValues = selected
          .map((cb) => String(cb.value || "").trim())
          .filter((value) => Boolean(value) && value !== allValue);
        hidden.value = selectedValues.join(",");
        hidden.dispatchEvent(new Event("change", { bubbles: true }));

        if (!selectedValues.length) {
          trigger.textContent = String(wrap.dataset.placeholder || i18nSelect);
          return;
        }
        if (selectedValues.length === 1) {
          const selectedCheckbox = selected.find((cb) => String(cb.value || "").trim() === selectedValues[0]);
          const label = selectedCheckbox?.closest("label")?.querySelector("span")?.textContent || selectedValues[0];
          trigger.textContent = label;
          return;
        }
        trigger.textContent = `${selectedValues.length} ${i18nSelected}`;
      };

      normalizeSelection(null);
      refresh();

      checkboxes.forEach((cb) => {
        cb.addEventListener("change", () => {
          normalizeSelection(cb);
          refresh();
          applyFilter();
        });
      });

      if (searchField) {
        searchField.addEventListener("input", applyFilter);
      }

      trigger.addEventListener("click", (event) => {
        event.preventDefault();
        const wasHidden = panel.classList.contains("hidden");
        closeAll();
        if (wasHidden) {
          panel.classList.remove("hidden");
          applyFilter();
          if (searchField) {
            window.setTimeout(() => searchField.focus(), 0);
          }
          openRoot = wrap;
        }
      });
    });

    if (!window.__dataMultiSelectGlobalListenersAttached) {
      document.addEventListener("click", (event) => {
        if (!openRoot) return;
        if (openRoot.contains(event.target)) return;
        closeAll();
      });

      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeAll();
      });
      window.__dataMultiSelectGlobalListenersAttached = true;
    }
  };

  if (typeof window !== "undefined") {
    if (!window.initSearchableSelects) {
      document.addEventListener("DOMContentLoaded", initSearchableSelects);
    }
    window.initSearchableSelects = initSearchableSelects;
    window.initDataMultiSelects = initDataMultiSelects;
    document.addEventListener("DOMContentLoaded", () => {
      initDataMultiSelects(document);
    });
  }
})();
