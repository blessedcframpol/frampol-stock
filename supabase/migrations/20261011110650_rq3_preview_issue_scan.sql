-- RQ3: preview_issue_scan — validate one scan without writing (plain-language reasons).

BEGIN;

CREATE OR REPLACE FUNCTION public.preview_issue_scan(
  p_request_id uuid,
  p_serial text,
  p_already_scanned text[] DEFAULT '{}'::text[],
  p_cloud_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_req public.stock_requests%ROWTYPE;
  v_serial text := btrim(coalesce(p_serial, ''));
  v_scan_key text := nullif(btrim(coalesce(p_cloud_key, '')), '');
  v_item public.inventory_items%ROWTYPE;
  v_vendor text;
  v_product text;
  v_needs_key boolean;
  v_pool text;
  v_line_id uuid;
  v_line_name text;
  v_remaining int;
  v_want_names text;
  v_last_type text;
  v_last_client text;
  v_last_date text;
  v_already text[] := coalesce(p_already_scanned, '{}'::text[]);
BEGIN
  IF v_uid IS NULL OR NOT coalesce(v_role IN ('admin', 'accounts'), false) THEN
    RAISE EXCEPTION 'Only admin or accounts can preview issue scans'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_serial = '' THEN
    RETURN jsonb_build_object('ok', false, 'serial', '', 'reason', 'Serial is blank');
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(v_already) AS s(serial)
    WHERE lower(btrim(s.serial)) = lower(v_serial)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'serial', v_serial, 'reason', 'Already scanned');
  END IF;

  SELECT * INTO v_req FROM public.stock_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'serial', v_serial, 'reason', 'Request was not found');
  END IF;
  IF v_req.review_state IS DISTINCT FROM 'submitted' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'serial', v_serial,
      'reason', CASE v_req.review_state
        WHEN 'awaiting_approval' THEN 'This request is awaiting 00000 approval'
        WHEN 'rejected' THEN 'This request was rejected'
        WHEN 'cancelled' THEN 'This request is cancelled'
        WHEN 'closed' THEN 'This request is closed'
        ELSE 'This request cannot be issued'
      END
    );
  END IF;

  SELECT * INTO v_item
  FROM public.inventory_items
  WHERE serial_number = v_serial AND deleted_at IS NULL
  ORDER BY id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'serial', v_serial, 'reason', 'Serial is not in inventory');
  END IF;

  IF v_item.status IS DISTINCT FROM 'In Stock' THEN
    SELECT t.type, t.client, to_char(t.date::date, 'DD/MM/YYYY')
    INTO v_last_type, v_last_client, v_last_date
    FROM public.transactions AS t
    WHERE t.serial_number = v_serial
      AND t.type IS DISTINCT FROM 'Reversal'
      AND NOT public.batch_is_currently_reversed(coalesce(nullif(btrim(t.batch_id), ''), t.id))
    ORDER BY public.transaction_record_time(t.id, t.created_at, t.date) DESC
    LIMIT 1;

    RETURN jsonb_build_object(
      'ok', false,
      'serial', v_serial,
      'reason', CASE
        WHEN v_item.status = 'Sold' AND v_last_client IS NOT NULL THEN
          format('Not in stock — sold to %s on %s', v_last_client, coalesce(v_last_date, 'an earlier date'))
        WHEN v_item.status IN ('POC', 'Rented') AND v_last_client IS NOT NULL THEN
          format('Not in stock — out on %s with %s', lower(v_item.status), v_last_client)
        ELSE format('Not in stock — status is %s', v_item.status)
      END
    );
  END IF;

  SELECT line.vendor, line.product_name, line.requires_cloud_key
  INTO v_vendor, v_product, v_needs_key
  FROM public.product_lines AS line
  WHERE line.id = v_item.product_id;

  IF v_role = 'accounts' AND lower(btrim(coalesce(v_vendor, ''))) IS DISTINCT FROM 'fortinet' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'serial', v_serial,
      'reason', 'Accounts can only issue Fortinet units'
    );
  END IF;

  SELECT line.id, line.product_name,
    line.quantity_requested
      - (SELECT count(*)::int FROM public.active_transactions AS t WHERE t.request_line_id = line.id)
      - (
        SELECT count(*)::int FROM unnest(v_already) AS s(serial)
        JOIN public.inventory_items AS i
          ON i.serial_number = btrim(s.serial) AND i.deleted_at IS NULL
        WHERE i.product_id = line.product_id
      )
  INTO v_line_id, v_line_name, v_remaining
  FROM public.stock_request_lines AS line
  WHERE line.request_id = p_request_id
    AND line.product_id = v_item.product_id
  ORDER BY line.sort_order, line.id
  LIMIT 1;

  IF v_line_id IS NULL THEN
    SELECT string_agg(DISTINCT line.product_name, ', ' ORDER BY line.product_name)
    INTO v_want_names
    FROM public.stock_request_lines AS line
    WHERE line.request_id = p_request_id;

    RETURN jsonb_build_object(
      'ok', false,
      'serial', v_serial,
      'reason', format(
        'Wrong product — this is a %s, the request is for %s',
        coalesce(v_product, 'different product'),
        coalesce(v_want_names, 'other products')
      )
    );
  END IF;

  IF coalesce(v_remaining, 0) <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'serial', v_serial,
      'reason', format('All requested %s units are already filled', coalesce(v_line_name, 'product'))
    );
  END IF;

  v_pool := coalesce(v_item.stock_pool, 'sale');
  IF v_req.type = 'Sale' AND v_pool IS DISTINCT FROM 'sale' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'serial', v_serial,
      'reason', format('Sale requires a sellable kit. Move it from %s to sale first', v_pool)
    );
  ELSIF v_req.type = 'POC Out' AND v_pool NOT IN ('sale', 'demo') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'serial', v_serial,
      'reason', format('POC Out is not allowed from the %s group', v_pool)
    );
  ELSIF v_req.type = 'Rentals' AND coalesce(v_vendor, '') IS DISTINCT FROM 'Starlink' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'serial', v_serial,
      'reason', 'Rentals is only for Starlink kits'
    );
  ELSIF v_req.type = 'Rentals' AND v_pool NOT IN ('sale', 'rental') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'serial', v_serial,
      'reason', format('Rentals is not allowed from the %s group', v_pool)
    );
  END IF;

  IF coalesce(v_needs_key, false)
     AND nullif(btrim(coalesce(v_item.cloud_key, '')), '') IS NULL
     AND v_scan_key IS NULL THEN
    RETURN jsonb_build_object(
      'ok', true,
      'serial', v_serial,
      'line_id', v_line_id,
      'product_id', v_item.product_id,
      'product_name', coalesce(v_product, v_line_name),
      'needs_cloud_key', true,
      'cloud_key_prompt', format('Scan the cloud key for %s', v_serial)
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'serial', v_serial,
    'line_id', v_line_id,
    'product_id', v_item.product_id,
    'product_name', coalesce(v_product, v_line_name),
    'needs_cloud_key', false,
    'cloud_key', coalesce(v_scan_key, nullif(btrim(coalesce(v_item.cloud_key, '')), ''))
  );
END;
$$;

COMMENT ON FUNCTION public.preview_issue_scan(uuid, text, text[], text) IS
  'Validate one issue scan without writing. Returns ok + line assignment, or a plain-language reason.';

REVOKE ALL ON FUNCTION public.preview_issue_scan(uuid, text, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_issue_scan(uuid, text, text[], text) TO authenticated, service_role;

COMMIT;
