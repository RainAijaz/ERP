exports.up = async (knex) => {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION erp.assert_item_is_rm(p_item_id bigint)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE v_type erp.item_type;
    BEGIN
      IF p_item_id IS NULL THEN
        RAISE EXCEPTION 'item_id cannot be NULL'
          USING ERRCODE = '23502';
      END IF;

      SELECT i.item_type
        INTO v_type
      FROM erp.items i
      WHERE i.id = p_item_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid item_id=%. Item not found.', p_item_id
          USING ERRCODE = '23503';
      END IF;

      IF v_type NOT IN ('RM', 'SFG') THEN
        RAISE EXCEPTION 'Invalid item_id=%. Expected item_type=RM or SFG, got %.', p_item_id, v_type
          USING ERRCODE = '22000';
      END IF;
    END;
    $$;
  `);
};

exports.down = async (knex) => {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION erp.assert_item_is_rm(p_item_id bigint)
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    DECLARE v_type erp.item_type;
    BEGIN
      IF p_item_id IS NULL THEN
        RAISE EXCEPTION 'item_id cannot be NULL'
          USING ERRCODE = '23502';
      END IF;

      SELECT i.item_type
        INTO v_type
      FROM erp.items i
      WHERE i.id = p_item_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Invalid item_id=%. Item not found.', p_item_id
          USING ERRCODE = '23503';
      END IF;

      IF v_type <> 'RM' THEN
        RAISE EXCEPTION 'Invalid item_id=%. Expected item_type=RM, got %.', p_item_id, v_type
          USING ERRCODE = '22000';
      END IF;
    END;
    $$;
  `);
};
