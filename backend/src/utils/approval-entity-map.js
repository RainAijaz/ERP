// approval-entity-map.js
// Purpose: Maps logical entity types (used in approval flows) to their canonical string keys and DB types.
// Used by the approval engine and UI to resolve entity types for basic info and screen-level entities.
//
// Exports:
// - BASIC_INFO_ENTITY_TYPES: Maps basic info route keys to entity type strings.
// - SCREEN_ENTITY_TYPES: Maps screen keys to entity type strings.
// - getBasicInfoEntityType: Helper to resolve a type string from a route key.

const BASIC_INFO_ENTITY_TYPES = {
  units: "UOM",
  sizes: "SIZE",
  colors: "COLOR",
  grades: "GRADE",
  "packing-types": "PACKING_TYPE",
  cities: "CITY",
  groups: "PRODUCT_GROUP",
  "product-subgroups": "PRODUCT_SUBGROUP",
  "product-types": "PRODUCT_TYPE",
  "party-groups": "PARTY_GROUP",
  "account-groups": "ACCOUNT_GROUP",
  departments: "DEPARTMENT",
  "uom-conversions": "UOM_CONVERSION",
};

const SCREEN_ENTITY_TYPES = {
  "master_data.accounts": "ACCOUNT",
  "master_data.parties": "PARTY",
  "master_data.products.raw_materials": "ITEM",
  "master_data.products.semi_finished": "ITEM",
  "master_data.products.finished": "ITEM",
  "master_data.products.skus": "SKU",
  "master_data.bom": "BOM",
};

const getBasicInfoEntityType = (type) => BASIC_INFO_ENTITY_TYPES[type] || "GENERIC";

module.exports = {
  BASIC_INFO_ENTITY_TYPES,
  SCREEN_ENTITY_TYPES,
  getBasicInfoEntityType,
};
