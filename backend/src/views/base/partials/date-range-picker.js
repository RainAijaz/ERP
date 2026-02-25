(function () {
  const defaultIsIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim());

  function initReportDateRangePicker(options = {}) {
    const root = options.root || document;
    const showError = typeof options.showError === "function" ? options.showError : (msg) => window.alert(msg);
    const invalidDateRangeMessage = String(options.invalidDateRangeMessage || "Invalid date range.");
    const selectDateRangeText = String(options.selectDateRangeText || "Select Date Range");
    const isIsoDate = options.isIsoDate || defaultIsIsoDate;

    const dateRangeInput = root.querySelector("[data-date-range-input]");
    const dateRangeWrap = root.querySelector("[data-date-range-wrap]");
    const dateRangePanel = root.querySelector("[data-date-range-panel]");
    const dateRangeToggle = root.querySelector("[data-date-range-toggle]");
    const dateRangeFromDisplay = root.querySelector("[data-date-range-from-display]");
    const dateRangeToDisplay = root.querySelector("[data-date-range-to-display]");
    const dateRangeCaption = root.querySelector("[data-date-range-caption]");
    const dateRangeMonth1Label = root.querySelector("[data-date-range-month-1-label]");
    const dateRangeMonth2Label = root.querySelector("[data-date-range-month-2-label]");
    const dateRangeMonth1Grid = root.querySelector("[data-date-range-month-1-grid]");
    const dateRangeMonth2Grid = root.querySelector("[data-date-range-month-2-grid]");
    const dateRangeMonth1PrevBtn = root.querySelector("[data-date-range-month-1-prev]");
    const dateRangeMonth1NextBtn = root.querySelector("[data-date-range-month-1-next]");
    const dateRangeMonth2PrevBtn = root.querySelector("[data-date-range-month-2-prev]");
    const dateRangeMonth2NextBtn = root.querySelector("[data-date-range-month-2-next]");
    const dateRangeApplyBtn = root.querySelector("[data-date-range-apply]");
    const dateRangeCancelBtn = root.querySelector("[data-date-range-cancel]");
    const fromDateHidden = root.querySelector("[data-from-date-hidden]");
    const toDateHidden = root.querySelector("[data-to-date-hidden]");

    if (!dateRangeInput || !dateRangePanel || !fromDateHidden || !toDateHidden) {
      return { isIsoDate, setDateRange: () => ({ ok: false }) };
    }

    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const toDateObj = (iso) => {
      if (!isIsoDate(iso)) return null;
      const [y, m, d] = String(iso).split("-").map(Number);
      return new Date(y, m - 1, d);
    };
    const toIso = (dt) => {
      const y = dt.getFullYear();
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const d = String(dt.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    };
    const toDisplayShortFromIso = (iso) => {
      if (!isIsoDate(iso)) return "";
      const [y, m, d] = String(iso).split("-");
      return `${d}-${m}-${y}`;
    };
    const toDisplayShortFromDate = (dt) => {
      if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return "";
      const y = String(dt.getFullYear());
      const m = String(dt.getMonth() + 1).padStart(2, "0");
      const d = String(dt.getDate()).padStart(2, "0");
      return `${d}-${m}-${y}`;
    };
    const addMonths = (dt, delta) => new Date(dt.getFullYear(), dt.getMonth() + delta, 1);
    const dayStart = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const sameMonth = (a, b) => a instanceof Date && b instanceof Date && !Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime()) && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

    let rangeStart = null;
    let rangeEnd = null;
    let openedFromIso = "";
    let openedToIso = "";
    let rangeCursorMonth1 = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    let rangeCursorMonth2 = addMonths(rangeCursorMonth1, 1);

    const syncDateRangeDisplay = () => {
      const from = String(fromDateHidden.value || "").trim();
      const to = String(toDateHidden.value || "").trim();
      dateRangeInput.value = from && to ? `${toDisplayShortFromIso(from)} - ${toDisplayShortFromIso(to)}` : "";
    };

    const refreshRangeDisplayValues = () => {
      if (dateRangeFromDisplay) dateRangeFromDisplay.textContent = rangeStart ? toDisplayShortFromDate(rangeStart) : "-";
      if (dateRangeToDisplay) dateRangeToDisplay.textContent = rangeEnd ? toDisplayShortFromDate(rangeEnd) : "-";
      const from = rangeStart ? toDisplayShortFromDate(rangeStart) : "";
      const to = rangeEnd ? toDisplayShortFromDate(rangeEnd) : "";
      dateRangeInput.value = from && to ? `${from} - ${to}` : "";
      if (dateRangeCaption) {
        if (rangeStart && rangeEnd) dateRangeCaption.textContent = `${toDisplayShortFromDate(rangeStart)} - ${toDisplayShortFromDate(rangeEnd)}`;
        else if (rangeStart) dateRangeCaption.textContent = `${toDisplayShortFromDate(rangeStart)} - ...`;
        else dateRangeCaption.textContent = selectDateRangeText;
      }
    };

    const hasValidRange = () => {
      if (!(rangeStart instanceof Date) || Number.isNaN(rangeStart.getTime())) return false;
      if (!(rangeEnd instanceof Date) || Number.isNaN(rangeEnd.getTime())) return false;
      return dayStart(rangeStart) <= dayStart(rangeEnd);
    };

    const renderMonthGrid = (monthFirstDay, gridEl, labelEl, boundTo, view = { showStart: true, showEnd: true, showRange: true }) => {
      if (!gridEl || !labelEl) return;
      labelEl.textContent = `${monthNames[monthFirstDay.getMonth()]} ${monthFirstDay.getFullYear()}`;
      gridEl.innerHTML = "";
      const firstWeekday = new Date(monthFirstDay.getFullYear(), monthFirstDay.getMonth(), 1).getDay();
      const daysInMonth = new Date(monthFirstDay.getFullYear(), monthFirstDay.getMonth() + 1, 0).getDate();
      for (let i = 0; i < firstWeekday; i += 1) {
        const pad = document.createElement("span");
        pad.className = "block h-7 w-7";
        gridEl.appendChild(pad);
      }
      for (let day = 1; day <= daysInMonth; day += 1) {
        const current = dayStart(new Date(monthFirstDay.getFullYear(), monthFirstDay.getMonth(), day));
        const currentIso = toIso(current);
        const isStart = view.showStart && rangeStart && toIso(rangeStart) === currentIso;
        const isEnd = view.showEnd && rangeEnd && toIso(rangeEnd) === currentIso;
        const inRange = view.showRange && hasValidRange() && current >= dayStart(rangeStart) && current <= dayStart(rangeEnd);
        const isBlockedByRange = (boundTo === "from" && rangeEnd && current > dayStart(rangeEnd)) || (boundTo === "to" && rangeStart && current < dayStart(rangeStart));

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "inline-flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold leading-none";
        if (isBlockedByRange) {
          btn.className += " text-slate-300 cursor-not-allowed";
          btn.disabled = true;
        } else if (isStart || isEnd) btn.className += " bg-slate-800 text-white";
        else if (inRange) btn.className += " bg-slate-200 text-slate-800";
        else btn.className += " text-slate-700 hover:bg-slate-100";
        btn.textContent = String(day);
        btn.dataset.iso = currentIso;
        btn.addEventListener("click", () => {
          const selected = toDateObj(btn.dataset.iso);
          if (!selected) return;
          if (boundTo === "from" && rangeEnd && dayStart(selected) > dayStart(rangeEnd)) return;
          if (boundTo === "to" && rangeStart && dayStart(selected) < dayStart(rangeStart)) return;
          const selectedIso = btn.dataset.iso;
          if (boundTo === "from") {
            rangeStart = selected;
            fromDateHidden.value = selectedIso;
          } else {
            rangeEnd = selected;
            toDateHidden.value = selectedIso;
          }
          refreshRangeDisplayValues();
          renderCalendars();
        });
        gridEl.appendChild(btn);
      }
    };

    const renderCalendars = () => {
      const month1 = new Date(rangeCursorMonth1.getFullYear(), rangeCursorMonth1.getMonth(), 1);
      const month2 = new Date(rangeCursorMonth2.getFullYear(), rangeCursorMonth2.getMonth(), 1);
      const duplicatedMonth = sameMonth(month1, month2);
      const month1View = duplicatedMonth ? { showStart: true, showEnd: false, showRange: true } : { showStart: true, showEnd: true, showRange: true };
      const month2View = duplicatedMonth ? { showStart: false, showEnd: true, showRange: true } : { showStart: true, showEnd: true, showRange: true };
      renderMonthGrid(month1, dateRangeMonth1Grid, dateRangeMonth1Label, "from", month1View);
      renderMonthGrid(month2, dateRangeMonth2Grid, dateRangeMonth2Label, "to", month2View);
      refreshRangeDisplayValues();
    };

    const setDateRange = (from, to) => {
      const fromVal = String(from || "").trim();
      const toVal = String(to || "").trim();
      if (!fromVal && !toVal) {
        fromDateHidden.value = "";
        toDateHidden.value = "";
        syncDateRangeDisplay();
        return { ok: true };
      }
      if (!isIsoDate(fromVal) || !isIsoDate(toVal) || fromVal > toVal) return { ok: false };
      fromDateHidden.value = fromVal;
      toDateHidden.value = toVal;
      syncDateRangeDisplay();
      return { ok: true };
    };

    const closeDateRangePanel = () => {
      dateRangePanel.classList.add("hidden");
    };

    const positionDateRangePanel = () => {
      if (!dateRangeWrap || dateRangePanel.classList.contains("hidden")) return;
      dateRangePanel.style.left = "0px";
      dateRangePanel.style.right = "auto";
      const panelRect = dateRangePanel.getBoundingClientRect();
      const wrapRect = dateRangeWrap.getBoundingClientRect();
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
      const edge = 8;
      let left = 0;
      if (wrapRect.left + panelRect.width > viewportWidth - edge) {
        left = viewportWidth - edge - (wrapRect.left + panelRect.width);
      }
      if (wrapRect.left + left < edge) {
        left = edge - wrapRect.left;
      }
      dateRangePanel.style.left = `${Math.round(left)}px`;
    };

    const openDateRangePanel = () => {
      openedFromIso = String(fromDateHidden.value || "").trim();
      openedToIso = String(toDateHidden.value || "").trim();
      rangeStart = toDateObj(openedFromIso);
      rangeEnd = toDateObj(openedToIso);
      const baseMonth = rangeStart ? new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      rangeCursorMonth1 = baseMonth;
      rangeCursorMonth2 = rangeEnd ? new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), 1) : addMonths(baseMonth, 1);
      renderCalendars();
      dateRangePanel.classList.remove("hidden");
      positionDateRangePanel();
    };

    dateRangeInput.addEventListener("click", () => {
      if (dateRangePanel.classList.contains("hidden")) openDateRangePanel();
      else closeDateRangePanel();
    });
    dateRangeToggle?.addEventListener("click", () => {
      if (dateRangePanel.classList.contains("hidden")) openDateRangePanel();
      else closeDateRangePanel();
    });
    dateRangeMonth1PrevBtn?.addEventListener("click", () => {
      rangeCursorMonth1 = addMonths(rangeCursorMonth1, -1);
      renderCalendars();
    });
    dateRangeMonth1NextBtn?.addEventListener("click", () => {
      rangeCursorMonth1 = addMonths(rangeCursorMonth1, 1);
      renderCalendars();
    });
    dateRangeMonth2PrevBtn?.addEventListener("click", () => {
      rangeCursorMonth2 = addMonths(rangeCursorMonth2, -1);
      renderCalendars();
    });
    dateRangeMonth2NextBtn?.addEventListener("click", () => {
      rangeCursorMonth2 = addMonths(rangeCursorMonth2, 1);
      renderCalendars();
    });
    dateRangeApplyBtn?.addEventListener("click", () => {
      const from = String(fromDateHidden.value || "").trim();
      const to = String(toDateHidden.value || "").trim();
      const status = setDateRange(from, to);
      if (!status.ok) {
        showError(invalidDateRangeMessage);
        return;
      }
      closeDateRangePanel();
    });
    dateRangeCancelBtn?.addEventListener("click", () => {
      setDateRange(openedFromIso, openedToIso);
      closeDateRangePanel();
    });
    document.addEventListener("click", (event) => {
      if (!dateRangeWrap || dateRangePanel.classList.contains("hidden")) return;
      if (dateRangeWrap.contains(event.target)) return;
      closeDateRangePanel();
    });
    window.addEventListener("resize", positionDateRangePanel);
    syncDateRangeDisplay();

    return {
      isIsoDate,
      setDateRange,
      getValues: () => ({
        from: String(fromDateHidden.value || "").trim(),
        to: String(toDateHidden.value || "").trim(),
      }),
    };
  }

  window.initReportDateRangePicker = initReportDateRangePicker;
})();
