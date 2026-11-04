'use strict';

// Shared, deterministic serialization for reviewed-state and idempotency hashes.
const canonicalJson = value => JSON.stringify(value, (_key, item) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]]));
  }
  return item;
});
module.exports = { canonicalJson };
