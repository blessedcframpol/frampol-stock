-- RH1: stock_availability — counts only (In Stock, sale pool, not deleted).
-- No serials, locations, clients, prices, or history. Callable by every signed-in role.
-- No BEGIN/COMMIT.

CREATE OR REPLACE FUNCTION public.stock_availability(
  p_query text DEFAULT NULL
)
RETURNS TABLE (
  product_id text,
  product_name text,
  vendor text,
  available_count integer,
  reorder_level integer,
  is_low boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_default integer;
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'stock_availability: signed-in staff only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT coalesce(default_reorder_level, 0)
  INTO v_default
  FROM public.app_settings
  WHERE id IS TRUE;

  RETURN QUERY
  SELECT
    pl.id::text AS product_id,
    pl.product_name::text AS product_name,
    pl.vendor::text AS vendor,
    coalesce(counts.n, 0)::integer AS available_count,
    coalesce(pl.reorder_level, v_default)::integer AS reorder_level,
    (coalesce(counts.n, 0) <= coalesce(pl.reorder_level, v_default)) AS is_low
  FROM public.product_lines AS pl
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS n
    FROM public.inventory_items AS item
    WHERE item.product_id = pl.id
      AND item.deleted_at IS NULL
      AND item.status = 'In Stock'
      AND coalesce(item.stock_pool, 'sale') = 'sale'
  ) AS counts ON true
  WHERE pl.is_active IS TRUE
    AND (
      v_q IS NULL
      OR pl.product_name ILIKE '%' || v_q || '%'
      OR pl.vendor ILIKE '%' || v_q || '%'
    )
  ORDER BY pl.product_name ASC, pl.vendor ASC;
END;
$$;

COMMENT ON FUNCTION public.stock_availability(text) IS
  'RH1: available sale-pool In Stock counts per product. No serials or other item fields.';

REVOKE ALL ON FUNCTION public.stock_availability(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_availability(text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
