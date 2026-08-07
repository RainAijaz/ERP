(function () {
  "use strict";

  // Click-to-sort for every report table on the site.
  //
  // Reports hand-write their own <thead>/<tbody>, so instead of asking each of
  // them to opt in we attach to any `[data-report-table]` and derive everything
  // from the markup that is already there. A report opts a column out with
  // `data-no-sort` on the <th>, or pins a row with `data-no-sort` on the <tr>.
  //
  // Three rules keep the numbers honest:
  //   * Rows that are not data -- group headers, subtotals, grand totals -- are
  //     never reordered on their own. They are detected by their colspan cell
  //     (or an explicit marker) and act as fences: each run of data rows
  //     between them sorts independently.
  //   * A report that groups its rows (`data-report-group-key`, used by the
  //     stock and sales reports) sorts by whole group instead. Sorting the rows
  //     inside a one-row group would look broken -- what the user means by
  //     "sort by quantity" there is "put the biggest group first" -- so the
  //     header/lines/total of each group move together, ranked by the group's
  //     own total.
  //   * The sort indicator is drawn with a CSS ::after, not a text node, so it
  //     stays out of `cell.textContent` and therefore out of the CSV exports
  //     and print views that read headers that way.

  var STYLE_ID = "erp-report-table-sort-styles";
  var BOUND = "reportSortBound";

  var PINNED_ROW_SELECTOR = [
    "[data-no-sort]",
    "[data-report-group-header]",
    "[data-report-group-total]",
    "[data-report-total]",
    "[data-report-grand-total]",
    "[data-report-subtotal]",
  ].join(",");

  var STYLES = [
    "table[data-report-table] th[data-sortable]{cursor:pointer;user-select:none;white-space:nowrap;}",
    'table[data-report-table] th[data-sortable]::after{content:"\\2195";margin-inline-start:.35em;font-size:.9em;opacity:0;transition:opacity .12s ease;}',
    "table[data-report-table] th[data-sortable]:hover::after,",
    "table[data-report-table] th[data-sortable]:focus-visible::after{opacity:.6;}",
    'table[data-report-table] th[data-sortable][aria-sort="ascending"]::after{content:"\\25B2";opacity:1;}',
    'table[data-report-table] th[data-sortable][aria-sort="descending"]::after{content:"\\25BC";opacity:1;}',
    "table[data-report-table] th[data-sortable]:focus-visible{outline:2px solid currentColor;outline-offset:-2px;}",
    '@media print{table[data-report-table] th[data-sortable]::after{content:"" !important;}}',
  ].join("");

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLES;
    (document.head || document.documentElement).appendChild(style);
  }

  // --- value parsing -------------------------------------------------------

  // Dates are rendered DD-MM-YYYY site-wide (see display-formatters.js), which
  // Date.parse reads as an American month-first date or not at all -- so match
  // the known shapes by hand.
  //
  // Handing the string to Date.parse as a general fallback is what must not
  // happen: V8 reads "5" as May 2001 and "20" as the year 2020, so a quantity
  // column of small integers would be detected as dates and then sort by those
  // invented timestamps. The fallback below is therefore gated on the string
  // actually looking like a date -- a month name plus a four-digit year.
  function parseDate(text) {
    var dmy = text.match(
      /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?m\.?)?$/i,
    );
    if (dmy) {
      var hour = dmy[4] ? +dmy[4] : 0;
      var meridiem = (dmy[7] || "").toLowerCase();
      if (meridiem === "p" && hour < 12) hour += 12;
      if (meridiem === "a" && hour === 12) hour = 0;
      return Date.UTC(
        +dmy[3],
        +dmy[2] - 1,
        +dmy[1],
        hour,
        dmy[5] ? +dmy[5] : 0,
        dmy[6] ? +dmy[6] : 0,
      );
    }
    var ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (ymd) return Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3]);
    if (/[a-z]/i.test(text) && /\d{4}/.test(text)) {
      var parsed = Date.parse(text);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
  }

  // Strict on purpose: an article really can be called "300 BALLMAN", and
  // pulling a 300 out of it would sort the Article column as if it were a
  // quantity. Anything carrying letters is text, full stop. Money and
  // quantities render as bare numbers here (no "Rs" prefix), so nothing
  // legitimate is lost.
  function parseNumber(text) {
    if (/[^\d\s.,()%+eE-]/.test(text)) return null;
    if (/[a-zA-Z]/.test(text.replace(/[eE]/g, ""))) return null;
    var negative = /^\(.*\)$/.test(text);
    var stripped = text.replace(/[^0-9.eE+-]/g, "");
    if (!stripped || !/\d/.test(stripped)) return null;
    var value = Number(stripped);
    if (!Number.isFinite(value)) return null;
    return negative ? -Math.abs(value) : value;
  }

  // Column index is logical, so a cell has to be located by walking colspans --
  // on a subtotal row `<td colspan="3">Total</td>` shifts every value cell left.
  // A column covered by a spanning cell has no value of its own: return null.
  function cellAtColumn(row, index) {
    var cursor = 0;
    for (var i = 0; i < row.cells.length; i += 1) {
      var cell = row.cells[i];
      var span = Math.max(Number(cell.getAttribute("colspan")) || 1, 1);
      if (index < cursor + span) return span > 1 ? null : cell;
      cursor += span;
    }
    return null;
  }

  function valueAt(row, index) {
    var cell = cellAtColumn(row, index);
    if (!cell) return "";
    var explicit = cell.getAttribute("data-sort-value");
    if (explicit !== null) return explicit.trim();
    return (cell.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isBlank(text) {
    return !text || text === "-" || text === "--";
  }

  // Sample the column to decide how to compare it. A column counts as numeric
  // (or date) only if every value that is actually filled in parses that way,
  // so one "N/A" cell cannot silently downgrade a quantity column to string
  // sorting -- but a genuinely mixed column does fall back to text.
  function detectType(values) {
    var filled = values.filter(function (v) {
      return !isBlank(v);
    });
    if (!filled.length) return "text";
    var numeric = true;
    var dated = true;
    for (var i = 0; i < filled.length; i += 1) {
      if (numeric && parseNumber(filled[i]) === null) numeric = false;
      if (dated && parseDate(filled[i]) === null) dated = false;
      if (!numeric && !dated) break;
    }
    // Date first: "01-02-2026" also survives parseNumber once separators go.
    if (dated) return "date";
    if (numeric) return "number";
    return "text";
  }

  function comparableValue(text, type) {
    if (type === "number") return parseNumber(text);
    if (type === "date") return parseDate(text);
    return isBlank(text) ? null : text.toLowerCase();
  }

  // Blanks sink to the bottom in both directions: an empty cell is "no value",
  // not the smallest one.
  function makeComparator(factor) {
    return function (a, b) {
      if (a.value === null && b.value === null) return a.position - b.position;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      if (a.value < b.value) return -1 * factor;
      if (a.value > b.value) return 1 * factor;
      return a.position - b.position; // stable
    };
  }

  // Move `rows` (already in the desired order) into the slot they came from.
  function reinsert(body, rows, anchor) {
    var fragment = document.createDocumentFragment();
    rows.forEach(function (row) {
      fragment.appendChild(row);
    });
    body.insertBefore(fragment, anchor);
  }

  // --- table anatomy -------------------------------------------------------

  function headerCells(table) {
    var head = table.tHead;
    if (!head || !head.rows.length) return null;
    var row = head.rows[head.rows.length - 1];
    var cells = [];
    var index = 0;
    Array.prototype.forEach.call(row.cells, function (cell) {
      var span = Math.max(Number(cell.getAttribute("colspan")) || 1, 1);
      cells.push({ cell: cell, index: index, span: span });
      index += span;
    });
    return cells;
  }

  function isPinnedRow(row) {
    if (row.matches(PINNED_ROW_SELECTOR)) return true;
    // A cell that spans columns means this row is a header, a section label or
    // a total -- never a data row that may be reordered on its own.
    return Array.prototype.some.call(row.cells, function (cell) {
      return (Number(cell.getAttribute("colspan")) || 1) > 1;
    });
  }

  // Runs of movable rows, fenced by pinned rows. Each run sorts independently
  // and in place, so groups keep their headers and totals.
  function segmentsOf(table) {
    var segments = [];
    Array.prototype.forEach.call(table.tBodies, function (body) {
      var current = null;
      Array.prototype.forEach.call(body.rows, function (row) {
        if (isPinnedRow(row)) {
          current = null;
          return;
        }
        if (!current) {
          current = { body: body, rows: [] };
          segments.push(current);
        }
        current.rows.push(row);
      });
    });
    return segments.filter(function (segment) {
      return segment.rows.length > 1;
    });
  }

  // Groups keyed by `data-report-group-key`, each block holding its header,
  // lines and total. Only returned when the keyed rows sit in one uninterrupted
  // run per tbody -- otherwise reordering blocks would jump other rows.
  function blocksOf(table) {
    var blocks = [];
    var usable = true;
    Array.prototype.forEach.call(table.tBodies, function (body) {
      var current = null;
      var seenKeyed = false;
      var closed = false;
      Array.prototype.forEach.call(body.rows, function (row) {
        var key = row.getAttribute("data-report-group-key");
        if (!key) {
          if (seenKeyed) closed = true;
          current = null;
          return;
        }
        if (closed) usable = false; // keyed rows resume after a gap
        seenKeyed = true;
        if (!current || current.key !== key) {
          current = { key: key, body: body, rows: [] };
          blocks.push(current);
        }
        current.rows.push(row);
      });
    });
    return usable && blocks.length > 1 ? blocks : [];
  }

  // What a whole group is worth in this column: its own total row if it has
  // one, otherwise the sum of its lines (numbers) or its first line (text).
  function blockValue(block, columnIndex, type) {
    var total = null;
    var lines = [];
    block.rows.forEach(function (row) {
      if (row.hasAttribute("data-report-group-total")) total = row;
      else if (!isPinnedRow(row)) lines.push(row);
    });

    if (total) {
      var totalValue = valueAt(total, columnIndex);
      if (!isBlank(totalValue)) return comparableValue(totalValue, type);
    }
    if (!lines.length) return null;
    if (type === "number") {
      var sum = null;
      lines.forEach(function (row) {
        var value = parseNumber(valueAt(row, columnIndex));
        if (value === null) return;
        sum = sum === null ? value : sum + value;
      });
      return sum;
    }
    return comparableValue(valueAt(lines[0], columnIndex), type);
  }

  // --- sorting -------------------------------------------------------------

  function sortTable(table, columnIndex, direction) {
    var segments = segmentsOf(table);
    if (!segments.length && !blocksOf(table).length) return;

    var samples = allBodyRows(table)
      .filter(function (row) {
        return !isPinnedRow(row);
      })
      .map(function (row) {
        return valueAt(row, columnIndex);
      });

    var declared =
      table.__reportSortTypes && table.__reportSortTypes[columnIndex];
    var type = declared || detectType(samples);
    var compare = makeComparator(direction === "desc" ? -1 : 1);

    // Rows inside each group (or each fenced run of a flat table) first...
    segments.forEach(function (segment) {
      var decorated = segment.rows.map(function (row, position) {
        return {
          row: row,
          position: position,
          value: comparableValue(valueAt(row, columnIndex), type),
        };
      });
      decorated.sort(compare);
      var anchor = segment.rows[segment.rows.length - 1].nextSibling;
      var ordered = decorated.map(function (entry) {
        return entry.row;
      });
      reinsert(segment.body, ordered, anchor);
      segment.rows = ordered;
    });

    // ...then the groups themselves. Re-read the blocks so they carry the line
    // order the pass above just produced, instead of putting the old one back.
    var blocks = blocksOf(table);
    if (blocks.length) {
      var decoratedBlocks = blocks.map(function (block, position) {
        return {
          block: block,
          position: position,
          value: blockValue(block, columnIndex, type),
        };
      });
      decoratedBlocks.sort(compare);
      var last = blocks[blocks.length - 1];
      var blockAnchor = last.rows[last.rows.length - 1].nextSibling;
      var rows = [];
      decoratedBlocks.forEach(function (entry) {
        entry.block.rows.forEach(function (row) {
          rows.push(row);
        });
      });
      reinsert(blocks[0].body, rows, blockAnchor);
    }

    resyncListUtils(table);
  }

  // Remember the order the server rendered, so a third click can put it back.
  // That matters most on ledgers: a running-balance column only reads correctly
  // in the original sequence, and re-loading the report is a poor way back.
  function stampOriginalOrder(table) {
    Array.prototype.forEach.call(table.tBodies, function (body) {
      Array.prototype.forEach.call(body.rows, function (row, index) {
        if (row.dataset.reportOrigIndex === undefined) {
          row.dataset.reportOrigIndex = String(index);
        }
      });
    });
  }

  function restoreOriginalOrder(table) {
    Array.prototype.forEach.call(table.tBodies, function (body) {
      var rows = Array.prototype.slice.call(body.rows);
      rows.sort(function (a, b) {
        return (
          Number(a.dataset.reportOrigIndex || 0) -
          Number(b.dataset.reportOrigIndex || 0)
        );
      });
      reinsert(body, rows, null);
    });
    resyncListUtils(table);
  }

  function allBodyRows(table) {
    var rows = [];
    Array.prototype.forEach.call(table.tBodies, function (body) {
      Array.prototype.forEach.call(body.rows, function (row) {
        rows.push(row);
      });
    });
    return rows;
  }

  // Pages that also load basic-info-utils.ejs (the ledger and balances
  // reports) filter and paginate rows in JS off `data-orig-index`. Renumber it
  // to the new visual order and let that layer re-page, otherwise page 1 would
  // keep showing the rows that were first before the sort.
  function resyncListUtils(table) {
    var rows = allBodyRows(table).filter(function (row) {
      return row.hasAttribute("data-row");
    });
    if (!rows.length) return;
    rows.forEach(function (row, index) {
      row.dataset.origIndex = String(index);
    });
    if (typeof window.erpApplyTableFilters === "function") {
      window.erpApplyTableFilters();
    }
  }

  // --- wiring --------------------------------------------------------------

  function activate(table, entry, direction) {
    headerCells(table).forEach(function (item) {
      if (!item.cell.hasAttribute("data-sortable")) return;
      var state = "none";
      if (item.cell === entry.cell && direction) {
        state = direction === "desc" ? "descending" : "ascending";
      }
      item.cell.setAttribute("aria-sort", state);
    });
    table.__reportSortColumn = direction ? entry.index : null;
    table.__reportSortDir = direction;
    if (direction) sortTable(table, entry.index, direction);
    else restoreOriginalOrder(table);
  }

  function bindTable(table) {
    if (table.dataset[BOUND] === "true") return;
    var cells = headerCells(table);
    if (!cells || !cells.length) return;
    if (!segmentsOf(table).length && !blocksOf(table).length) return;

    stampOriginalOrder(table);
    table.__reportSortTypes = {};
    var bound = false;

    cells.forEach(function (entry) {
      var cell = entry.cell;
      if (cell.hasAttribute("data-no-sort")) return;
      // Multi-column headers have no single column to sort by.
      if (entry.span > 1) return;
      // Columns wired to basic-info-utils.ejs's own sorter (master-data lists
      // and any report that adopts table-header.ejs) already work -- leave them.
      if (cell.hasAttribute("data-sort-index")) return;
      if (!(cell.textContent || "").trim()) return;

      var declaredType = cell.getAttribute("data-sort-type");
      if (declaredType) table.__reportSortTypes[entry.index] = declaredType;

      cell.setAttribute("data-sortable", "");
      cell.setAttribute("aria-sort", "none");
      cell.setAttribute("tabindex", "0");
      cell.setAttribute("role", "button");

      // Ascending, then descending, then back to the order the report was
      // rendered in.
      function toggle() {
        var direction = "asc";
        if (table.__reportSortColumn === entry.index) {
          if (table.__reportSortDir === "asc") direction = "desc";
          else if (table.__reportSortDir === "desc") direction = null;
        }
        activate(table, entry, direction);
      }

      cell.addEventListener("click", toggle);
      cell.addEventListener("keydown", function (event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle();
      });
      bound = true;
    });

    if (bound) table.dataset[BOUND] = "true";
  }

  function initReportTableSort(root) {
    var scope =
      root instanceof Element || root instanceof Document ? root : document;
    var tables = Array.prototype.slice.call(
      scope.querySelectorAll("table[data-report-table]"),
    );
    if (!tables.length) return;
    injectStyles();
    tables.forEach(bindTable);
  }

  window.initReportTableSort = initReportTableSort;

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      function () {
        initReportTableSort(document);
      },
      { once: true },
    );
  } else {
    initReportTableSort(document);
  }
})();
