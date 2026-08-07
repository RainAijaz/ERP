/*
 * report-mobile-tables.js — stacked-card report rows for phones.
 *
 * Every report renders a wide table (846px–1680px) inside an `overflow-x-auto`
 * wrapper. On a 390px phone that wrapper is ~316px, so the reader sees the
 * first column and nothing else: scroll right and the numbers appear, but the
 * item names have scrolled away. Reports were effectively unreadable on a
 * phone — the Stock Balances report most of all, because its identity columns
 * are the widest.
 *
 * This is the same trick voucher-mobile-lines.js plays on line entry, adapted
 * to read-only grouped tables: labels come from the table's own <thead>, so no
 * report view needs editing, and desktop is untouched because all layout lives
 * behind a max-width media query.
 *
 * Reports differ from voucher lines in three ways this layer has to handle:
 *   - group bands (`[data-report-group-header]`) span every column and are
 *     headings, not rows — they stay full width with no field labels;
 *   - subtotal / grand-total rows lead with a colspan'd caption cell, which
 *     becomes the card's title;
 *   - a header can be two rows deep (a group <th> above the real ones), so
 *     labels are composed "Parent · Child" rather than picking one row.
 *
 * The matching CSS lives in src/styles.css under "REPORT TABLES — stacked
 * cards on phones".
 */
(function () {
  "use strict";

  var MOBILE_QUERY = "(max-width: 1023px)";
  var mq = window.matchMedia(MOBILE_QUERY);

  // `data-report-table` is the site-wide report hook (see report-table-sort.js).
  // `data-mobile-report` is the opt-in for the handful of report tables that
  // deliberately stay out of the sorter but still need to be readable.
  var TABLE_SELECTOR = "table[data-report-table], table[data-mobile-report]";

  // A tree grid (the BOM cost breakdown) carries its meaning in the indentation
  // of its rows. Flattening it into cards would throw away the hierarchy that
  // is the entire point of the view, so it keeps its horizontal scroller.
  var EXCLUDED = "[data-tree-grid]";

  // A value longer than this reads badly in a half-width cell, so it takes the
  // whole card row instead (article names, account titles, remarks).
  var WIDE_TEXT_LENGTH = 20;

  var text = function (el) {
    return String((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  };

  var colspanOf = function (cell) {
    return Math.max(1, Number(cell.getAttribute("colspan") || 1));
  };

  /* ---------------------------------------------------------------------
   * Header labels
   * ------------------------------------------------------------------ */

  // Expand one <thead> row into a label per grid column, honouring colspan.
  var labelsFromRow = function (row) {
    var out = [];
    Array.prototype.forEach.call(row.cells, function (th) {
      var span = colspanOf(th);
      // A sort indicator is drawn with ::after, so it stays out of textContent.
      var label = text(th);
      for (var i = 0; i < span; i += 1) out.push(label);
    });
    return out;
  };

  // Compose the header stack into one label per column. With a single header
  // row this is just that row; with a grouped header ("Opening | Closing" above
  // "Qty | Amount") it yields "Opening · Qty", which is the only way those
  // columns stay distinguishable once they are stacked in a card.
  var headerLabels = function (table) {
    var rows = table.tHead ? Array.prototype.slice.call(table.tHead.rows) : [];
    if (!rows.length) return [];

    var expanded = rows.map(labelsFromRow);
    var width = expanded.reduce(function (max, labels) {
      return Math.max(max, labels.length);
    }, 0);
    // Rowspan'd cells (a header that covers both rows) leave short rows; those
    // carry no extra information for the columns they do not reach.
    var deepest = expanded.filter(function (labels) {
      return labels.length === width;
    });
    if (!deepest.length) return expanded[expanded.length - 1] || [];

    var out = [];
    for (var col = 0; col < width; col += 1) {
      var parts = [];
      deepest.forEach(function (labels) {
        var label = labels[col];
        // Skip blanks and don't repeat a group caption that equals its child.
        if (label && parts.indexOf(label) === -1) parts.push(label);
      });
      out.push(parts.join(" · "));
    }
    return out;
  };

  /* ---------------------------------------------------------------------
   * Row classification
   * ------------------------------------------------------------------ */

  var GROUP_BAND = "[data-report-group-header]";
  var TOTAL_ROW = [
    "[data-report-group-total]",
    "[data-report-total]",
    "[data-report-grand-total]",
    "[data-report-subtotal]",
  ].join(",");

  var matches = function (el, selector) {
    return Boolean(el.matches && el.matches(selector));
  };

  // A band is a heading that owns the full width — a group header, or any row
  // whose single cell spans every column (section separators, "no rows" notes).
  var isBand = function (tr, columnCount) {
    if (matches(tr, GROUP_BAND)) return true;
    if (tr.cells.length !== 1) return false;
    return colspanOf(tr.cells[0]) >= columnCount;
  };

  // Totals lead with a colspan'd caption ("Total", "Grand Total") and then the
  // figures. The caption becomes the card title; the figures keep their labels.
  var isTotalShaped = function (tr) {
    if (matches(tr, TOTAL_ROW)) return true;
    return tr.cells.length > 1 && colspanOf(tr.cells[0]) > 1;
  };

  /* ---------------------------------------------------------------------
   * Stamping
   * ------------------------------------------------------------------ */

  var SERIAL_HEADER = /^(sr\.?|s\.?\s?no\.?|#|serial|row)\b/i;

  // Which column heads each card. Decided once per table rather than per row:
  // picking "the first cell that doesn't look like a number" row-by-row makes
  // cards in the same table disagree about their own shape (a SKU like "300-2"
  // reads as numeric, "P01 CARTON A" does not), which looks like a rendering
  // bug rather than a heading.
  var leadColumnFor = function (labels) {
    if (!labels.length) return 0;
    // A row counter is a poor heading, so fall through to the next column.
    return SERIAL_HEADER.test(labels[0] || "") && labels.length > 1 ? 1 : 0;
  };

  var stampRow = function (tr, labels, columnCount, opts) {
    if (isBand(tr, columnCount)) {
      tr.setAttribute("data-mobile-row", "band");
      Array.prototype.forEach.call(tr.cells, function (td) {
        td.setAttribute("data-mobile-role", "band");
        td.removeAttribute("data-mobile-label");
      });
      return;
    }

    var totalShaped = opts.forceTotal || isTotalShaped(tr);
    tr.setAttribute("data-mobile-row", totalShaped ? "total" : "data");

    var col = 0;

    Array.prototype.forEach.call(tr.cells, function (td, index) {
      var startCol = col;
      var label = labels[col] || "";
      var span = colspanOf(td);
      col += span;

      var value = text(td);
      var hasContent = Boolean(value) || Boolean(td.querySelector("img, svg, input, button, a[href]"));

      // Spacer cells (the blank Branch column on a totals row) would otherwise
      // render as a bare header with no value under it.
      if (!hasContent) {
        td.setAttribute("data-mobile-role", "empty");
        td.removeAttribute("data-mobile-label");
        return;
      }

      // The caption cell of a totals row titles the card instead of being one
      // more label/value pair.
      if (totalShaped && index === 0 && span > 1) {
        td.setAttribute("data-mobile-role", "title");
        td.removeAttribute("data-mobile-label");
        return;
      }

      // The identifying cell of a data row heads the card — this is what makes
      // a stack of cards scannable rather than a wall of label/value pairs.
      if (!totalShaped && span === 1 && startCol === opts.leadColumn) {
        td.setAttribute("data-mobile-role", "lead");
        td.setAttribute("data-mobile-label", label);
        return;
      }

      td.setAttribute("data-mobile-role", "field");
      td.setAttribute("data-mobile-label", label);
      if (value.length > WIDE_TEXT_LENGTH || span > 1) {
        td.setAttribute("data-mobile-span", "full");
      } else {
        td.removeAttribute("data-mobile-span");
      }
    });
  };

  var stampTable = function (table) {
    var labels = headerLabels(table);
    var columnCount = labels.length || (function () {
      var max = 0;
      var bodies = table.tBodies ? Array.prototype.slice.call(table.tBodies) : [];
      bodies.forEach(function (tbody) {
        Array.prototype.forEach.call(tbody.rows, function (tr) {
          var width = 0;
          Array.prototype.forEach.call(tr.cells, function (td) {
            width += colspanOf(td);
          });
          if (width > max) max = width;
        });
      });
      return max;
    })();
    if (!columnCount) return;

    var leadColumn = leadColumnFor(labels);
    var bodies = table.tBodies ? Array.prototype.slice.call(table.tBodies) : [];
    bodies.forEach(function (tbody) {
      Array.prototype.forEach.call(tbody.rows, function (tr) {
        stampRow(tr, labels, columnCount, { forceTotal: false, leadColumn: leadColumn });
      });
    });

    if (table.tFoot) {
      Array.prototype.forEach.call(table.tFoot.rows, function (tr) {
        stampRow(tr, labels, columnCount, { forceTotal: true, leadColumn: leadColumn });
      });
    }
  };

  /* ---------------------------------------------------------------------
   * Wiring
   * ------------------------------------------------------------------ */

  // The wrapper's overflow-x-auto (and the scroll-shadow gradient painted on it
  // by the mobile stylesheet) would clip and streak the cards.
  var markWrapper = function (table) {
    var node = table.parentElement;
    while (node && node !== document.body) {
      var style = window.getComputedStyle(node);
      if (style.overflowX === "auto" || style.overflowX === "scroll") {
        node.setAttribute("data-mobile-report-wrap", "");
        return;
      }
      node = node.parentElement;
    }
  };

  var enhance = function (table) {
    if (table.hasAttribute("data-mobile-report-observed")) return;
    table.setAttribute("data-mobile-report-observed", "");
    markWrapper(table);

    // The sorter reorders whole rows and the paging control hides them; neither
    // rebuilds cells, so a childList observer on the bodies is enough to catch
    // any report that does re-render its rows.
    var observer = new MutationObserver(function () {
      if (mq.matches) stampTable(table);
    });
    var bodies = table.tBodies ? Array.prototype.slice.call(table.tBodies) : [];
    bodies.forEach(function (tbody) {
      observer.observe(tbody, { childList: true, subtree: false });
    });
  };

  var apply = function () {
    var tables = document.querySelectorAll(TABLE_SELECTOR);
    if (!tables.length) return;
    Array.prototype.forEach.call(tables, function (table) {
      if (matches(table, EXCLUDED)) return;
      enhance(table);
      if (mq.matches) {
        stampTable(table);
        table.setAttribute("data-mobile-report-card", "");
      } else {
        table.removeAttribute("data-mobile-report-card");
      }
    });
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

  window.erpReportMobileTables = { refresh: apply };
})();
