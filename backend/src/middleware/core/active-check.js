// Reusable middleware to block access to inactive entities
// Usage: activeCheck({ table: 'erp.branches', idParam: 'id', idColumn: 'id', activeColumn: 'is_active' })
const knex = require("../../db/knex");
const { HttpError } = require("../errors/http-error");

function activeCheck({ table, idParam = "id", idColumn = "id", activeColumn = "is_active" }) {
  return async function (req, res, next) {
    const entityId = req.params[idParam] || req.body[idParam] || req.query[idParam];
    if (!entityId) return next(new HttpError(400, `Missing ${idParam}`));
    const entity = await knex(table)
      .where({ [idColumn]: entityId })
      .first();
    if (!entity) return next(new HttpError(404, `${table} not found`));
    if (entity[activeColumn] === false || entity[activeColumn] === 0) {
      return next(new HttpError(403, `${table} is inactive`));
    }
    next();
  };
}

module.exports = activeCheck;
