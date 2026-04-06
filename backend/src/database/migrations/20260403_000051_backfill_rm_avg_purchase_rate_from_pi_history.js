exports.up = async function up(knex) {
  await knex.raw(`
    DO $$
    DECLARE
      has_rm_rates boolean := to_regclass('erp.rm_purchase_rates') IS NOT NULL;
      has_stock_ledger boolean := to_regclass('erp.stock_ledger') IS NOT NULL;
      has_voucher_header boolean := to_regclass('erp.voucher_header') IS NOT NULL;
      has_color boolean := false;
      has_size boolean := false;
    BEGIN
      IF NOT has_rm_rates OR NOT has_stock_ledger OR NOT has_voucher_header THEN
        RETURN;
      END IF;

      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'erp'
          AND table_name = 'stock_ledger'
          AND column_name = 'color_id'
      ) INTO has_color;

      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'erp'
          AND table_name = 'stock_ledger'
          AND column_name = 'size_id'
      ) INTO has_size;

      IF has_color AND has_size THEN
        WITH pi_history AS (
          SELECT
            sl.item_id AS rm_item_id,
            COALESCE(sl.color_id, 0) AS color_key,
            COALESCE(sl.size_id, 0) AS size_key,
            CASE
              WHEN SUM(sl.qty) > 0 THEN ROUND(SUM(sl.qty * sl.unit_cost) / SUM(sl.qty), 4)
              ELSE NULL
            END AS weighted_avg_rate
          FROM erp.stock_ledger sl
          JOIN erp.voucher_header vh
            ON vh.id = sl.voucher_header_id
          WHERE sl.category = 'RM'
            AND sl.stock_state = 'ON_HAND'
            AND sl.direction = 1
            AND vh.voucher_type_code = 'PI'
            AND vh.status = 'APPROVED'
          GROUP BY
            sl.item_id,
            COALESCE(sl.color_id, 0),
            COALESCE(sl.size_id, 0)
        )
        UPDATE erp.rm_purchase_rates r
        SET avg_purchase_rate = COALESCE(h.weighted_avg_rate, r.purchase_rate)
        FROM pi_history h
        WHERE r.is_active = true
          AND r.rm_item_id = h.rm_item_id
          AND COALESCE(r.color_id, 0) = h.color_key
          AND COALESCE(r.size_id, 0) = h.size_key;

        WITH pi_history AS (
          SELECT
            sl.item_id AS rm_item_id,
            COALESCE(sl.color_id, 0) AS color_key,
            COALESCE(sl.size_id, 0) AS size_key
          FROM erp.stock_ledger sl
          JOIN erp.voucher_header vh
            ON vh.id = sl.voucher_header_id
          WHERE sl.category = 'RM'
            AND sl.stock_state = 'ON_HAND'
            AND sl.direction = 1
            AND vh.voucher_type_code = 'PI'
            AND vh.status = 'APPROVED'
          GROUP BY
            sl.item_id,
            COALESCE(sl.color_id, 0),
            COALESCE(sl.size_id, 0)
        )
        UPDATE erp.rm_purchase_rates r
        SET avg_purchase_rate = r.purchase_rate
        WHERE r.is_active = true
          AND NOT EXISTS (
            SELECT 1
            FROM pi_history h
            WHERE h.rm_item_id = r.rm_item_id
              AND h.color_key = COALESCE(r.color_id, 0)
              AND h.size_key = COALESCE(r.size_id, 0)
          );
      ELSE
        WITH pi_history AS (
          SELECT
            sl.item_id AS rm_item_id,
            CASE
              WHEN SUM(sl.qty) > 0 THEN ROUND(SUM(sl.qty * sl.unit_cost) / SUM(sl.qty), 4)
              ELSE NULL
            END AS weighted_avg_rate
          FROM erp.stock_ledger sl
          JOIN erp.voucher_header vh
            ON vh.id = sl.voucher_header_id
          WHERE sl.category = 'RM'
            AND sl.stock_state = 'ON_HAND'
            AND sl.direction = 1
            AND vh.voucher_type_code = 'PI'
            AND vh.status = 'APPROVED'
          GROUP BY sl.item_id
        )
        UPDATE erp.rm_purchase_rates r
        SET avg_purchase_rate = COALESCE(h.weighted_avg_rate, r.purchase_rate)
        FROM pi_history h
        WHERE r.is_active = true
          AND r.rm_item_id = h.rm_item_id
          AND COALESCE(r.color_id, 0) = 0
          AND COALESCE(r.size_id, 0) = 0;

        WITH pi_history AS (
          SELECT sl.item_id AS rm_item_id
          FROM erp.stock_ledger sl
          JOIN erp.voucher_header vh
            ON vh.id = sl.voucher_header_id
          WHERE sl.category = 'RM'
            AND sl.stock_state = 'ON_HAND'
            AND sl.direction = 1
            AND vh.voucher_type_code = 'PI'
            AND vh.status = 'APPROVED'
          GROUP BY sl.item_id
        )
        UPDATE erp.rm_purchase_rates r
        SET avg_purchase_rate = r.purchase_rate
        WHERE r.is_active = true
          AND COALESCE(r.color_id, 0) = 0
          AND COALESCE(r.size_id, 0) = 0
          AND NOT EXISTS (
            SELECT 1
            FROM pi_history h
            WHERE h.rm_item_id = r.rm_item_id
          );
      END IF;

      UPDATE erp.rm_purchase_rates r
      SET avg_purchase_rate = r.purchase_rate
      WHERE r.is_active = true
        AND (r.avg_purchase_rate IS NULL OR r.avg_purchase_rate < 0);
    END $$;
  `);
};

exports.down = async function down() {
  // Historical backfill only; no safe automatic rollback for computed averages.
};
