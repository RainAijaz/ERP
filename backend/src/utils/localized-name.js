const knex = require("../db/knex");

// Master-data tables (accounts, parties, labours, employees, departments,
// branches, account_groups, items, product_groups, product_subgroups, colors,
// sizes, uom, production_stages, ...) all carry a name_ur column, but it is
// frequently blank -- NULLIF keeps an empty Urdu name from blanking the cell
// instead of falling back to English.
const resolveLocale = (value) => String(value || "en").toLowerCase();

const localizedNameSql = (alias, locale, column = "name") =>
  resolveLocale(locale) === "ur"
    ? `COALESCE(NULLIF(${alias}.${column}_ur, ''), ${alias}.${column})`
    : `${alias}.${column}`;

// For a COALESCE across sibling tables (a row references exactly one of
// party/labour/employee, say): keep the original alias precedence, but try each
// alias's Urdu name immediately before its English one.
const localizedCoalesceNameSql = (aliases, locale, column = "name") =>
  `COALESCE(${aliases
    .flatMap((alias) =>
      resolveLocale(locale) === "ur"
        ? [`NULLIF(${alias}.${column}_ur, '')`, `${alias}.${column}`]
        : [`${alias}.${column}`],
    )
    .join(", ")})`;

const localizedNameSelect = (alias, as, locale, column = "name") =>
  resolveLocale(locale) === "ur"
    ? knex.raw(`${localizedNameSql(alias, locale, column)} as ${as}`)
    : `${alias}.${column} as ${as}`;

const localizedCoalesceNameSelect = (aliases, as, locale, column = "name") =>
  knex.raw(`${localizedCoalesceNameSql(aliases, locale, column)} as ${as}`);

// Postgres will not infer functional dependency across joined tables, so any
// grouped query selecting a localized name has to group the _ur column too.
const localizedNameGroupBy = (alias, locale, column = "name") =>
  resolveLocale(locale) === "ur"
    ? [`${alias}.${column}`, `${alias}.${column}_ur`]
    : [`${alias}.${column}`];

// Voucher narratives are stored as an en/ur pair written at save time by
// voucher-service.prepareUrduVoucherText: the header remark lands in
// voucher_header.remarks/remarks_ur, and each line's own text in
// voucher_line.meta->>'description' / ->>'description_ur'.
//
// gl_entry.narration is a *copy* of one of those two English strings (see
// gl-posting-service.toNarration) -- the line description when the posting is
// line-driven (cash/bank/journal), the header remark otherwise. gl_entry has
// neither a narration_ur column nor a voucher_line reference, so the Urdu twin
// cannot be joined; it has to be recovered by matching the narration text back
// to the line that produced it, with the header pair as the fallback.
const voucherLineNarrationUrduSql = (narrationExpr, voucherAlias) =>
  `(SELECT NULLIF(vl_narr_ur.meta->>'description_ur', '')
      FROM erp.voucher_line vl_narr_ur
     WHERE vl_narr_ur.voucher_header_id = ${voucherAlias}.id
       AND NULLIF(vl_narr_ur.meta->>'description', '') = NULLIF(${narrationExpr}, '')
     LIMIT 1)`;

// prefer: which English source the report already showed first. Preserved
// exactly, so the English column is unchanged -- Urdu is only tried ahead of
// each English term, never in place of a different one.
const localizedNarrativeSql = ({
  locale,
  narrationExpr = null,
  voucherAlias = "vh",
  prefer = "narration",
  hasRemarksUr = false,
}) => {
  const remarks = `NULLIF(${voucherAlias}.remarks, '')`;
  const narration = narrationExpr ? `NULLIF(${narrationExpr}, '')` : null;
  const isUrdu = resolveLocale(locale) === "ur" && hasRemarksUr;
  const remarksUr = `NULLIF(${voucherAlias}.remarks_ur, '')`;

  if (!narration) {
    return isUrdu ? `COALESCE(${remarksUr}, ${remarks})` : remarks;
  }
  if (!isUrdu) {
    return prefer === "remarks"
      ? `COALESCE(${remarks}, ${narration})`
      : `COALESCE(${narration}, ${remarks})`;
  }
  const narrationUr = voucherLineNarrationUrduSql(narrationExpr, voucherAlias);
  if (prefer === "remarks") {
    return `COALESCE(${remarksUr}, ${remarks}, ${narrationUr}, ${narration})`;
  }
  // Narration first: a line-driven narration keeps its own Urdu (or stays in
  // English rather than being replaced by an unrelated header remark), while a
  // narration copied from the remark resolves through the header pair.
  return `COALESCE(
    ${narrationUr},
    CASE WHEN ${narrationExpr} IS NOT DISTINCT FROM ${voucherAlias}.remarks
         THEN ${remarksUr} END,
    ${narration},
    ${remarksUr},
    ${remarks})`;
};

// Voucher lines carry their own en/ur pair in meta, so unlike gl_entry rows
// they are read directly. Absent on rows written before the pair existed --
// jsonb yields NULL for a missing key, so the English term still wins.
const localizedLineDescriptionSql = (locale, lineAlias = "vl") =>
  resolveLocale(locale) === "ur"
    ? `COALESCE(NULLIF(${lineAlias}.meta->>'description_ur', ''), NULLIF(${lineAlias}.meta->>'description', ''))`
    : `NULLIF(${lineAlias}.meta->>'description', '')`;

// voucher_header.remarks_ur arrived in a later migration, so a database that
// has not run it must not have the column named in SQL at all. Resolved once
// and cached, the same guard the stock ledger uses.
let voucherRemarksUrSupport = null;
const supportsVoucherRemarksUr = () => {
  if (!voucherRemarksUrSupport) {
    voucherRemarksUrSupport = knex.schema
      .withSchema("erp")
      .hasColumn("voucher_header", "remarks_ur")
      .catch(() => false);
  }
  return voucherRemarksUrSupport;
};

module.exports = {
  localizedCoalesceNameSelect,
  localizedCoalesceNameSql,
  localizedLineDescriptionSql,
  localizedNameGroupBy,
  localizedNameSelect,
  localizedNameSql,
  localizedNarrativeSql,
  resolveLocale,
  supportsVoucherRemarksUr,
};
