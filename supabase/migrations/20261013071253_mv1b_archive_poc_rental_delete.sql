-- MV1b: archive also blocked for POC/Rented kits; delete refuses transactions.item_name history.
-- No BEGIN/COMMIT: rehearse and apply wrap their own transactions.
-- Does not mutate existing business rows.

CREATE OR REPLACE FUNCTION public.archive_product(
  p_product_id text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_my_role public.app_role := public.get_my_role();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_line public.product_lines%ROWTYPE;
  v_in_stock integer;
  v_poc integer;
  v_rental integer;
  v_parts text[] := ARRAY[]::text[];
BEGIN
  IF v_uid IS NULL OR v_my_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'archive_product: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF nullif(btrim(coalesce(p_product_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'archive_product: product id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'archive_product: a reason is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_line FROM public.product_lines WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'archive_product: product not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_line.is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'archive_product: product is already archived'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT
    count(*) FILTER (WHERE item.status = 'In Stock')::integer,
    count(*) FILTER (WHERE item.status = 'POC')::integer,
    count(*) FILTER (WHERE item.status = 'Rented')::integer
  INTO v_in_stock, v_poc, v_rental
  FROM public.inventory_items AS item
  WHERE item.product_id = p_product_id
    AND item.deleted_at IS NULL
    AND item.status IN ('In Stock', 'POC', 'Rented');

  IF v_in_stock > 0 THEN
    v_parts := v_parts || format('%s kit(s) still In Stock', v_in_stock);
  END IF;
  IF v_poc > 0 THEN
    v_parts := v_parts || format('%s kit(s) still on POC', v_poc);
  END IF;
  IF v_rental > 0 THEN
    v_parts := v_parts || format('%s kit(s) still on Rental', v_rental);
  END IF;

  IF cardinality(v_parts) > 0 THEN
    RAISE EXCEPTION 'archive_product: % — return or move them first', array_to_string(v_parts, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.audit_source', 'archive_product', true);
  PERFORM set_config('app.audit_reason', v_reason, true);

  UPDATE public.product_lines
  SET is_active = false
  WHERE id = p_product_id;

  PERFORM set_config('app.audit_source', '', true);
  PERFORM set_config('app.audit_reason', '', true);

  SELECT * INTO v_line FROM public.product_lines WHERE id = p_product_id;

  RETURN jsonb_build_object(
    'id', v_line.id,
    'product_name', v_line.product_name,
    'vendor', v_line.vendor,
    'is_active', v_line.is_active
  );
END;
$$;

COMMENT ON FUNCTION public.archive_product(text, text) IS
  'Admin archives a product (is_active=false). Blocked while any kits are In Stock, POC, or Rented. Reason required and audited.';

CREATE OR REPLACE FUNCTION public.delete_product(
  p_product_id text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_my_role public.app_role := public.get_my_role();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_line public.product_lines%ROWTYPE;
  v_inv integer;
  v_req integer;
  v_txn integer;
BEGIN
  IF v_uid IS NULL OR v_my_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'delete_product: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF nullif(btrim(coalesce(p_product_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'delete_product: product id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'delete_product: a reason is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_line FROM public.product_lines WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'delete_product: product not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT count(*)::integer INTO v_inv
  FROM public.inventory_items WHERE product_id = p_product_id;

  SELECT count(*)::integer INTO v_req
  FROM public.stock_request_lines WHERE product_id = p_product_id;

  SELECT count(*)::integer INTO v_txn
  FROM public.transactions AS txn
  WHERE lower(btrim(txn.item_name)) = lower(btrim(v_line.product_name));

  IF v_inv > 0 OR v_req > 0 OR v_txn > 0 THEN
    RAISE EXCEPTION
      'delete_product: product has history (% inventory row(s), % request line(s), % transaction(s) by name) — archive instead',
      v_inv, v_req, v_txn
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  PERFORM set_config('app.audit_source', 'delete_product', true);
  PERFORM set_config('app.audit_reason', v_reason, true);

  DELETE FROM public.product_lines WHERE id = p_product_id;

  PERFORM set_config('app.audit_source', '', true);
  PERFORM set_config('app.audit_reason', '', true);

  RETURN jsonb_build_object(
    'id', v_line.id,
    'product_name', v_line.product_name,
    'vendor', v_line.vendor,
    'deleted', true
  );
END;
$$;

COMMENT ON FUNCTION public.delete_product(text, text) IS
  'Admin deletes a product only when nothing references it (inventory, request lines, or transactions.item_name). Otherwise archive. Reason required and audited.';

NOTIFY pgrst, 'reload schema';
