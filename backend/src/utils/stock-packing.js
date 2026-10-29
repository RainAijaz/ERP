const FG_PACKED_FLAG_SQL = `
CASE
  WHEN sl.is_packed IS NOT NULL THEN sl.is_packed
  WHEN sln.is_packed IS NOT NULL THEN sln.is_packed
  WHEN pl.is_packed IS NOT NULL THEN pl.is_packed
  WHEN upper(trim(coalesce(vl.meta->>'status', vl.meta->>'row_status', ''))) = 'PACKED' THEN true
  WHEN upper(trim(coalesce(vl.meta->>'status', vl.meta->>'row_status', ''))) = 'LOOSE' THEN false
  WHEN lower(trim(coalesce(vl.meta->>'is_packed', ''))) IN ('true','t','1','yes') THEN true
  WHEN lower(trim(coalesce(vl.meta->>'is_packed', ''))) IN ('false','f','0','no') THEN false
  ELSE false
END`;

module.exports = { FG_PACKED_FLAG_SQL };
