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
