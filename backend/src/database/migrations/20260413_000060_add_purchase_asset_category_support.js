const PURCHASE_CATEGORY_CHECK = "('RAW_MATERIAL','ASSET')";

const PURCHASE_CATEGORY_TABLES = [
  {
    table: "purchase_grn_header_ext",
    constraint: "purchase_grn_hdr_purchase_category_chk",
  },
  {
    table: "purchase_invoice_header_ext",
    constraint: "purchase_invoice_hdr_purchase_category_chk",
  },
  {
    table: "purchase_return_header_ext",
    constraint: "purchase_return_hdr_purchase_category_chk",
  },
];

const ensurePurchaseCategoryColumn = async (knex, { table, constraint }) => {
  const hasTable = await knex.schema.withSchema("erp").hasTable(table);
  if (!hasTable) return;

  const hasColumn = await knex.schema.withSchema("erp").hasColumn(table, "purchase_category");
  if (!hasColumn) {
    await knex.schema.withSchema("erp").alterTable(table, (t) => {
      t.string("purchase_category", 32).notNullable().defaultTo("RAW_MATERIAL");
    });
  }

  await knex.raw(
    `
    UPDATE erp.${table}
    SET purchase_category = CASE
      WHEN upper(trim(coalesce(purchase_category, ''))) = 'ASSET' THEN 'ASSET'
      ELSE 'RAW_MATERIAL'
    END
    `,
  );
  await knex.raw("SET CONSTRAINTS ALL IMMEDIATE");
  await knex.raw(`
    ALTER TABLE erp.${table}
      ALTER COLUMN purchase_category SET DEFAULT 'RAW_MATERIAL'
  `);
  await knex.raw(`
    ALTER TABLE erp.${table}
      ALTER COLUMN purchase_category SET NOT NULL
  `);
  await knex.raw(
    `
    DO $$
    BEGIN
      IF to_regclass('erp.${table}') IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conrelid = 'erp.${table}'::regclass
             AND contype = 'c'
             AND (
               conname = '${constraint}'
               OR pg_get_constraintdef(oid) ILIKE '%purchase_category%'
             )
         ) THEN
        ALTER TABLE erp.${table}
          ADD CONSTRAINT ${constraint}
          CHECK (purchase_category IN ${PURCHASE_CATEGORY_CHECK});
      END IF;
    END
    $$;
    `,
  );
};

const ensureFixedAssetsPostingSetup = async (knex) => {
  await knex.raw(`
    INSERT INTO erp.account_groups (account_type, code, name, is_active)
    SELECT 'ASSET', 'fixed_assets', 'Fixed Assets', true
    WHERE NOT EXISTS (
      SELECT 1
      FROM erp.account_groups
      WHERE account_type = 'ASSET'
        AND lower(coalesce(code, '')) = 'fixed_assets'
    )
  `);

  await knex.raw(`
    UPDATE erp.account_groups
    SET is_active = true,
        name = COALESCE(NULLIF(name, ''), 'Fixed Assets')
    WHERE account_type = 'ASSET'
      AND lower(coalesce(code, '')) = 'fixed_assets'
  `);

  await knex.raw(`
    WITH target_group AS (
      SELECT id
      FROM erp.account_groups
      WHERE account_type = 'ASSET'
        AND lower(coalesce(code, '')) = 'fixed_assets'
      ORDER BY id ASC
      LIMIT 1
    )
    INSERT INTO erp.accounts (code, name, subgroup_id, is_active, lock_posting)
    SELECT 'gl_fixed_assets_control', 'GL Fixed Assets Control', tg.id, true, true
    FROM target_group tg
    ON CONFLICT (code) DO UPDATE SET
      name = EXCLUDED.name,
      subgroup_id = EXCLUDED.subgroup_id,
      is_active = true,
      lock_posting = true
  `);

  await knex.raw(`
    INSERT INTO erp.account_branch (account_id, branch_id)
    SELECT a.id, b.id
    FROM erp.accounts a
    CROSS JOIN erp.branches b
    WHERE a.code = 'gl_fixed_assets_control'
    ON CONFLICT (account_id, branch_id) DO NOTHING
  `);
};

const updatePurchaseIntegrityFunctions = async (knex) => {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION erp.trg_purchase_grn_header_ext_validate()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      PERFORM erp.assert_voucher_type_code(NEW.voucher_id, 'GRN');
      RETURN NEW;
    END;
    $fn$;
  `);

  await knex.raw(`
    DO $do$
    BEGIN
      IF to_regclass('erp.purchase_grn_header_ext') IS NOT NULL THEN
        EXECUTE 'DROP TRIGGER IF EXISTS trg_purchase_grn_header_ext_validate ON erp.purchase_grn_header_ext';
        EXECUTE 'CREATE TRIGGER trg_purchase_grn_header_ext_validate
                 BEFORE INSERT OR UPDATE ON erp.purchase_grn_header_ext
                 FOR EACH ROW EXECUTE FUNCTION erp.trg_purchase_grn_header_ext_validate()';
      END IF;
    END
    $do$;
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION erp.trg_purchase_lines_require_rm_item()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_vt text;
      v_category text := 'RAW_MATERIAL';
    BEGIN
      SELECT vh.voucher_type_code INTO v_vt
      FROM erp.voucher_header vh
      WHERE vh.id = NEW.voucher_header_id;

      IF v_vt IN ('PO','PI','PR','GRN') THEN
        IF v_vt = 'PI' THEN
          BEGIN
            SELECT ph.purchase_category INTO v_category
            FROM erp.purchase_invoice_header_ext ph
            WHERE ph.voucher_id = NEW.voucher_header_id;
          EXCEPTION WHEN undefined_column OR undefined_table THEN
            v_category := 'RAW_MATERIAL';
          END;
        ELSIF v_vt = 'PR' THEN
          BEGIN
            SELECT ph.purchase_category INTO v_category
            FROM erp.purchase_return_header_ext ph
            WHERE ph.voucher_id = NEW.voucher_header_id;
          EXCEPTION WHEN undefined_column OR undefined_table THEN
            v_category := 'RAW_MATERIAL';
          END;
        ELSIF v_vt = 'GRN' THEN
          BEGIN
            SELECT gh.purchase_category INTO v_category
            FROM erp.purchase_grn_header_ext gh
            WHERE gh.voucher_id = NEW.voucher_header_id;
          EXCEPTION WHEN undefined_column OR undefined_table THEN
            v_category := 'RAW_MATERIAL';
          END;
        ELSE
          v_category := 'RAW_MATERIAL';
        END IF;

        IF v_vt IN ('PI','PR','GRN') AND NEW.line_kind = 'ACCOUNT' THEN
          v_category := 'ASSET';
        END IF;
        v_category := upper(coalesce(v_category, 'RAW_MATERIAL'));

        IF v_category = 'ASSET' THEN
          IF NEW.line_kind <> 'ACCOUNT' THEN
            RAISE EXCEPTION 'Voucher % (%): only ACCOUNT lines allowed for ASSET purchase category.', NEW.voucher_header_id, v_vt;
          END IF;

          IF NEW.account_id IS NULL THEN
            RAISE EXCEPTION 'Voucher % (%): account_id is required for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
          END IF;

          IF NEW.item_id IS NOT NULL THEN
            RAISE EXCEPTION 'Voucher % (%): item_id must be NULL for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
          END IF;

          IF COALESCE(NEW.meta->>'asset_id', '') !~ '^[0-9]+$' THEN
            RAISE EXCEPTION 'Voucher % (%): asset_id is required in voucher_line.meta for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
          END IF;

          PERFORM 1
          FROM erp.accounts a
          JOIN erp.account_groups ag ON ag.id = a.subgroup_id
          WHERE a.id = NEW.account_id
            AND lower(coalesce(ag.code, '')) = 'fixed_assets';
          IF NOT FOUND THEN
            RAISE EXCEPTION 'Voucher % (%): account_id % must belong to fixed_assets group for ASSET purchase lines.',
              NEW.voucher_header_id, v_vt, NEW.account_id;
          END IF;

          IF NEW.qty <= 0 THEN
            RAISE EXCEPTION 'Voucher % (%): qty must be > 0 for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
          END IF;
          IF v_vt <> 'GRN' AND COALESCE(NEW.rate, 0) <= 0 THEN
            RAISE EXCEPTION 'Voucher % (%): rate must be > 0 for ASSET purchase lines.', NEW.voucher_header_id, v_vt;
          END IF;
          RETURN NEW;
        END IF;

        IF NEW.line_kind <> 'ITEM' THEN
          RAISE EXCEPTION 'Voucher % (%): only ITEM lines allowed for purchase vouchers.', NEW.voucher_header_id, v_vt;
        END IF;

        IF NEW.item_id IS NULL THEN
          RAISE EXCEPTION 'Voucher % (%): item_id is required on purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;

        PERFORM erp.assert_item_is_rm(NEW.item_id);

        IF NEW.qty <= 0 THEN
          RAISE EXCEPTION 'Voucher % (%): qty must be > 0 for purchase lines.', NEW.voucher_header_id, v_vt;
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$;
  `);

  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_purchase_lines_require_rm_item ON erp.voucher_line;
    CREATE TRIGGER trg_purchase_lines_require_rm_item
    BEFORE INSERT OR UPDATE ON erp.voucher_line
    FOR EACH ROW
    EXECUTE FUNCTION erp.trg_purchase_lines_require_rm_item();
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION erp.enforce_po_requirement_for_purchase_invoice(p_pi_voucher_id bigint)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_supplier   bigint;
      v_total      numeric(18,2);
      v_has_po     boolean;
      v_purchase_category text := 'RAW_MATERIAL';
      v_has_purchase_category_col boolean;
      v_policy_hit boolean;
      v_has_group_col boolean;
      v_group_col_name text;
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM erp.voucher_header vh
        WHERE vh.id = p_pi_voucher_id AND vh.voucher_type_code = 'PI'
      ) THEN
        RETURN;
      END IF;

      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='erp'
          AND table_name='purchase_invoice_header_ext'
          AND column_name='purchase_category'
      ) INTO v_has_purchase_category_col;

      IF v_has_purchase_category_col THEN
        SELECT ph.supplier_party_id,
               (ph.po_voucher_id IS NOT NULL),
               upper(coalesce(ph.purchase_category, 'RAW_MATERIAL'))
          INTO v_supplier, v_has_po, v_purchase_category
        FROM erp.purchase_invoice_header_ext ph
        WHERE ph.voucher_id = p_pi_voucher_id;
      ELSE
        SELECT ph.supplier_party_id, (ph.po_voucher_id IS NOT NULL)
          INTO v_supplier, v_has_po
        FROM erp.purchase_invoice_header_ext ph
        WHERE ph.voucher_id = p_pi_voucher_id;
      END IF;

      IF v_supplier IS NULL THEN
        RETURN;
      END IF;

      IF v_purchase_category = 'ASSET' THEN
        RETURN;
      END IF;

      SELECT COALESCE(SUM(vl.amount),0)::numeric(18,2)
        INTO v_total
      FROM erp.voucher_line vl
      WHERE vl.voucher_header_id = p_pi_voucher_id;

      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='erp' AND table_name='items' AND column_name='group_id'
      ) THEN
        v_group_col_name := 'group_id';
      ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='erp' AND table_name='items' AND column_name='product_group_id'
      ) THEN
        v_group_col_name := 'product_group_id';
      ELSE
        v_group_col_name := NULL;
      END IF;

      IF v_group_col_name IS NULL THEN
        SELECT EXISTS (
          SELECT 1
          FROM erp.purchase_order_requirement_rule r
          WHERE r.is_active = true
            AND (r.min_amount IS NULL OR v_total > r.min_amount)
            AND (r.supplier_party_id IS NULL OR r.supplier_party_id = v_supplier)
            AND (
              r.rm_item_id IS NULL
              OR EXISTS (
                SELECT 1
                FROM erp.voucher_line vl
                WHERE vl.voucher_header_id = p_pi_voucher_id
                  AND vl.item_id = r.rm_item_id
              )
            )
            AND (r.rm_group_id IS NULL)
        ) INTO v_policy_hit;
      ELSE
        EXECUTE format($f$
          SELECT EXISTS (
            SELECT 1
            FROM erp.purchase_order_requirement_rule r
            WHERE r.is_active = true
              AND (r.min_amount IS NULL OR $1 > r.min_amount)
              AND (r.supplier_party_id IS NULL OR r.supplier_party_id = $2)
              AND (
                r.rm_item_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM erp.voucher_line vl
                  WHERE vl.voucher_header_id = $3
                    AND vl.item_id = r.rm_item_id
                )
              )
              AND (
                r.rm_group_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM erp.voucher_line vl
                  JOIN erp.items it ON it.id = vl.item_id
                  WHERE vl.voucher_header_id = $3
                    AND it.%I = r.rm_group_id
                )
              )
          )
        $f$, v_group_col_name)
        INTO v_policy_hit
        USING v_total, v_supplier, p_pi_voucher_id;
      END IF;

      IF v_policy_hit AND NOT v_has_po THEN
        RAISE EXCEPTION
          'PO is required by purchase policy for PI voucher % (total=%) but po_voucher_id is NULL.',
          p_pi_voucher_id, v_total;
      END IF;
    END;
    $$;
  `);
};

exports.up = async function up(knex) {
  for (const tableConfig of PURCHASE_CATEGORY_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    await ensurePurchaseCategoryColumn(knex, tableConfig);
  }
  await ensureFixedAssetsPostingSetup(knex);
  await updatePurchaseIntegrityFunctions(knex);
};

exports.down = async function down() {
  // Deliberately no-op to avoid destructive rollback on accounting schema/state.
};
