-- Reassign Starlink Mini Kit inventory rows that were accidentally placed under
-- "Starlink Standard Kit v4".
--
-- Run in Supabase Dashboard -> SQL Editor.
-- Mini kit serials are identified by the KIT4M prefix, e.g. KIT4M03850911C2Z.
-- Standard kit serials keep the KIT4 prefix without M, e.g. KIT40527425555K.

-- 1) Dry run: check what will move before running the transaction below.
SELECT
  pl.product_name AS current_group,
  count(*)::bigint AS mini_kits_to_move
FROM public.inventory_items i
JOIN public.product_lines pl ON pl.id = i.product_id
WHERE lower(btrim(pl.product_name)) = lower('Starlink Standard Kit v4')
  AND upper(btrim(i.serial_number)) LIKE 'KIT4M%'
GROUP BY pl.product_name;

-- 2) Apply fix.
BEGIN;

CREATE TEMP TABLE _starlink_mini_kit_reassign (
  id text PRIMARY KEY,
  serial_number text NOT NULL,
  old_product_id text NOT NULL,
  new_product_id text NOT NULL
) ON COMMIT DROP;

DO $$
DECLARE
  v_standard_id text;
  v_mini_id text;
  v_updated integer;
BEGIN
  SELECT id
  INTO v_standard_id
  FROM public.product_lines
  WHERE lower(btrim(product_name)) = lower('Starlink Standard Kit v4')
  LIMIT 1;

  IF v_standard_id IS NULL THEN
    RAISE EXCEPTION 'Source product group not found: %', 'Starlink Standard Kit v4';
  END IF;

  INSERT INTO public.product_lines (id, product_name, vendor)
  VALUES (
    'PL-' || md5('starlink mini kit|Starlink'),
    'Starlink Mini Kit',
    'Starlink'
  )
  ON CONFLICT DO NOTHING;

  UPDATE public.product_lines
  SET vendor = 'Starlink'
  WHERE lower(btrim(product_name)) = lower('Starlink Mini Kit');

  SELECT id
  INTO v_mini_id
  FROM public.product_lines
  WHERE lower(btrim(product_name)) = lower('Starlink Mini Kit')
  LIMIT 1;

  IF v_mini_id IS NULL THEN
    RAISE EXCEPTION 'Target product group not found or could not be created: %', 'Starlink Mini Kit';
  END IF;

  INSERT INTO _starlink_mini_kit_reassign (id, serial_number, old_product_id, new_product_id)
  SELECT
    i.id,
    i.serial_number,
    i.product_id,
    v_mini_id
  FROM public.inventory_items i
  WHERE i.product_id = v_standard_id
    AND upper(btrim(i.serial_number)) LIKE 'KIT4M%';

  UPDATE public.inventory_items i
  SET product_id = m.new_product_id
  FROM _starlink_mini_kit_reassign m
  WHERE i.id = m.id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'Moved % Starlink Mini Kit item(s).', v_updated;
END $$;

-- Result set for the rows changed by this run.
SELECT
  count(*)::bigint AS moved_count,
  array_agg(serial_number ORDER BY serial_number) AS moved_serials
FROM _starlink_mini_kit_reassign;

COMMIT;

-- 3) Verification: KIT4M serials should now be under Starlink Mini Kit.
SELECT
  pl.product_name,
  count(*) FILTER (WHERE upper(btrim(i.serial_number)) LIKE 'KIT4M%')::bigint AS mini_serials,
  count(*) FILTER (
    WHERE upper(btrim(i.serial_number)) LIKE 'KIT4%'
      AND upper(btrim(i.serial_number)) NOT LIKE 'KIT4M%'
  )::bigint AS standard_serials
FROM public.inventory_items i
JOIN public.product_lines pl ON pl.id = i.product_id
WHERE lower(btrim(pl.product_name)) IN (
  lower('Starlink Standard Kit v4'),
  lower('Starlink Mini Kit')
)
GROUP BY pl.product_name
ORDER BY pl.product_name;
