const XLSX = require("xlsx");
const { insertActivityLog } = require("../../utils/audit-log");
const { generateUniqueCode, slugifyCode } = require("../../utils/entity-code");

const ITEM_TYPES = new Set(["RM", "SFG", "FG"]);
const ACCOUNT_TYPES = new Set([
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "EXPENSE",
]);
const PARTY_TYPES = new Set(["CUSTOMER", "SUPPLIER", "BOTH"]);

const ENTITY_KEYS = Object.freeze({
  units: "units",
  sizes: "sizes",
  colors: "colors",
  grades: "grades",
  packingTypes: "packing_types",
  cities: "cities",
  productGroups: "product_groups",
  productSubgroups: "product_subgroups",
  productTypes: "product_types",
  salesDiscountPolicies: "sales_discount_policies",
  partyGroups: "party_groups",
  departments: "departments",
  uomConversions: "uom_conversions",
  accounts: "accounts",
  parties: "parties",
  products: "products",
});

const TARGET_GROUPS = Object.freeze({
  basic_master_data: {
    key: "basic_master_data",
    labelKey: "import_target_basic_master_data",
    descriptionKey: "import_target_basic_master_data_desc",
    entityKeys: [
      ENTITY_KEYS.units,
      ENTITY_KEYS.sizes,
      ENTITY_KEYS.colors,
      ENTITY_KEYS.grades,
      ENTITY_KEYS.packingTypes,
      ENTITY_KEYS.cities,
      ENTITY_KEYS.productGroups,
      ENTITY_KEYS.productSubgroups,
      ENTITY_KEYS.productTypes,
      ENTITY_KEYS.salesDiscountPolicies,
      ENTITY_KEYS.partyGroups,
      ENTITY_KEYS.departments,
      ENTITY_KEYS.uomConversions,
    ],
  },
  accounts: {
    key: "accounts",
    labelKey: "accounts",
    descriptionKey: "import_target_accounts_desc",
    entityKeys: [ENTITY_KEYS.accounts],
  },
  parties: {
    key: "parties",
    labelKey: "parties",
    descriptionKey: "import_target_parties_desc",
    entityKeys: [ENTITY_KEYS.parties],
  },
  products: {
    key: "products",
    labelKey: "products",
    descriptionKey: "import_target_products_desc",
    entityKeys: [ENTITY_KEYS.products],
  },
});

const SUPPORTED_IMPORT_TARGETS = Object.freeze(
  Object.values(TARGET_GROUPS).map((entry) => ({
    key: entry.key,
    labelKey: entry.labelKey,
    descriptionKey: entry.descriptionKey,
  })),
);

const normalizeHeader = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const trimString = (value) => String(value || "").trim();

const parseBoolean = (value, fallback = null) => {
  const token = String(value || "")
    .trim()
    .toLowerCase();
  if (!token) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(token)) return true;
  if (["0", "false", "no", "n", "off"].includes(token)) return false;
  return fallback;
};

const parseNumber = (value, fallback = null) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseCsv = (value) =>
  String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

const normalizeItemTypes = (value, fallbackAll = false) => {
  const raw = Array.isArray(value) ? value : parseCsv(value);
  const normalized = raw
    .map((entry) => String(entry || "").trim().toUpperCase())
    .filter((entry) => ITEM_TYPES.has(entry));
  const unique = [...new Set(normalized)];
  if (!unique.length && fallbackAll) {
    return ["RM", "SFG", "FG"];
  }
  return unique;
};

const createPlanningContext = () => ({
  staged: {
    uom: new Set(),
    productGroup: new Set(),
    productSubgroup: new Set(),
    productType: new Set(),
    city: new Set(),
    partyGroup: new Set(),
  },
});

const addStagedToken = (set, value) => {
  const token = trimString(value).toLowerCase();
  if (!token) return;
  set.add(token);
};

const hasStagedToken = (set, value) => {
  const token = trimString(value).toLowerCase();
  if (!token) return false;
  return set.has(token);
};

const registerStagedReference = (context, operation) => {
  if (!context?.staged || !operation?.data) return;
  switch (operation.entityKey) {
    case ENTITY_KEYS.units:
      addStagedToken(context.staged.uom, operation.data.code);
      addStagedToken(context.staged.uom, operation.data.name);
      break;
    case ENTITY_KEYS.productGroups:
      addStagedToken(context.staged.productGroup, operation.data.name);
      break;
    case ENTITY_KEYS.productSubgroups:
      addStagedToken(context.staged.productSubgroup, operation.data.code);
      addStagedToken(context.staged.productSubgroup, operation.data.name);
      break;
    case ENTITY_KEYS.productTypes:
      addStagedToken(context.staged.productType, operation.data.code);
      addStagedToken(context.staged.productType, operation.data.name);
      break;
    case ENTITY_KEYS.cities:
      addStagedToken(context.staged.city, operation.data.name);
      break;
    case ENTITY_KEYS.partyGroups:
      addStagedToken(context.staged.partyGroup, operation.data.name);
      break;
    default:
      break;
  }
};

const resolveSelectedTargetKeys = (selectedTargets) => {
  const requested = Array.isArray(selectedTargets)
    ? selectedTargets.map((entry) => String(entry || "").trim().toLowerCase())
    : [];
  const defaults = Object.keys(TARGET_GROUPS);
  const resolved = (requested.length ? requested : defaults).filter(
    (entry) => TARGET_GROUPS[entry],
  );
  return resolved.length ? resolved : defaults;
};

const buildWorkbookRows = (workbookBuffer) => {
  const workbook = XLSX.read(workbookBuffer, {
    type: "buffer",
    dense: true,
    cellDates: false,
  });

  const rows = [];
  workbook.SheetNames.forEach((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      raw: false,
    });

    const headerRow = Array.isArray(matrix[0]) ? matrix[0] : [];
    const headerMap = [];
    const collisionCounter = new Map();

    headerRow.forEach((header, index) => {
      const normalized = normalizeHeader(header);
      if (!normalized) {
        headerMap[index] = null;
        return;
      }
      const seen = collisionCounter.get(normalized) || 0;
      collisionCounter.set(normalized, seen + 1);
      headerMap[index] = seen ? `${normalized}_${seen + 1}` : normalized;
    });

    for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
      const cells = Array.isArray(matrix[rowIndex]) ? matrix[rowIndex] : [];
      const values = {};
      let hasAnyValue = false;
      for (let col = 0; col < headerMap.length; col += 1) {
        const key = headerMap[col];
        if (!key) continue;
        const value = trimString(cells[col]);
        if (value) hasAnyValue = true;
        values[key] = value;
      }
      if (!hasAnyValue) continue;
      rows.push({
        sheetName,
        rowNumber: rowIndex + 1,
        values,
      });
    }
  });

  return rows;
};

const resolveFieldValue = (rowValues, aliases) => {
  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    if (!normalizedAlias) continue;
    if (Object.prototype.hasOwnProperty.call(rowValues, normalizedAlias)) {
      const value = trimString(rowValues[normalizedAlias]);
      if (value) return value;
    }
  }
  return "";
};

const extractEntityRows = (workbookRows, entitySpec) => {
  const extracted = [];
  for (const workbookRow of workbookRows) {
    if (
      Array.isArray(entitySpec.sheetMatchers) &&
      entitySpec.sheetMatchers.length &&
      !entitySpec.sheetMatchers.some((matcher) => matcher.test(workbookRow.sheetName))
    ) {
      continue;
    }

    const payload = {};
    let hasAnyValue = false;
    Object.entries(entitySpec.fieldAliases).forEach(([field, aliases]) => {
      const value = resolveFieldValue(workbookRow.values, aliases);
      payload[field] = value;
      if (value) hasAnyValue = true;
    });

    if (hasAnyValue) {
      extracted.push({
        sheetName: workbookRow.sheetName,
        rowNumber: workbookRow.rowNumber,
        raw: payload,
      });
    }
  }
  return extracted;
};

const makeRowError = (entityKey, row, message) => ({
  entityKey,
  sheetName: row.sheetName,
  rowNumber: row.rowNumber,
  message,
});

const makeEntitySummary = (entityKey, rowsTotal) => ({
  entityKey,
  rowsTotal,
  rowsPlanned: 0,
  createCount: 0,
  updateCount: 0,
  skipCount: 0,
  errorCount: 0,
  warningCount: 0,
});

const toNameCode = (value, fallback = "") => {
  const base = slugifyCode(value, 80);
  return base || slugifyCode(fallback, 80) || "item";
};

const syncItemTypeMap = async ({ trx, table, keyColumn, ownerId, itemTypes }) => {
  const deduped = [...new Set(itemTypes.filter((entry) => ITEM_TYPES.has(entry)))];
  await trx(table).where({ [keyColumn]: ownerId }).del();
  if (!deduped.length) return;
  await trx(table).insert(
    deduped.map((itemType) => ({ [keyColumn]: ownerId, item_type: itemType })),
  );
};

const syncBranchMap = async ({ trx, table, keyColumn, ownerId, branchIds }) => {
  const normalized = [...new Set(branchIds.map((entry) => Number(entry)).filter((id) => id > 0))];
  await trx(table).where({ [keyColumn]: ownerId }).del();
  if (!normalized.length) return;
  await trx(table).insert(
    normalized.map((branchId) => ({ [keyColumn]: ownerId, branch_id: branchId })),
  );
};

const resolveUomByToken = async (db, token) => {
  const value = trimString(token);
  if (!value) return null;
  return db("erp.uom")
    .select("id", "code", "name")
    .whereRaw("lower(code) = ? OR lower(name) = ?", [
      value.toLowerCase(),
      value.toLowerCase(),
    ])
    .first();
};

const resolveProductGroupByToken = async (db, token) => {
  const value = trimString(token);
  if (!value) return null;
  return db("erp.product_groups")
    .select("id", "name")
    .whereRaw("lower(name) = ?", [value.toLowerCase()])
    .first();
};

const resolveProductSubgroupByToken = async (db, token) => {
  const value = trimString(token);
  if (!value) return null;
  return db("erp.product_subgroups")
    .select("id", "name", "code")
    .whereRaw("lower(code) = ? OR lower(name) = ?", [
      value.toLowerCase(),
      value.toLowerCase(),
    ])
    .first();
};

const resolveProductTypeByToken = async (db, token) => {
  const value = trimString(token);
  if (!value) return null;
  return db("erp.product_types")
    .select("id", "code", "name")
    .whereRaw("lower(code) = ? OR lower(name) = ?", [
      value.toLowerCase(),
      value.toLowerCase(),
    ])
    .first();
};

const resolveCityByToken = async (db, token) => {
  const value = trimString(token);
  if (!value) return null;
  return db("erp.cities")
    .select("id", "name")
    .whereRaw("lower(name) = ?", [value.toLowerCase()])
    .first();
};

const resolvePartyGroupByToken = async (db, token) => {
  const value = trimString(token);
  if (!value) return null;
  return db("erp.party_groups")
    .select("id", "name", "party_type")
    .whereRaw("lower(name) = ?", [value.toLowerCase()])
    .first();
};

const resolveBranchIdsByTokens = async (db, tokens) => {
  const unique = [...new Set(tokens.map((entry) => trimString(entry).toLowerCase()).filter(Boolean))];
  if (!unique.length) return [];
  const rows = await db("erp.branches")
    .select("id", "code", "name")
    .where((builder) => {
      unique.forEach((token, index) => {
        if (index === 0) {
          builder.whereRaw("lower(code) = ? OR lower(name) = ?", [
            token,
            token,
          ]);
          return;
        }
        builder.orWhereRaw("lower(code) = ? OR lower(name) = ?", [
          token,
          token,
        ]);
      });
    });
  return rows.map((row) => Number(row.id)).filter((id) => id > 0);
};

const ENTITY_SPECS = Object.freeze({
  [ENTITY_KEYS.units]: {
    fieldAliases: {
      name: ["units_name", "unit_name", "name"],
      nameUr: ["units_name_urdu", "units_name_ur", "name_ur", "name_urdu"],
      code: ["units_code", "unit_code", "code"],
      isActive: ["units_is_active", "is_active"],
    },
    async plan(row, db, actorId) {
      const name = trimString(row.raw.name);
      if (!name) return { error: "Unit name is required." };
      const nameUr = trimString(row.raw.nameUr) || name;
      const isActive = parseBoolean(row.raw.isActive, true);
      const codeInput = trimString(row.raw.code);
      const code = codeInput || toNameCode(name, "uom");
      const existing = await db("erp.uom")
        .select("id")
        .whereRaw("lower(code) = ? OR lower(name) = ?", [
          code.toLowerCase(),
          name.toLowerCase(),
        ])
        .first();
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          code,
          name,
          name_ur: nameUr,
          is_active: isActive,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      const payload = {
        code: op.data.code,
        name: op.data.name,
        name_ur: op.data.name_ur,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        await trx("erp.uom").insert({
          ...payload,
          created_by: actorId,
          created_at: trx.fn.now(),
        });
      } else {
        await trx("erp.uom").where({ id: op.data.id }).update(payload);
      }
    },
  },
  [ENTITY_KEYS.sizes]: {
    fieldAliases: {
      name: ["sizes_size", "sizes_name", "name"],
      nameUr: ["sizes_name_urdu", "sizes_name_ur", "name_ur"],
      appliesTo: ["sizes_applies_to", "applies_to", "item_types"],
      isActive: ["sizes_is_active", "is_active"],
    },
    async plan(row, db, actorId) {
      const name = trimString(row.raw.name);
      if (!name) return { error: "Size name is required." };
      const nameUr = trimString(row.raw.nameUr) || name;
      const itemTypes = normalizeItemTypes(row.raw.appliesTo, true);
      if (!itemTypes.length) return { error: "At least one size item type is required." };
      const isActive = parseBoolean(row.raw.isActive, true);
      const existing = await db("erp.sizes")
        .select("id")
        .whereRaw("lower(name) = ?", [name.toLowerCase()])
        .first();
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          name,
          name_ur: nameUr,
          is_active: isActive,
          itemTypes,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      let ownerId = op.data.id;
      if (op.action === "create") {
        const [created] = await trx("erp.sizes")
          .insert({
            name: op.data.name,
            name_ur: op.data.name_ur,
            is_active: op.data.is_active,
            created_by: actorId,
            created_at: trx.fn.now(),
            updated_by: actorId,
            updated_at: trx.fn.now(),
          })
          .returning(["id"]);
        ownerId = created?.id;
      } else {
        await trx("erp.sizes").where({ id: ownerId }).update({
          name: op.data.name,
          name_ur: op.data.name_ur,
          is_active: op.data.is_active,
          updated_by: actorId,
          updated_at: trx.fn.now(),
        });
      }
      await syncItemTypeMap({
        trx,
        table: "erp.size_item_types",
        keyColumn: "size_id",
        ownerId,
        itemTypes: op.data.itemTypes,
      });
    },
  },
  [ENTITY_KEYS.colors]: {
    fieldAliases: {
      name: ["colors_color", "colors_name", "name"],
      nameUr: ["color_urdu_name", "colors_name_urdu", "colors_name_ur", "name_ur"],
      isActive: ["colors_is_active", "is_active"],
    },
    async plan(row, db, actorId) {
      const name = trimString(row.raw.name);
      if (!name) return { error: "Color name is required." };
      const nameUr = trimString(row.raw.nameUr) || name;
      const isActive = parseBoolean(row.raw.isActive, true);
      const existing = await db("erp.colors")
        .select("id")
        .whereRaw("lower(name) = ?", [name.toLowerCase()])
        .first();
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          name,
          name_ur: nameUr,
          is_active: isActive,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      const payload = {
        name: op.data.name,
        name_ur: op.data.name_ur,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        await trx("erp.colors").insert({
          ...payload,
          created_by: actorId,
          created_at: trx.fn.now(),
        });
      } else {
        await trx("erp.colors").where({ id: op.data.id }).update(payload);
      }
    },
  },
  [ENTITY_KEYS.grades]: {
    fieldAliases: {
      name: ["grades_grade", "grades_name", "name"],
      nameUr: ["grades_name_urdu", "grades_name_ur", "name_ur"],
      gradeRank: ["grades_grade_rank", "grade_rank"],
      isActive: ["grades_is_active", "is_active"],
    },
    async plan(row, db, actorId) {
      const name = trimString(row.raw.name);
      if (!name) return { error: "Grade name is required." };
      const nameUr = trimString(row.raw.nameUr) || name;
      const gradeRank = Math.max(1, Number(parseNumber(row.raw.gradeRank, 1)) || 1);
      const isActive = parseBoolean(row.raw.isActive, true);
      const existing = await db("erp.grades")
        .select("id")
        .whereRaw("lower(name) = ?", [name.toLowerCase()])
        .first();
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          name,
          name_ur: nameUr,
          grade_rank: gradeRank,
          is_active: isActive,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      const payload = {
        name: op.data.name,
        name_ur: op.data.name_ur,
        grade_rank: op.data.grade_rank,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        await trx("erp.grades").insert({
          ...payload,
          created_by: actorId,
          created_at: trx.fn.now(),
        });
      } else {
        await trx("erp.grades").where({ id: op.data.id }).update(payload);
      }
    },
  },
  [ENTITY_KEYS.packingTypes]: {
    fieldAliases: {
      name: ["packing_types_packing_type", "packing_type", "name"],
      nameUr: ["packing_types_name_urdu", "packing_types_name_ur", "name_ur"],
      isActive: ["packing_types_is_active", "is_active"],
    },
    async plan(row, db, actorId) {
      const name = trimString(row.raw.name);
      if (!name) return { error: "Packing type is required." };
      const nameUr = trimString(row.raw.nameUr) || name;
      const isActive = parseBoolean(row.raw.isActive, true);
      const existing = await db("erp.packing_types")
        .select("id")
        .whereRaw("lower(name) = ?", [name.toLowerCase()])
        .first();
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          name,
          name_ur: nameUr,
          is_active: isActive,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      const payload = {
        name: op.data.name,
        name_ur: op.data.name_ur,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        await trx("erp.packing_types").insert({
          ...payload,
          created_by: actorId,
          created_at: trx.fn.now(),
        });
      } else {
        await trx("erp.packing_types").where({ id: op.data.id }).update(payload);
      }
    },
  },
  [ENTITY_KEYS.cities]: {
    fieldAliases: {
      name: ["cities_city", "city", "name"],
      nameUr: ["cities_name_urdu", "cities_name_ur", "name_ur"],
      isActive: ["cities_is_active", "is_active"],
    },
    async plan(row, db, actorId) {
      const name = trimString(row.raw.name);
      if (!name) return { error: "City name is required." };
      const nameUr = trimString(row.raw.nameUr) || name;
      const isActive = parseBoolean(row.raw.isActive, true);
      const existing = await db("erp.cities")
        .select("id")
        .whereRaw("lower(name) = ?", [name.toLowerCase()])
        .first();
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          name,
          name_ur: nameUr,
          is_active: isActive,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      const payload = {
        name: op.data.name,
        name_ur: op.data.name_ur,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        await trx("erp.cities").insert({
          ...payload,
          created_by: actorId,
          created_at: trx.fn.now(),
        });
      } else {
        await trx("erp.cities").where({ id: op.data.id }).update(payload);
      }
    },
  },
  [ENTITY_KEYS.productGroups]: {
    fieldAliases: {
      name: ["product_groups_group_name", "group_name", "name"],
      nameUr: ["product_groups_name_urdu", "product_groups_name_ur", "name_ur"],
      appliesTo: ["product_groups_applies_to", "applies_to", "item_types"],
      isActive: ["product_groups_is_active", "is_active"],
    },
    async plan(row, db, actorId) {
      const name = trimString(row.raw.name);
      if (!name) return { error: "Product group name is required." };
      const nameUr = trimString(row.raw.nameUr);
      if (!nameUr) return { error: "Product group Urdu name is required." };
      const itemTypes = normalizeItemTypes(row.raw.appliesTo, true);
      const isActive = parseBoolean(row.raw.isActive, true);
      const existing = await db("erp.product_groups")
        .select("id")
        .whereRaw("lower(name) = ?", [name.toLowerCase()])
        .first();
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          name,
          name_ur: nameUr,
          is_active: isActive,
          itemTypes,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      let ownerId = op.data.id;
      if (op.action === "create") {
        const [created] = await trx("erp.product_groups")
          .insert({
            name: op.data.name,
            name_ur: op.data.name_ur,
            is_active: op.data.is_active,
            created_by: actorId,
            created_at: trx.fn.now(),
            updated_by: actorId,
            updated_at: trx.fn.now(),
          })
          .returning(["id"]);
        ownerId = created?.id;
      } else {
        await trx("erp.product_groups").where({ id: ownerId }).update({
          name: op.data.name,
          name_ur: op.data.name_ur,
          is_active: op.data.is_active,
          updated_by: actorId,
          updated_at: trx.fn.now(),
        });
      }

      await syncItemTypeMap({
        trx,
        table: "erp.product_group_item_types",
        keyColumn: "group_id",
        ownerId,
        itemTypes: op.data.itemTypes,
      });
    },
  },
  [ENTITY_KEYS.productSubgroups]: {
    fieldAliases: {
      name: ["product_subgroup", "product_subgroups_name", "name"],
      nameUr: [
        "product_subgroup_in_urdu",
        "product_subgroup_urdu",
        "product_subgroups_name_urdu",
        "name_ur",
      ],
      group: ["product_subgroups_group_name", "group_name", "product_group"],
      code: ["product_subgroups_code", "subgroup_code", "code"],
      appliesTo: ["product_subgroups_applies_to", "applies_to", "item_types"],
      isActive: ["product_subgroups_is_active", "is_active"],
    },
    async plan(row, db, actorId, context) {
      const name = trimString(row.raw.name);
      if (!name) return { error: "Product subgroup name is required." };
      const nameUr = trimString(row.raw.nameUr) || name;
      const groupToken = trimString(row.raw.group);
      let groupId = null;
      if (groupToken) {
        const group = await resolveProductGroupByToken(db, groupToken);
        if (!group?.id) {
          if (!hasStagedToken(context?.staged?.productGroup, groupToken)) {
            return { error: `Product group not found: ${groupToken}` };
          }
          groupId = null;
        } else {
          groupId = group.id;
        }
      }
      const code = trimString(row.raw.code) || toNameCode(name, "subgroup");
      const itemTypes = normalizeItemTypes(row.raw.appliesTo, true);
      const isActive = parseBoolean(row.raw.isActive, true);
      const existing = await db("erp.product_subgroups")
        .select("id")
        .whereRaw("lower(code) = ? OR lower(name) = ?", [
          code.toLowerCase(),
          name.toLowerCase(),
        ])
        .first();
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          group_id: groupId,
          group_token: groupToken || null,
          code,
          name,
          name_ur: nameUr,
          is_active: isActive,
          itemTypes,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      let ownerId = op.data.id;
      let groupId = op.data.group_id;
      if (!groupId && op.data.group_token) {
        const group = await resolveProductGroupByToken(trx, op.data.group_token);
        groupId = group?.id || null;
      }
      if (op.action === "create") {
        const [created] = await trx("erp.product_subgroups")
          .insert({
            group_id: groupId,
            code: op.data.code,
            name: op.data.name,
            name_ur: op.data.name_ur,
            is_active: op.data.is_active,
            created_by: actorId,
            created_at: trx.fn.now(),
            updated_by: actorId,
            updated_at: trx.fn.now(),
          })
          .returning(["id"]);
        ownerId = created?.id;
      } else {
        await trx("erp.product_subgroups").where({ id: ownerId }).update({
          group_id: groupId,
          code: op.data.code,
          name: op.data.name,
          name_ur: op.data.name_ur,
          is_active: op.data.is_active,
          updated_by: actorId,
          updated_at: trx.fn.now(),
        });
      }

      await syncItemTypeMap({
        trx,
        table: "erp.product_subgroup_item_types",
        keyColumn: "subgroup_id",
        ownerId,
        itemTypes: op.data.itemTypes,
      });
    },
  },
  [ENTITY_KEYS.productTypes]: {
    fieldAliases: {
      name: ["product_types_product_type", "product_type", "name"],
      nameUr: ["product_types_name_urdu", "product_types_name_ur", "name_ur"],
      code: ["product_types_code", "code"],
      isActive: ["product_types_is_active", "is_active"],
    },
    async plan(row, db, actorId) {
      const name = trimString(row.raw.name);
      if (!name) return { error: "Product type name is required." };
      const nameUr = trimString(row.raw.nameUr) || name;
      const code = trimString(row.raw.code) || toNameCode(name, "type");
      const isActive = parseBoolean(row.raw.isActive, true);
      const existing = await db("erp.product_types")
        .select("id")
        .whereRaw("lower(code) = ? OR lower(name) = ?", [
          code.toLowerCase(),
          name.toLowerCase(),
        ])
        .first();
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          code,
          name,
          name_ur: nameUr,
          is_active: isActive,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      const payload = {
        code: op.data.code,
        name: op.data.name,
        name_ur: op.data.name_ur,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        await trx("erp.product_types").insert({
          ...payload,
          created_by: actorId,
          created_at: trx.fn.now(),
        });
      } else {
        await trx("erp.product_types").where({ id: op.data.id }).update(payload);
      }
    },
  },
  [ENTITY_KEYS.salesDiscountPolicies]: {
    fieldAliases: {
      productGroup: [
        "sales_discount_policies_product_group",
        "sales_discount_policy_product_group",
        "product_group",
      ],
      maxPairDiscount: [
        "sales_discount_policies_max_pair_discount",
        "max_pair_discount",
      ],
      isActive: [
        "sales_discount_policies_is_active",
        "sales_discount_policy_is_active",
        "is_active",
      ],
    },
    async plan(row, db, actorId, context) {
      const productGroupToken = trimString(row.raw.productGroup);
      if (!productGroupToken) return { skip: true };
      const group = await resolveProductGroupByToken(db, productGroupToken);
      if (!group?.id) {
        if (!hasStagedToken(context?.staged?.productGroup, productGroupToken)) {
          return {
            error: `Product group not found for discount policy: ${productGroupToken}`,
          };
        }
      }
      const maxPairDiscount = parseNumber(row.raw.maxPairDiscount, null);
      if (maxPairDiscount === null || maxPairDiscount < 0) {
        return {
          error: "Sales discount policy requires a valid non-negative max pair discount.",
        };
      }
      const isActive = parseBoolean(row.raw.isActive, true);
      const existing = await db("erp.sales_discount_policy")
        .select("id")
        .where({ product_group_id: group.id })
        .first();
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          product_group_id: group?.id || null,
          product_group_token: productGroupToken,
          max_pair_discount: Number(maxPairDiscount.toFixed(2)),
          is_active: isActive,
        },
      };
    },
    async apply(op, trx, actorId) {
      let productGroupId = op.data.product_group_id;
      if (!productGroupId && op.data.product_group_token) {
        const group = await resolveProductGroupByToken(
          trx,
          op.data.product_group_token,
        );
        productGroupId = group?.id || null;
      }
      if (!productGroupId) {
        throw new Error(
          `Product group not found while applying sales discount policy: ${
            op.data.product_group_token || "(empty)"
          }`,
        );
      }
      const payload = {
        product_group_id: productGroupId,
        max_pair_discount: op.data.max_pair_discount,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        await trx("erp.sales_discount_policy").insert({
          ...payload,
          created_by: actorId,
          created_at: trx.fn.now(),
        });
      } else {
        await trx("erp.sales_discount_policy").where({ id: op.data.id }).update(payload);
      }
    },
  },
  [ENTITY_KEYS.partyGroups]: {
    fieldAliases: {
      partyType: ["party_groups_group_type", "party_type", "group_type"],
      name: ["party_groups_party_name", "party_group_name", "name"],
      nameUr: ["party_groups_name_urdu", "party_groups_name_ur", "name_ur"],
      isActive: ["party_groups_is_active", "is_active"],
    },
    async plan(row, db, actorId) {
      const name = trimString(row.raw.name);
      if (!name) return { error: "Party group name is required." };
      const partyType = String(row.raw.partyType || "BOTH").trim().toUpperCase();
      if (!PARTY_TYPES.has(partyType)) {
        return { error: `Invalid party group type: ${partyType || "(empty)"}` };
      }
      const nameUr = trimString(row.raw.nameUr) || name;
      const isActive = parseBoolean(row.raw.isActive, true);
      const existing = await db("erp.party_groups")
        .select("id")
        .whereRaw("lower(name) = ?", [name.toLowerCase()])
        .first();
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          party_type: partyType,
          name,
          name_ur: nameUr,
          is_active: isActive,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      const payload = {
        party_type: op.data.party_type,
        name: op.data.name,
        name_ur: op.data.name_ur,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        await trx("erp.party_groups").insert({
          ...payload,
          created_by: actorId,
          created_at: trx.fn.now(),
        });
      } else {
        await trx("erp.party_groups").where({ id: op.data.id }).update(payload);
      }
    },
  },
  [ENTITY_KEYS.departments]: {
    fieldAliases: {
      name: ["english_department_name", "department_name", "name"],
      nameUr: ["urdu_name_transliteration", "departments_name_urdu", "name_ur"],
      isProduction: ["departments_production_dept", "is_production", "production_dept"],
      isActive: ["departments_is_active", "is_active"],
    },
    async plan(row, db, actorId) {
      const name = trimString(row.raw.name);
      if (!name) return { error: "Department name is required." };
      const nameUr = trimString(row.raw.nameUr) || name;
      const isProduction = parseBoolean(row.raw.isProduction, false);
      const isActive = parseBoolean(row.raw.isActive, true);
      const existing = await db("erp.departments")
        .select("id")
        .whereRaw("lower(name) = ?", [name.toLowerCase()])
        .first();
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          name,
          name_ur: nameUr,
          is_production: isProduction,
          is_active: isActive,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      const payload = {
        name: op.data.name,
        name_ur: op.data.name_ur,
        is_production: op.data.is_production,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        await trx("erp.departments").insert({
          ...payload,
          created_by: actorId,
          created_at: trx.fn.now(),
        });
      } else {
        await trx("erp.departments").where({ id: op.data.id }).update(payload);
      }
    },
  },
  [ENTITY_KEYS.uomConversions]: {
    fieldAliases: {
      fromUnit: ["uom_conversions_from_unit", "from_unit", "from_uom"],
      toUnit: ["uom_conversions_to_unit", "to_unit", "to_uom"],
      factor: ["uom_conversions_factor", "factor"],
      isActive: ["uom_conversions_is_active", "is_active"],
    },
    async plan(row, db, actorId, context) {
      const fromToken = trimString(row.raw.fromUnit);
      const toToken = trimString(row.raw.toUnit);
      if (!fromToken && !toToken) return { skip: true };
      if (!fromToken || !toToken) {
        return { error: "UOM conversion requires both from and to units." };
      }
      const [fromUom, toUom] = await Promise.all([
        resolveUomByToken(db, fromToken),
        resolveUomByToken(db, toToken),
      ]);
      const hasFrom = Boolean(fromUom?.id) || hasStagedToken(context?.staged?.uom, fromToken);
      const hasTo = Boolean(toUom?.id) || hasStagedToken(context?.staged?.uom, toToken);
      if (!hasFrom) return { error: `From unit not found: ${fromToken}` };
      if (!hasTo) return { error: `To unit not found: ${toToken}` };
      if (fromUom?.id && toUom?.id && Number(fromUom.id) === Number(toUom.id)) {
        return { error: "From unit and to unit must be different." };
      }
      const factor = parseNumber(row.raw.factor, null);
      if (factor === null || factor <= 0) {
        return { error: "UOM conversion factor must be greater than zero." };
      }
      const isActive = parseBoolean(row.raw.isActive, true);
      let existing = null;
      if (fromUom?.id && toUom?.id) {
        existing = await db("erp.uom_conversions")
          .select("id")
          .where({ from_uom_id: fromUom.id, to_uom_id: toUom.id })
          .first();
      }
      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          from_uom_id: fromUom?.id || null,
          to_uom_id: toUom?.id || null,
          from_uom_token: fromToken,
          to_uom_token: toToken,
          factor,
          is_active: isActive,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      let fromUomId = op.data.from_uom_id;
      if (!fromUomId && op.data.from_uom_token) {
        const fromUom = await resolveUomByToken(trx, op.data.from_uom_token);
        fromUomId = fromUom?.id || null;
      }
      let toUomId = op.data.to_uom_id;
      if (!toUomId && op.data.to_uom_token) {
        const toUom = await resolveUomByToken(trx, op.data.to_uom_token);
        toUomId = toUom?.id || null;
      }
      if (!fromUomId || !toUomId) {
        throw new Error(
          `UOM conversion references unknown unit(s): ${
            op.data.from_uom_token || ""
          } -> ${op.data.to_uom_token || ""}`,
        );
      }
      if (Number(fromUomId) === Number(toUomId)) {
        throw new Error("From and To UOM cannot be the same.");
      }
      const payload = {
        from_uom_id: fromUomId,
        to_uom_id: toUomId,
        factor: op.data.factor,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        await trx("erp.uom_conversions").insert({
          ...payload,
          created_by: actorId,
          created_at: trx.fn.now(),
        });
      } else {
        await trx("erp.uom_conversions").where({ id: op.data.id }).update(payload);
      }
    },
  },
  [ENTITY_KEYS.accounts]: {
    sheetMatchers: [/accounts?/i],
    fieldAliases: {
      code: ["accounts_code", "account_code", "code"],
      name: ["accounts_name", "account_name", "name"],
      nameUr: ["accounts_name_urdu", "accounts_name_ur", "name_ur"],
      accountType: ["accounts_account_type", "account_type"],
      subgroup: ["accounts_group", "account_group", "subgroup"],
      subgroupCode: ["accounts_group_code", "account_group_code", "subgroup_code"],
      postingClassCode: ["accounts_posting_class_code", "posting_class_code"],
      isContra: ["accounts_is_contra", "is_contra"],
      lockPosting: ["accounts_lock_posting", "lock_posting"],
      isActive: ["accounts_is_active", "is_active"],
      branchCodes: ["accounts_branch_codes", "branch_codes", "branches"],
    },
    async plan(row, db, actorId) {
      const name = trimString(row.raw.name);
      if (!name) return { skip: true };
      const code = trimString(row.raw.code);
      const accountType = String(row.raw.accountType || "")
        .trim()
        .toUpperCase();
      if (!ACCOUNT_TYPES.has(accountType)) {
        return { error: `Invalid account type for account ${name}: ${accountType || "(empty)"}` };
      }
      const subgroupCode = trimString(row.raw.subgroupCode);
      const subgroupName = trimString(row.raw.subgroup);
      if (!subgroupCode && !subgroupName) {
        return { error: `Account group is required for account ${name}.` };
      }
      let subgroup = null;
      if (subgroupCode) {
        subgroup = await db("erp.account_groups")
          .select("id", "account_type")
          .whereRaw("lower(code) = ?", [subgroupCode.toLowerCase()])
          .first();
      }
      if (!subgroup && subgroupName) {
        subgroup = await db("erp.account_groups")
          .select("id", "account_type")
          .whereRaw("lower(name) = ?", [subgroupName.toLowerCase()])
          .first();
      }
      if (!subgroup?.id) {
        return {
          error: `Account group not found for account ${name}: ${subgroupCode || subgroupName}`,
        };
      }
      if (String(subgroup.account_type || "").toUpperCase() !== accountType) {
        return {
          error: `Account group type mismatch for ${name}. Expected ${accountType}.`,
        };
      }

      const postingClassCode = trimString(row.raw.postingClassCode);
      let postingClassId = null;
      if (postingClassCode) {
        const postingClass = await db("erp.account_posting_classes")
          .select("id")
          .whereRaw("lower(code) = ?", [postingClassCode.toLowerCase()])
          .first();
        if (!postingClass?.id) {
          return {
            error: `Posting class not found for account ${name}: ${postingClassCode}`,
          };
        }
        postingClassId = postingClass.id;
      }

      const branchTokens = parseCsv(row.raw.branchCodes);
      const branchIds = await resolveBranchIdsByTokens(db, branchTokens);
      if (branchTokens.length && branchIds.length !== branchTokens.length) {
        return {
          error: `One or more branch codes are invalid for account ${name}.`,
        };
      }

      const finalCode = code || (await generateUniqueCode({ name, knex: db, table: "erp.accounts" }));
      const existing = await db("erp.accounts")
        .select("id")
        .whereRaw("lower(code) = ? OR lower(name) = ?", [
          finalCode.toLowerCase(),
          name.toLowerCase(),
        ])
        .first();

      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          code: finalCode,
          name,
          name_ur: trimString(row.raw.nameUr) || name,
          account_type: accountType,
          subgroup_id: subgroup.id,
          posting_class_id: postingClassId,
          is_contra: parseBoolean(row.raw.isContra, false),
          lock_posting: parseBoolean(row.raw.lockPosting, false),
          is_active: parseBoolean(row.raw.isActive, true),
          branch_ids: branchIds,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      let accountId = op.data.id;
      const payload = {
        code: op.data.code,
        name: op.data.name,
        name_ur: op.data.name_ur,
        subgroup_id: op.data.subgroup_id,
        posting_class_id: op.data.posting_class_id,
        is_contra: op.data.is_contra,
        lock_posting: op.data.lock_posting,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        const [created] = await trx("erp.accounts")
          .insert({
            ...payload,
            created_by: actorId,
            created_at: trx.fn.now(),
          })
          .returning(["id"]);
        accountId = created?.id;
      } else {
        await trx("erp.accounts").where({ id: accountId }).update(payload);
      }
      if (op.data.branch_ids?.length) {
        await syncBranchMap({
          trx,
          table: "erp.account_branch",
          keyColumn: "account_id",
          ownerId: accountId,
          branchIds: op.data.branch_ids,
        });
      }
    },
  },
  [ENTITY_KEYS.parties]: {
    sheetMatchers: [/parties?/i],
    fieldAliases: {
      code: ["parties_code", "party_code", "code"],
      name: ["parties_name", "party_name", "name"],
      nameUr: ["parties_name_urdu", "parties_name_ur", "name_ur"],
      partyType: ["parties_type", "party_type", "type"],
      groupName: ["parties_group", "party_group", "group"],
      cityName: ["parties_city", "city"],
      phone1: ["parties_phone1", "phone1", "phone"],
      phone2: ["parties_phone2", "phone2"],
      address: ["parties_address", "address"],
      creditAllowed: ["parties_credit_allowed", "credit_allowed"],
      creditLimit: ["parties_credit_limit", "credit_limit"],
      isActive: ["parties_is_active", "is_active"],
      branchCodes: ["parties_branch_codes", "branch_codes", "branches"],
    },
    async plan(row, db, actorId, context) {
      const name = trimString(row.raw.name);
      if (!name) return { skip: true };

      const partyType = String(row.raw.partyType || "")
        .trim()
        .toUpperCase();
      if (!PARTY_TYPES.has(partyType)) {
        return { error: `Invalid party type for ${name}: ${partyType || "(empty)"}` };
      }

      const cityToken = trimString(row.raw.cityName);
      const city = cityToken ? await resolveCityByToken(db, cityToken) : null;
      if (!city?.id) {
        if (!hasStagedToken(context?.staged?.city, cityToken)) {
          return {
            error: `City not found for party ${name}: ${cityToken || "(empty)"}`,
          };
        }
      }

      const groupToken = trimString(row.raw.groupName);
      const partyGroup = groupToken ? await resolvePartyGroupByToken(db, groupToken) : null;
      if (groupToken && !partyGroup?.id) {
        if (!hasStagedToken(context?.staged?.partyGroup, groupToken)) {
          return {
            error: `Party group not found for party ${name}: ${groupToken}`,
          };
        }
      }

      const branchTokens = parseCsv(row.raw.branchCodes);
      const branchIds = await resolveBranchIdsByTokens(db, branchTokens);
      if (branchTokens.length && branchIds.length !== branchTokens.length) {
        return {
          error: `One or more branch codes are invalid for party ${name}.`,
        };
      }
      if (!branchIds.length) {
        return { error: `At least one valid branch code is required for party ${name}.` };
      }

      const code =
        trimString(row.raw.code) || (await generateUniqueCode({ name, knex: db, table: "erp.parties" }));
      const existing = await db("erp.parties")
        .select("id")
        .whereRaw("lower(code) = ? OR lower(name) = ?", [
          code.toLowerCase(),
          name.toLowerCase(),
        ])
        .first();

      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          code,
          name,
          name_ur: trimString(row.raw.nameUr) || name,
          party_type: partyType,
          group_id: partyGroup?.id || null,
          group_token: groupToken || null,
          city_id: city?.id || null,
          city_token: cityToken || null,
          city: city?.name || cityToken,
          phone1: trimString(row.raw.phone1),
          phone2: trimString(row.raw.phone2) || null,
          address: trimString(row.raw.address) || null,
          credit_allowed: parseBoolean(row.raw.creditAllowed, true),
          credit_limit: parseNumber(row.raw.creditLimit, 500000) || 500000,
          is_active: parseBoolean(row.raw.isActive, true),
          branch_ids: branchIds,
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      let partyId = op.data.id;
      let cityId = op.data.city_id;
      let cityName = op.data.city;
      if (!cityId && op.data.city_token) {
        const city = await resolveCityByToken(trx, op.data.city_token);
        cityId = city?.id || null;
        cityName = city?.name || cityName;
      }
      if (!cityId) {
        throw new Error(
          `City not found while applying party import: ${
            op.data.city_token || "(empty)"
          }`,
        );
      }
      let groupId = op.data.group_id;
      if (!groupId && op.data.group_token) {
        const partyGroup = await resolvePartyGroupByToken(trx, op.data.group_token);
        groupId = partyGroup?.id || null;
      }
      const payload = {
        code: op.data.code,
        name: op.data.name,
        name_ur: op.data.name_ur,
        party_type: op.data.party_type,
        branch_id: op.data.branch_ids[0] || null,
        group_id: groupId,
        city_id: cityId,
        city: cityName,
        phone1: op.data.phone1,
        phone2: op.data.phone2,
        address: op.data.address,
        credit_allowed: op.data.credit_allowed,
        credit_limit: op.data.credit_limit,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        const [created] = await trx("erp.parties")
          .insert({
            ...payload,
            created_by: actorId,
            created_at: trx.fn.now(),
          })
          .returning(["id"]);
        partyId = created?.id;
      } else {
        await trx("erp.parties").where({ id: partyId }).update(payload);
      }

      await syncBranchMap({
        trx,
        table: "erp.party_branch",
        keyColumn: "party_id",
        ownerId: partyId,
        branchIds: op.data.branch_ids,
      });
    },
  },
  [ENTITY_KEYS.products]: {
    sheetMatchers: [/products?/i, /items?/i],
    fieldAliases: {
      itemType: ["products_item_type", "item_type", "type"],
      code: ["products_code", "item_code", "code"],
      name: ["products_name", "item_name", "name"],
      nameUr: ["products_name_urdu", "products_name_ur", "name_ur"],
      groupName: ["products_group", "group_name", "product_group"],
      subgroupName: ["products_subgroup", "subgroup_name", "product_subgroup"],
      productType: ["products_product_type", "product_type"],
      baseUom: ["products_base_uom", "base_uom", "uom"],
      minStockLevel: ["products_min_stock_level", "min_stock_level"],
      usesSfg: ["products_uses_sfg", "uses_sfg"],
      sfgPartType: ["products_sfg_part_type", "sfg_part_type"],
      isActive: ["products_is_active", "is_active"],
    },
    async plan(row, db, actorId, context) {
      const name = trimString(row.raw.name);
      if (!name) return { skip: true };
      const itemType = String(row.raw.itemType || "")
        .trim()
        .toUpperCase();
      if (!ITEM_TYPES.has(itemType)) {
        return { error: `Invalid product item type for ${name}: ${itemType || "(empty)"}` };
      }

      const groupToken = trimString(row.raw.groupName);
      const group = groupToken ? await resolveProductGroupByToken(db, groupToken) : null;
      if (!group?.id) {
        if (!hasStagedToken(context?.staged?.productGroup, groupToken)) {
          return {
            error: `Product group not found for item ${name}: ${groupToken || "(empty)"}`,
          };
        }
      }

      const subgroupToken = trimString(row.raw.subgroupName);
      let subgroup = null;
      if (subgroupToken) {
        subgroup = await resolveProductSubgroupByToken(db, subgroupToken);
        if (!subgroup?.id) {
          if (!hasStagedToken(context?.staged?.productSubgroup, subgroupToken)) {
            return {
              error: `Product subgroup not found for item ${name}: ${subgroupToken}`,
            };
          }
        }
      }

      const productTypeToken = trimString(row.raw.productType);
      let productType = null;
      if (productTypeToken) {
        productType = await resolveProductTypeByToken(db, productTypeToken);
        if (!productType?.id) {
          if (!hasStagedToken(context?.staged?.productType, productTypeToken)) {
            return {
              error: `Product type not found for item ${name}: ${productTypeToken}`,
            };
          }
        }
      }

      const uomToken = trimString(row.raw.baseUom);
      const uom = await resolveUomByToken(db, uomToken);
      if (!uom?.id) {
        if (!hasStagedToken(context?.staged?.uom, uomToken)) {
          return {
            error: `Base UOM not found for item ${name}: ${uomToken || "(empty)"}`,
          };
        }
      }

      const code =
        trimString(row.raw.code) ||
        (await generateUniqueCode({ name, knex: db, table: "erp.items" }));
      let existingQuery = db("erp.items")
        .select("id")
        .whereRaw("lower(code) = ?", [code.toLowerCase()])
        .andWhere({ item_type: itemType });
      if (itemType === "RM") {
        existingQuery = existingQuery.orWhere((builder) => {
          builder
            .whereRaw("lower(name) = ?", [name.toLowerCase()])
            .andWhere({ item_type: "RM", group_id: group?.id || 0 });
        });
      } else {
        existingQuery = existingQuery.orWhere((builder) => {
          builder.whereRaw("lower(name) = ?", [name.toLowerCase()]).andWhere({ item_type: itemType });
        });
      }
      const existing = await existingQuery.first();

      const usesSfg = itemType === "FG" ? parseBoolean(row.raw.usesSfg, false) : false;
      const sfgPartTypeRaw = String(row.raw.sfgPartType || "")
        .trim()
        .toUpperCase();
      const sfgPartType = usesSfg && ["UPPER", "STEP"].includes(sfgPartTypeRaw)
        ? sfgPartTypeRaw
        : null;

      return {
        action: existing ? "update" : "create",
        data: {
          id: existing?.id || null,
          item_type: itemType,
          code,
          name,
          name_ur: trimString(row.raw.nameUr) || name,
          group_id: group?.id || null,
          group_token: groupToken || null,
          subgroup_id: subgroup?.id || null,
          subgroup_token: subgroupToken || null,
          product_type_id: productType?.id || null,
          product_type_token: productTypeToken || null,
          base_uom_id: uom?.id || null,
          base_uom_token: uomToken || null,
          uses_sfg: usesSfg,
          sfg_part_type: sfgPartType,
          min_stock_level: parseNumber(row.raw.minStockLevel, 0) || 0,
          is_active: parseBoolean(row.raw.isActive, true),
          updated_by: actorId,
        },
      };
    },
    async apply(op, trx, actorId) {
      let groupId = op.data.group_id;
      if (!groupId && op.data.group_token) {
        const group = await resolveProductGroupByToken(trx, op.data.group_token);
        groupId = group?.id || null;
      }
      if (!groupId) {
        throw new Error(
          `Product group not found while applying item import: ${
            op.data.group_token || "(empty)"
          }`,
        );
      }
      let subgroupId = op.data.subgroup_id;
      if (!subgroupId && op.data.subgroup_token) {
        const subgroup = await resolveProductSubgroupByToken(
          trx,
          op.data.subgroup_token,
        );
        subgroupId = subgroup?.id || null;
      }
      let productTypeId = op.data.product_type_id;
      if (!productTypeId && op.data.product_type_token) {
        const productType = await resolveProductTypeByToken(
          trx,
          op.data.product_type_token,
        );
        productTypeId = productType?.id || null;
      }
      let baseUomId = op.data.base_uom_id;
      if (!baseUomId && op.data.base_uom_token) {
        const uom = await resolveUomByToken(trx, op.data.base_uom_token);
        baseUomId = uom?.id || null;
      }
      if (!baseUomId) {
        throw new Error(
          `Base UOM not found while applying item import: ${
            op.data.base_uom_token || "(empty)"
          }`,
        );
      }
      const payload = {
        item_type: op.data.item_type,
        code: op.data.code,
        name: op.data.name,
        name_ur: op.data.name_ur,
        group_id: groupId,
        subgroup_id: subgroupId,
        product_type_id: productTypeId,
        base_uom_id: baseUomId,
        uses_sfg: op.data.uses_sfg,
        sfg_part_type: op.data.sfg_part_type,
        min_stock_level: op.data.min_stock_level,
        is_active: op.data.is_active,
        updated_by: actorId,
        updated_at: trx.fn.now(),
      };
      if (op.action === "create") {
        await trx("erp.items").insert({
          ...payload,
          created_by: actorId,
          created_at: trx.fn.now(),
        });
      } else {
        await trx("erp.items").where({ id: op.data.id }).update(payload);
      }
    },
  },
});

const planImportOperations = async ({ db, workbookRows, selectedTargetKeys, actorId }) => {
  const entityKeys = [
    ...new Set(
      selectedTargetKeys.flatMap((targetKey) => TARGET_GROUPS[targetKey].entityKeys),
    ),
  ];

  const entitySummaries = {};
  const errors = [];
  const warnings = [];
  const operations = [];
  const context = createPlanningContext();

  for (const entityKey of entityKeys) {
    const entitySpec = ENTITY_SPECS[entityKey];
    if (!entitySpec) continue;

    const sourceRows = extractEntityRows(workbookRows, entitySpec);
    const summary = makeEntitySummary(entityKey, sourceRows.length);
    entitySummaries[entityKey] = summary;

    if (!sourceRows.length) {
      warnings.push({
        entityKey,
        sheetName: "",
        rowNumber: 0,
        message: "No rows found for this target in the workbook.",
      });
      summary.warningCount += 1;
      continue;
    }

    for (const row of sourceRows) {
      try {
        const planned = await entitySpec.plan(row, db, actorId, context);
        if (planned?.skip) {
          summary.skipCount += 1;
          continue;
        }
        if (planned?.error) {
          summary.errorCount += 1;
          errors.push(makeRowError(entityKey, row, planned.error));
          continue;
        }
        if (!planned?.action || !planned?.data) {
          summary.errorCount += 1;
          errors.push(
            makeRowError(
              entityKey,
              row,
              "Unable to plan this row due to invalid configuration.",
            ),
          );
          continue;
        }
        summary.rowsPlanned += 1;
        if (planned.action === "create") summary.createCount += 1;
        if (planned.action === "update") summary.updateCount += 1;
        if (planned.warning) {
          summary.warningCount += 1;
          warnings.push(makeRowError(entityKey, row, planned.warning));
        }
        operations.push({
          entityKey,
          row,
          action: planned.action,
          data: planned.data,
        });
        registerStagedReference(context, {
          entityKey,
          action: planned.action,
          data: planned.data,
        });
      } catch (err) {
        summary.errorCount += 1;
        errors.push(
          makeRowError(
            entityKey,
            row,
            err?.message || "Unexpected error while validating this row.",
          ),
        );
      }
    }
  }

  const orderedSummaries = Object.values(entitySummaries);
  const summary = {
    entitiesPlanned: orderedSummaries.filter((entry) => entry.rowsPlanned > 0).length,
    rowsRead: orderedSummaries.reduce((sum, entry) => sum + entry.rowsTotal, 0),
    rowsPlanned: orderedSummaries.reduce((sum, entry) => sum + entry.rowsPlanned, 0),
    createCount: orderedSummaries.reduce((sum, entry) => sum + entry.createCount, 0),
    updateCount: orderedSummaries.reduce((sum, entry) => sum + entry.updateCount, 0),
    skipCount: orderedSummaries.reduce((sum, entry) => sum + entry.skipCount, 0),
    errorCount: errors.length,
    warningCount: warnings.length,
  };

  return {
    summary,
    entitySummaries: orderedSummaries,
    errors,
    warnings,
    operations,
  };
};

const analyzeWorkbookImport = async ({ db, workbookBuffer, selectedTargets, actorId }) => {
  const selectedTargetKeys = resolveSelectedTargetKeys(selectedTargets);
  const workbookRows = buildWorkbookRows(workbookBuffer);

  const plan = await planImportOperations({
    db,
    workbookRows,
    selectedTargetKeys,
    actorId,
  });

  return {
    selectedTargetKeys,
    supportedTargets: SUPPORTED_IMPORT_TARGETS,
    ...plan,
  };
};

const applyWorkbookImport = async ({
  db,
  workbookBuffer,
  selectedTargets,
  actorId,
  branchId,
  ipAddress,
}) => {
  const analysis = await analyzeWorkbookImport({
    db,
    workbookBuffer,
    selectedTargets,
    actorId,
  });

  if (analysis.summary.errorCount > 0) {
    const error = new Error("Import validation failed.");
    error.code = "IMPORT_VALIDATION_FAILED";
    error.analysis = analysis;
    throw error;
  }

  await db.transaction(async (trx) => {
    for (const operation of analysis.operations) {
      const entitySpec = ENTITY_SPECS[operation.entityKey];
      if (!entitySpec || typeof entitySpec.apply !== "function") continue;
      await entitySpec.apply(operation, trx, actorId);
    }

    await insertActivityLog(trx, {
      branch_id: branchId || null,
      user_id: actorId || null,
      entity_type: "MASTER_DATA_IMPORT",
      entity_id: String(Date.now()),
      action: "CREATE",
      ip_address: ipAddress || null,
      context: {
        selected_targets: analysis.selectedTargetKeys,
        summary: analysis.summary,
      },
    });
  });

  return analysis;
};

module.exports = {
  SUPPORTED_IMPORT_TARGETS,
  analyzeWorkbookImport,
  applyWorkbookImport,
  resolveSelectedTargetKeys,
};
