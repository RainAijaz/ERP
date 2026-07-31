/*
 * voucher-mobile-lines.js — stacked-card line entry for phones.
 *
 * Every voucher screen renders its own hand-written line table (10 different
 * row builders, three different field-attribute conventions), but they all
 * agree on two hooks: `[data-lines-table]` and `[data-lines-body]`. This layer
 * uses those to turn the wide table into labelled cards below `lg`, without
 * touching a single row builder.
 *
 * It is pure progressive enhancement:
 *   - labels come from the table's own <thead>, so new columns work for free;
 *   - a MutationObserver re-stamps after each render, because every view
 *     replaces its rows wholesale (`linesBody.innerHTML = …`);
 *   - desktop is untouched — all layout lives behind a max-width media query.
 *
 * The matching CSS lives in src/styles.css under "MOBILE / TOUCH IMPROVEMENTS".
 */
(function () {
  "use strict";

  var MOBILE_QUERY = "(max-width: 1023px)";
  var mq = window.matchMedia(MOBILE_QUERY);
  var I18N_ADD_ITEM = '<%= t("add_item") %>';

  // Field names that hold numbers, across all three attribute conventions in
  // use (data-f in sales, data-field in bank/cash/journal/inventory/stock-count,
  // data-row-field in purchase/production/stn/returnables).
  var NUMERIC_FIELD = /(qty|rate|amount|discount|receipt|payment|price|cost|weight|pairs|dozen|stock|balance)/i;

  var text = function (el) {
    return String((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  };

  /* ---------------------------------------------------------------------
   * Header labels
   * ------------------------------------------------------------------ */

  // Expand a <thead> row into one label per grid column, honouring colspan.
  var labelsFromRow = function (row) {
    var out = [];
    Array.prototype.forEach.call(row.cells, function (th) {
      var span = Math.max(1, Number(th.getAttribute("colspan") || 1));
      var label = text(th);
      for (var i = 0; i < span; i += 1) out.push(label);
    });
    return out;
  };

  // Several views stack a grouped header above the real one, so pick the row
  // that resolves to the most columns rather than blindly taking the last.
  var headerLabels = function (table) {
    var rows = table.tHead ? Array.prototype.slice.call(table.tHead.rows) : [];
    var best = [];
    rows.forEach(function (row) {
      var labels = labelsFromRow(row);
      if (labels.length >= best.length) best = labels;
    });
    return best;
  };

  /* ---------------------------------------------------------------------
   * Per-cell classification
   * ------------------------------------------------------------------ */

  var isActionCell = function (td) {
    if (td.querySelector("input, select, textarea")) return false;
    return Boolean(td.querySelector("button, a[href]"));
  };

  // A wide control (article / account picker) gets its own full-width row.
  var isWideCell = function (td) {
    return Boolean(
      td.querySelector(
        'select, [data-searchable-select], [data-searchable-wrapper], textarea, input[type="text"][data-searchable-select]',
      ),
    );
  };

  var isSerialCell = function (td, label) {
    if (td.hasAttribute("data-row-no")) return true;
    if (td.querySelector("input, select, textarea, button, a[href]")) return false;
    // Bare numeric cell whose header reads like a row counter.
    return /^(sr|s\.?no|#|serial|row)\b/i.test(label || "");
  };

  var markNumericInputs = function (scope) {
    var controls = scope.querySelectorAll("input");
    Array.prototype.forEach.call(controls, function (input) {
      if (input.getAttribute("inputmode")) return;
      var type = String(input.type || "text").toLowerCase();
      if (type === "checkbox" || type === "radio" || type === "hidden") return;

      var field =
        input.getAttribute("data-f") ||
        input.getAttribute("data-field") ||
        input.getAttribute("data-row-field") ||
        input.getAttribute("name") ||
        "";

      // type=number already implies a numeric keypad on most phones, but being
      // explicit gives a decimal point on iOS too. Sales line inputs have no
      // type at all (their values are pre-formatted strings that type=number
      // would reject), so inputmode is the only safe fix there.
      var numeric =
        type === "number" ||
        NUMERIC_FIELD.test(field) ||
        /\btext-right\b/.test(String(input.className || ""));

      if (numeric) input.setAttribute("inputmode", "decimal");
    });
  };

  /* ---------------------------------------------------------------------
   * Stamping
   * ------------------------------------------------------------------ */

  var stampTable = function (table) {
    var labels = headerLabels(table);
    var bodies = table.tBodies ? Array.prototype.slice.call(table.tBodies) : [];

    bodies.forEach(function (tbody) {
      Array.prototype.forEach.call(tbody.rows, function (tr) {
        var col = 0;
        Array.prototype.forEach.call(tr.cells, function (td) {
          var label = labels[col] || "";
          col += Math.max(1, Number(td.getAttribute("colspan") || 1));

          if (isSerialCell(td, label)) {
            td.setAttribute("data-mobile-role", "serial");
            return;
          }
          if (isActionCell(td)) {
            td.setAttribute("data-mobile-role", "action");
            return;
          }
          // A cell with neither a control nor text is a spacer — showing its
          // header as a bare label (e.g. a stray "Department") just confuses.
          if (!td.querySelector("input, select, textarea, button, a[href]") && !text(td)) {
            td.setAttribute("data-mobile-role", "empty");
            return;
          }
          td.removeAttribute("data-mobile-role");
          td.setAttribute("data-mobile-label", label);
          if (isWideCell(td)) td.setAttribute("data-mobile-span", "full");
        });
      });
      markNumericInputs(tbody);
    });

    // Totals row: label each populated cell, drop the empty spacer cells, and
    // hide the add-row button (it moves to the sticky bar).
    var foot = table.tFoot;
    if (foot) {
      Array.prototype.forEach.call(foot.rows, function (tr) {
        var pending = "";
        var col = 0;
        Array.prototype.forEach.call(tr.cells, function (td) {
          var headerLabel = labels[col] || "";
          col += Math.max(1, Number(td.getAttribute("colspan") || 1));

          // The in-table add button is replaced by the sticky bar on mobile.
          if (td.querySelector("[data-add-row]")) {
            td.setAttribute("data-mobile-role", "empty");
            return;
          }
          var control = td.querySelector("input, select");
          if (!control) {
            // A bare text cell is the label for the control cell that follows;
            // either way it is not shown as its own line in the totals card.
            var own = text(td);
            if (own) pending = own;
            td.setAttribute("data-mobile-role", "empty");
            return;
          }
          // Prefer an explicit aria-label, then a preceding text cell, and
          // finally the column header this total sits under — without the
          // fallback, views whose totals carry no aria-label (stock count,
          // inventory) render a stack of bare numbers.
          var label =
            control.getAttribute("aria-label") || pending || headerLabel;
          pending = "";
          td.removeAttribute("data-mobile-role");
          td.setAttribute("data-mobile-label", label || "");
        });
      });
    }
  };

  /* ---------------------------------------------------------------------
   * Sticky "Add item" bar
   * ------------------------------------------------------------------ */

  var buildAddBar = function (table) {
    var addBtn = table.querySelector("[data-add-row]");
    if (!addBtn) return null;

    var form = table.closest("form");
    var host = form || table.parentElement;
    if (!host || host.querySelector("[data-mobile-add-bar]")) return null;

    var bar = document.createElement("div");
    bar.setAttribute("data-mobile-add-bar", "");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-mobile-add-btn", "");
    btn.textContent = "+ " + I18N_ADD_ITEM;
    btn.addEventListener("click", function () {
      // Delegate to the view's own handler so per-view seeding/validation runs.
      addBtn.click();
      window.requestAnimationFrame(function () {
        var body = table.querySelector("[data-lines-body]") || table.tBodies[0];
        var last = body && body.rows[body.rows.length - 1];
        if (last) last.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    });
    bar.appendChild(btn);
    host.appendChild(bar);

    var syncDisabled = function () {
      btn.disabled = addBtn.disabled;
      bar.toggleAttribute("data-hidden", addBtn.disabled);
    };
    syncDisabled();
    new MutationObserver(syncDisabled).observe(addBtn, {
      attributes: true,
      attributeFilter: ["disabled"],
    });
    return bar;
  };

  /* ---------------------------------------------------------------------
   * Wiring
   * ------------------------------------------------------------------ */

  var enhance = function (table) {
    if (table.hasAttribute("data-mobile-observed")) return;
    table.setAttribute("data-mobile-observed", "");

    // The wrapper's overflow-x-auto must not clip the cards.
    var wrap = table.parentElement;
    if (wrap && /overflow-x-auto/.test(String(wrap.className || ""))) {
      wrap.setAttribute("data-mobile-lines-wrap", "");
    }

    var body = table.querySelector("[data-lines-body]") || table.tBodies[0];
    if (body) {
      // Row builders replace the whole tbody, so re-stamp after every render.
      var observer = new MutationObserver(function () {
        if (mq.matches) stampTable(table);
      });
      observer.observe(body, { childList: true, subtree: false });
    }

    buildAddBar(table);
  };

  var apply = function () {
    var tables = document.querySelectorAll("[data-lines-table]");
    if (!tables.length) return;
    Array.prototype.forEach.call(tables, function (table) {
      enhance(table);
      if (mq.matches) {
        stampTable(table);
        table.setAttribute("data-mobile-card", "");
      } else {
        table.removeAttribute("data-mobile-card");
      }
    });
    document.body.toggleAttribute("data-mobile-lines", mq.matches);
  };

  var start = function () {
    apply();
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", apply);
    else if (typeof mq.addListener === "function") mq.addListener(apply);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  window.erpVoucherMobileLines = { refresh: apply };
})();
