(() => {
  const isElementVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.hasAttribute("disabled")) return false;
    if (el instanceof HTMLInputElement && el.type === "hidden") return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return el.offsetParent !== null || style.position === "fixed";
  };

  const isFocusableRowField = (field) => {
    if (!(field instanceof HTMLElement)) return false;
    if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) {
      return false;
    }
    if (field instanceof HTMLInputElement && field.type === "hidden") return false;
    if (field instanceof HTMLInputElement && field.readOnly) return false;
    if (field instanceof HTMLTextAreaElement && field.readOnly) return false;
    if (field instanceof HTMLSelectElement && String(field.dataset.searchableReady || "") === "true") {
      return !field.disabled;
    }
    if (field.disabled) return false;
    return isElementVisible(field);
  };

  const focusFieldElement = (field, { openSearchable = true } = {}) => {
    if (!isFocusableRowField(field)) return false;
    if (field instanceof HTMLSelectElement) {
      const wrapper =
        field.closest("[data-searchable-wrapper]")
        || (field.parentElement?.matches("[data-searchable-wrapper]")
          ? field.parentElement
          : null);
      const searchableInput = wrapper?.querySelector('input[type="text"]:not([readonly])');
      if (searchableInput instanceof HTMLInputElement) {
        if (!openSearchable) {
          searchableInput.dataset.searchableSuppressOpenOnce = "1";
        }
        searchableInput.focus();
        if (openSearchable && typeof searchableInput.click === "function") {
          searchableInput.click();
        }
        return true;
      }
    }
    field.focus();
    if (field instanceof HTMLInputElement && typeof field.select === "function") {
      field.select();
    }
    return true;
  };

  const escapeAttributeValue = (value) => {
    const text = String(value || "");
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(text);
    }
    return text.replace(/["\\]/g, "\\$&");
  };

  const createVoucherRowEnterNavigator = ({
    form,
    linesBody,
    rowSelector = "tr",
    fieldAttr = "data-row-field",
    fieldOrder = [],
    appendRow = null,
    canAppendRow = null,
    shouldHandle = null,
  } = {}) => {
    if (!(form instanceof HTMLElement) || !(linesBody instanceof HTMLElement)) {
      return null;
    }

    const normalizedOrder = Array.isArray(fieldOrder)
      ? fieldOrder.map((key) => String(key || "").trim()).filter(Boolean)
      : [];
    const hasConfiguredOrder = normalizedOrder.length > 0;

    const rowMatches = (row) =>
      row instanceof HTMLElement
      && row.matches(rowSelector)
      && linesBody.contains(row);

    const getRows = () =>
      Array.from(linesBody.querySelectorAll(rowSelector)).filter((row) => rowMatches(row));

    const getFieldByKey = (row, key) => {
      if (!rowMatches(row) || !key) return null;
      return row.querySelector(`[${fieldAttr}="${escapeAttributeValue(key)}"]`);
    };

    const getFieldKeysInRow = (row) => {
      if (!rowMatches(row)) return [];
      if (hasConfiguredOrder) return normalizedOrder;
      return Array.from(row.querySelectorAll(`[${fieldAttr}]`))
        .map((el) => String(el.getAttribute(fieldAttr) || "").trim())
        .filter(Boolean);
    };

    const resolveFieldKey = (target) => {
      if (!(target instanceof HTMLElement)) return "";
      const direct = String(target.getAttribute(fieldAttr) || "").trim();
      if (direct) return direct;

      const fieldHost = target.closest(`[${fieldAttr}]`);
      const hostKey = String(fieldHost?.getAttribute(fieldAttr) || "").trim();
      if (hostKey) return hostKey;

      const wrapper = target.closest("[data-searchable-wrapper]");
      const linkedSelect = wrapper?.querySelector(`select[${fieldAttr}]`) || null;
      return String(linkedSelect?.getAttribute(fieldAttr) || "").trim();
    };

    const focusFirstFieldInRow = (row, { openSearchable = true } = {}) => {
      const keys = getFieldKeysInRow(row);
      for (let index = 0; index < keys.length; index += 1) {
        const field = getFieldByKey(row, keys[index]);
        if (focusFieldElement(field, { openSearchable })) return true;
      }
      return false;
    };
    const focusLastFieldInRow = (row, { openSearchable = true } = {}) => {
      const keys = getFieldKeysInRow(row);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const field = getFieldByKey(row, keys[index]);
        if (focusFieldElement(field, { openSearchable })) return true;
      }
      return false;
    };

    const focusNextFieldInSameRow = (row, currentKey) => {
      const keys = getFieldKeysInRow(row);
      if (!keys.length) return false;
      const currentIndex = keys.indexOf(String(currentKey || ""));
      if (currentIndex < 0) return false;
      for (let index = currentIndex + 1; index < keys.length; index += 1) {
        const field = getFieldByKey(row, keys[index]);
        if (focusFieldElement(field, { openSearchable: true })) return true;
      }
      return false;
    };
    const focusPreviousFieldInSameRow = (row, currentKey) => {
      const keys = getFieldKeysInRow(row);
      if (!keys.length) return false;
      const currentIndex = keys.indexOf(String(currentKey || ""));
      if (currentIndex < 0) return false;
      for (let index = currentIndex - 1; index >= 0; index -= 1) {
        const field = getFieldByKey(row, keys[index]);
        if (focusFieldElement(field, { openSearchable: true })) return true;
      }
      return false;
    };
    const focusSameFieldInAdjacentRows = (currentRow, fieldKey, rowStep) => {
      const rows = getRows();
      const currentIndex = rows.indexOf(currentRow);
      if (currentIndex < 0 || !rowStep) return false;
      for (
        let rowIndex = currentIndex + rowStep;
        rowIndex >= 0 && rowIndex < rows.length;
        rowIndex += rowStep
      ) {
        const row = rows[rowIndex];
        const sameField = getFieldByKey(row, fieldKey);
        if (focusFieldElement(sameField, { openSearchable: true })) return true;
        if (rowStep > 0) {
          if (focusFirstFieldInRow(row, { openSearchable: true })) return true;
        } else if (focusLastFieldInRow(row, { openSearchable: true })) {
          return true;
        }
      }
      return false;
    };
    const moveByArrow = (row, fieldKey, directionKey) => {
      if (!rowMatches(row) || !fieldKey) return false;
      if (directionKey === "ArrowUp") {
        return focusSameFieldInAdjacentRows(row, fieldKey, -1);
      }
      if (directionKey === "ArrowDown") {
        return focusSameFieldInAdjacentRows(row, fieldKey, 1);
      }
      if (directionKey === "ArrowRight") {
        if (focusNextFieldInSameRow(row, fieldKey)) return true;
        const rows = getRows();
        const rowIndex = rows.indexOf(row);
        if (rowIndex < 0) return false;
        if (focusFirstAvailableRowFromIndex(rowIndex + 1, { openSearchable: true })) {
          return true;
        }
        return appendAndFocusNextRow(row);
      }
      if (directionKey === "ArrowLeft") {
        if (focusPreviousFieldInSameRow(row, fieldKey)) return true;
        const rows = getRows();
        const rowIndex = rows.indexOf(row);
        if (rowIndex <= 0) return false;
        for (let idx = rowIndex - 1; idx >= 0; idx -= 1) {
          if (focusLastFieldInRow(rows[idx], { openSearchable: true })) return true;
        }
      }
      return false;
    };

    const focusFirstAvailableRowFromIndex = (startIndex, { openSearchable = true } = {}) => {
      const rows = getRows();
      if (!rows.length) return false;
      if (!Number.isInteger(startIndex)) return false;
      const normalizedStart = Math.max(0, startIndex);
      if (normalizedStart >= rows.length) return false;
      for (let rowIndex = normalizedStart; rowIndex < rows.length; rowIndex += 1) {
        if (focusFirstFieldInRow(rows[rowIndex], { openSearchable })) {
          return true;
        }
      }
      return false;
    };

    const appendAndFocusNextRow = (currentRow) => {
      const rowsBefore = getRows();
      const currentIndex = rowsBefore.indexOf(currentRow);
      if (currentIndex < 0) return false;
      const canAppend =
        typeof canAppendRow === "function"
          ? Boolean(canAppendRow({ row: currentRow, rowIndex: currentIndex }))
          : Boolean(appendRow);
      if (!canAppend || typeof appendRow !== "function") return false;

      const appended = appendRow();
      if (appended === false) return false;

      window.setTimeout(() => {
        const startRowIndex = currentIndex + 1;
        if (focusFirstAvailableRowFromIndex(startRowIndex, { openSearchable: true })) {
          return;
        }

        // Keep searching for a valid row by appending a small bounded number
        // of extra rows; this prevents focus loss when generated rows are locked.
        let extraAppendAttempts = 0;
        const maxExtraAppendAttempts = 4;
        const tryAppendUntilFocusable = () => {
          if (focusFirstAvailableRowFromIndex(startRowIndex, { openSearchable: true })) {
            return;
          }
          if (extraAppendAttempts >= maxExtraAppendAttempts) return;
          const canAppendMore =
            typeof canAppendRow === "function"
              ? Boolean(canAppendRow({ row: null, rowIndex: -1 }))
              : Boolean(appendRow);
          if (!canAppendMore || typeof appendRow !== "function") return;
          const appendedMore = appendRow();
          if (appendedMore === false) return;
          extraAppendAttempts += 1;
          window.setTimeout(tryAppendUntilFocusable, 0);
        };

        tryAppendUntilFocusable();
      }, 0);
      return true;
    };

    const moveForwardFrom = (row, fieldKey, { defer = false } = {}) => {
      if (!(row instanceof HTMLElement) || !fieldKey) return false;
      if (!defer && !rowMatches(row)) return false;

      const runMove = (targetRow) => {
        if (!rowMatches(targetRow)) return false;
        if (focusNextFieldInSameRow(targetRow, fieldKey)) return true;

        const rows = getRows();
        const rowIndex = rows.indexOf(targetRow);
        if (rowIndex < 0) return false;
        const nextRowIndex = rowIndex + 1;
        if (focusFirstAvailableRowFromIndex(nextRowIndex, { openSearchable: true })) {
          return true;
        }
        return appendAndFocusNextRow(targetRow);
      };

      if (!defer) return runMove(row);
      const rowIndex = getRows().indexOf(row);
      const rowStableAttrName = row.hasAttribute("data-row-index")
        ? "data-row-index"
        : row.hasAttribute("data-index")
          ? "data-index"
          : "";
      const rowStableAttrValue = rowStableAttrName
        ? String(row.getAttribute(rowStableAttrName) || "")
        : "";
      window.setTimeout(() => {
        const rows = getRows();
        let refreshedRow = null;
        if (rowStableAttrName && rowStableAttrValue) {
          refreshedRow = rows.find((candidate) =>
            String(candidate.getAttribute(rowStableAttrName) || "") === rowStableAttrValue,
          ) || null;
        }
        if (!refreshedRow && rowIndex >= 0) {
          refreshedRow = rows[rowIndex] || null;
        }
        if (!(refreshedRow instanceof HTMLElement)) return;
        runMove(refreshedRow);
      }, 0);
      return true;
    };

    const captureSearchableState = (event) => {
      if (event.key !== "Enter") return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!linesBody.contains(target)) return;
      const wrapper = target.closest("[data-searchable-wrapper]");
      if (!wrapper) return;
      const menu = wrapper.querySelector("div.z-50");
      const isOpen = Boolean(menu && !menu.classList.contains("hidden"));
      wrapper.dataset.wasOpenBeforeEnter = isOpen ? "1" : "0";
    };

    const handleEnter = (event) => {
      if (event.key !== "Enter") return false;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return false;
      if (target.matches("textarea")) return false;
      if (!linesBody.contains(target)) return false;
      if (typeof shouldHandle === "function" && !shouldHandle(event, target)) {
        return false;
      }

      const row = target.closest(rowSelector);
      if (!rowMatches(row)) return false;

      const fieldKey = resolveFieldKey(target);
      if (!fieldKey) return false;

      const wrapper = target.closest("[data-searchable-wrapper]");
      if (wrapper) {
        const linkedSelect = wrapper.querySelector("select");
        const linkedValue = String(linkedSelect?.value || "").trim();
        const hasSelectableOption = Array.from(linkedSelect?.options || []).some(
          (opt) => String(opt?.value || "").trim(),
        );
        const dropdownMenu = wrapper.querySelector("div.z-50");
        const isDropdownOpen = Boolean(dropdownMenu && !dropdownMenu.classList.contains("hidden"));
        const wasOpenBeforeEnter = String(wrapper.dataset.wasOpenBeforeEnter || "") === "1";
        wrapper.dataset.wasOpenBeforeEnter = "0";
        if (wasOpenBeforeEnter) {
          // Enter came from an open searchable dropdown. Let selection commit, then move.
          window.setTimeout(() => {
            const refreshedValue = String(linkedSelect?.value || "").trim();
            if (refreshedValue || linkedValue || !hasSelectableOption) {
              moveForwardFrom(row, fieldKey, { defer: true });
            }
          }, 0);
          return false;
        }
        if (isDropdownOpen) {
          // Let searchable-select handle Enter selection first, then move focus.
          window.setTimeout(() => {
            const refreshedValue = String(linkedSelect?.value || "").trim();
            const menuStillOpen = Boolean(dropdownMenu && !dropdownMenu.classList.contains("hidden"));
            if (!menuStillOpen && (refreshedValue || linkedValue)) {
              moveForwardFrom(row, fieldKey, { defer: true });
            }
          }, 0);
          return false;
        }

        event.preventDefault();
        if (!linkedValue && hasSelectableOption) {
          if (typeof target.click === "function") target.click();
          return true;
        }
        moveForwardFrom(row, fieldKey, { defer: true });
        return true;
      }

      event.preventDefault();
      moveForwardFrom(row, fieldKey, { defer: false });
      return true;
    };
    const handleArrows = (event) => {
      const key = String(event.key || "");
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)) {
        return false;
      }
      if (event.defaultPrevented) return false;
      if (event.altKey || event.ctrlKey || event.metaKey) return false;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return false;
      if (!linesBody.contains(target)) return false;
      if (typeof shouldHandle === "function" && !shouldHandle(event, target)) {
        return false;
      }

      const row = target.closest(rowSelector);
      if (!rowMatches(row)) return false;
      const fieldKey = resolveFieldKey(target);
      if (!fieldKey) return false;

      const wrapper = target.closest("[data-searchable-wrapper]");
      if (wrapper) {
        const dropdownMenu = wrapper.querySelector("div.z-50");
        const isDropdownOpen = Boolean(dropdownMenu && !dropdownMenu.classList.contains("hidden"));
        if (isDropdownOpen) return false;
      }

      event.preventDefault();
      return moveByArrow(row, fieldKey, key);
    };

    const bind = () => {
      linesBody.setAttribute("data-grid-arrow-nav", "true");
      form.addEventListener("keydown", captureSearchableState, true);
      linesBody.addEventListener("keydown", handleEnter);
      linesBody.addEventListener("keydown", handleArrows);
      return () => {
        form.removeEventListener("keydown", captureSearchableState, true);
        linesBody.removeEventListener("keydown", handleEnter);
        linesBody.removeEventListener("keydown", handleArrows);
        linesBody.removeAttribute("data-grid-arrow-nav");
      };
    };

    return {
      bind,
      captureSearchableState,
      handleEnter,
      handleArrows,
      focusFieldElement,
    };
  };

  if (typeof window !== "undefined") {
    window.createVoucherRowEnterNavigator = createVoucherRowEnterNavigator;
    window.VoucherRowEnterNavigation = {
      create: createVoucherRowEnterNavigator,
      focusFieldElement,
    };
  }
})();
