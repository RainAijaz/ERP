const { navConfig } = require("../../utils/nav-config");
const {
  BASIC_INFO_ENTITY_TYPES,
  SCREEN_ENTITY_TYPES,
} = require("../../utils/approval-entity-map");

const DASHBOARD_AUDIT_SCOPE = {
  scopeType: "SCREEN",
  scopeKey: "administration.audit_logs",
};

const ADMIN_ENTITY_SCOPE_MAP = {
  BRANCH: [{ scopeType: "SCREEN", scopeKey: "administration.branches" }],
  USER: [{ scopeType: "SCREEN", scopeKey: "administration.users" }],
  ROLE: [{ scopeType: "SCREEN", scopeKey: "administration.roles" }],
  PERMISSION: [{ scopeType: "SCREEN", scopeKey: "administration.permissions" }],
  ACCOUNT: [
    { scopeType: "SCREEN", scopeKey: "master_data.accounts" },
    { scopeType: "SCREEN", scopeKey: "administration.permissions" },
  ],
};

const getCan = (canFn, scopeType, scopeKey, action) => {
  if (typeof canFn !== "function") return false;
  try {
    return Boolean(canFn(scopeType, scopeKey, action));
  } catch (_err) {
    return false;
  }
};

const collectScopeKeysByType = (nodes, targetScopeType, out = new Set()) => {
  if (!Array.isArray(nodes)) return out;
  nodes.forEach((node) => {
    if (!node || typeof node !== "object") return;
    if (node.scopeType === targetScopeType && node.scopeKey) {
      out.add(String(node.scopeKey));
    }
    if (Array.isArray(node.children) && node.children.length) {
      collectScopeKeysByType(node.children, targetScopeType, out);
    }
  });
  return out;
};

const VOUCHER_SCOPE_KEYS = Array.from(
  collectScopeKeysByType(navConfig, "VOUCHER"),
);

const ENTITY_SCOPE_MAP = new Map();

const registerEntityScope = (entityType, scopeType, scopeKey) => {
  const entity = String(entityType || "")
    .trim()
    .toUpperCase();
  if (!entity || !scopeType || !scopeKey) return;
  const existing = ENTITY_SCOPE_MAP.get(entity) || [];
  if (
    existing.some(
      (entry) =>
        entry.scopeType === scopeType &&
        String(entry.scopeKey || "") === String(scopeKey),
    )
  ) {
    return;
  }
  existing.push({ scopeType, scopeKey: String(scopeKey) });
  ENTITY_SCOPE_MAP.set(entity, existing);
};

Object.entries(SCREEN_ENTITY_TYPES).forEach(([scopeKey, entityType]) => {
  registerEntityScope(entityType, "SCREEN", scopeKey);
});

Object.entries(BASIC_INFO_ENTITY_TYPES).forEach(
  ([basicInfoKey, entityType]) => {
    registerEntityScope(
      entityType,
      "SCREEN",
      `master_data.basic_info.${String(basicInfoKey).replace(/-/g, "_")}`,
    );
  },
);

Object.entries(ADMIN_ENTITY_SCOPE_MAP).forEach(([entityType, scopes]) => {
  scopes.forEach((scope) => {
    registerEntityScope(entityType, scope.scopeType, scope.scopeKey);
  });
});

const buildActivityAccessScope = ({ can, user }) => {
  const isAdmin = Boolean(user?.isAdmin);
  if (isAdmin) {
    return {
      isAdmin: true,
      canViewAuditLogs: true,
      enforceOwnOnly: false,
      allowedEntityTypes: null,
      allowedVoucherTypeCodes: null,
    };
  }

  const canViewAuditLogs = getCan(
    can,
    DASHBOARD_AUDIT_SCOPE.scopeType,
    DASHBOARD_AUDIT_SCOPE.scopeKey,
    "view",
  );

  if (!canViewAuditLogs) {
    return {
      isAdmin: false,
      canViewAuditLogs: false,
      enforceOwnOnly: true,
      allowedEntityTypes: [],
      allowedVoucherTypeCodes: [],
    };
  }

  const allowedEntityTypes = Array.from(ENTITY_SCOPE_MAP.entries())
    .filter(([, scopes]) =>
      scopes.some((scope) =>
        getCan(can, scope.scopeType, scope.scopeKey, "navigate"),
      ),
    )
    .map(([entityType]) => entityType);

  const allowedVoucherTypeCodes = VOUCHER_SCOPE_KEYS.filter((scopeKey) =>
    getCan(can, "VOUCHER", scopeKey, "navigate"),
  ).map((scopeKey) => String(scopeKey || "").toUpperCase());

  return {
    isAdmin: false,
    canViewAuditLogs: true,
    enforceOwnOnly: false,
    allowedEntityTypes,
    allowedVoucherTypeCodes,
  };
};

const applyActivityAccessScope = ({
  qb,
  access,
  userId,
  tableAlias = "al",
}) => {
  if (!qb || typeof qb.where !== "function") return qb;
  if (!access || access.isAdmin) return qb;

  const normalizedUserId = Number(userId || 0);
  const entityColumn = tableAlias ? `${tableAlias}.entity_type` : "entity_type";
  const userColumn = tableAlias ? `${tableAlias}.user_id` : "user_id";
  const voucherTypeColumn = tableAlias
    ? `${tableAlias}.voucher_type_code`
    : "voucher_type_code";

  if (access.enforceOwnOnly) {
    if (normalizedUserId > 0) {
      qb.where(userColumn, normalizedUserId);
    } else {
      qb.whereRaw("1=0");
    }
    return qb;
  }

  const nonVoucherEntityTypes = Array.from(
    new Set(
      (access.allowedEntityTypes || [])
        .map((entry) =>
          String(entry || "")
            .trim()
            .toUpperCase(),
        )
        .filter((entry) => entry && entry !== "VOUCHER"),
    ),
  );

  const allowedVoucherTypeCodes = Array.from(
    new Set(
      (access.allowedVoucherTypeCodes || [])
        .map((entry) =>
          String(entry || "")
            .trim()
            .toUpperCase(),
        )
        .filter(Boolean),
    ),
  );

  if (!nonVoucherEntityTypes.length && !allowedVoucherTypeCodes.length) {
    qb.whereRaw("1=0");
    return qb;
  }

  qb.where((visibility) => {
    let hasClause = false;

    if (nonVoucherEntityTypes.length) {
      visibility.whereIn(entityColumn, nonVoucherEntityTypes);
      hasClause = true;
    }

    if (allowedVoucherTypeCodes.length) {
      const voucherClause = (sub) =>
        sub
          .where(entityColumn, "VOUCHER")
          .whereIn(voucherTypeColumn, allowedVoucherTypeCodes);
      if (hasClause) {
        visibility.orWhere(voucherClause);
      } else {
        visibility.where(voucherClause);
      }
    }
  });

  return qb;
};

const filterEntityTypeRowsByAccess = ({ rows, access }) => {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (!access || access.isAdmin) return sourceRows;
  if (access.enforceOwnOnly) return [];

  const allowed = new Set(
    (access.allowedEntityTypes || [])
      .map((entry) =>
        String(entry || "")
          .trim()
          .toUpperCase(),
      )
      .filter(Boolean),
  );

  if ((access.allowedVoucherTypeCodes || []).length) {
    allowed.add("VOUCHER");
  }

  if (!allowed.size) return [];

  return sourceRows.filter((row) =>
    allowed.has(
      String(row?.code || "")
        .trim()
        .toUpperCase(),
    ),
  );
};

module.exports = {
  buildActivityAccessScope,
  applyActivityAccessScope,
  filterEntityTypeRowsByAccess,
};
