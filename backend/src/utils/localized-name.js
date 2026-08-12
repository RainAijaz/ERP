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

module.exports = {
  localizedCoalesceNameSelect,
  localizedCoalesceNameSql,
  localizedNameGroupBy,
  localizedNameSelect,
  localizedNameSql,
  resolveLocale,
};
