const knexConfig = require("../../../knexfile").development;
const knex = require("knex")(knexConfig);

const getLinkedSize = async () => {
  const row = await knex("erp.variants as v")
    .join("erp.sizes as s", "s.id", "v.size_id")
    .select("s.id", "s.name")
    .whereNotNull("v.size_id")
    .first();
  return row || null;
};

const closeDb = async () => knex.destroy();

module.exports = { getLinkedSize, closeDb };
