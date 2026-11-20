-- PL1: product lines admin — retire/merge/edit RPCs.
-- SET lock_timeout; no BEGIN/COMMIT (apply-migrations-commit wraps).
-- Does not mutate existing business product rows.

SET lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. Columns: retired_at / retired_by / merged_into_id
-- -----------------------------------------------------------------------------
ALTER TABLE public.product_lines
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS merged_into_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_lines_merged_into_id_fkey'
      AND conrelid = 'public.product_lines'::regclass
  ) THEN
    ALTER TABLE public.product_lines
      ADD CONSTRAINT product_lines_merged_into_id_fkey
      FOREIGN KEY (merged_into_id) REFERENCES public.product_lines (id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

COMMENT ON COLUMN public.product_lines.retired_at IS
  'PL1: when set, product is hidden from new-request and movement pickers; history still shows the name.';
COMMENT ON COLUMN public.product_lines.retired_by IS
  'PL1: auth.users id of the admin who retired the product.';
COMMENT ON COLUMN public.product_lines.merged_into_id IS
  'PL1: after merge, source row kept as alias pointing at the surviving product; never deleted when history exists.';

CREATE INDEX IF NOT EXISTS product_lines_retired_at_idx
  ON public.product_lines (retired_at)
  WHERE retired_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS product_lines_merged_into_id_idx
  ON public.product_lines (merged_into_id)
  WHERE merged_into_id IS NOT NULL;

-- No backfill of retired_at onto existing is_active=false rows (PL1: do not rewrite
-- live catalogue data). product_catalogue already requires is_active IS TRUE.

-- -----------------------------------------------------------------------------
-- 2. product_catalogue — exclude retired
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.product_catalogue()
RETURNS TABLE (
  product_id text,
  product_name text,
  vendor text,
  is_active boolean,
  requires_cloud_key boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
BEGIN
  IF v_uid IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'product_catalogue: signed-in staff only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    pl.id::text AS product_id,
    pl.product_name::text AS product_name,
    pl.vendor::text AS vendor,
    pl.is_active AS is_active,
    pl.requires_cloud_key AS requires_cloud_key
  FROM public.product_lines AS pl
  WHERE pl.is_active IS TRUE
    AND pl.merged_into_id IS NULL
  ORDER BY pl.product_name ASC, pl.vendor ASC;
END;
$$;

COMMENT ON FUNCTION public.product_catalogue() IS
  'HF1/PL1b: active catalogue (is_active, not a merge alias). retired_at is metadata only.';

REVOKE ALL ON FUNCTION public.product_catalogue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.product_catalogue() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. admin_update_product_line
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_update_product_line(
  p_product_id text,
  p_product_name text,
  p_vendor text,
  p_requires_serial boolean,
  p_requires_cloud_key boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_my_role public.app_role := public.get_my_role();
  v_line public.product_lines%ROWTYPE;
  v_name text := nullif(btrim(coalesce(p_product_name, '')), '');
  v_vendor text := coalesce(nullif(btrim(coalesce(p_vendor, '')), ''), 'General');
  v_missing_serial integer := 0;
  v_collision text;
BEGIN
  IF v_uid IS NULL OR v_my_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'admin_update_product_line: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF nullif(btrim(coalesce(p_product_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'admin_update_product_line: product id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'admin_update_product_line: product name is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_line FROM public.product_lines WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin_update_product_line: product not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_line.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'admin_update_product_line: this product was merged into another — edit the surviving product instead'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT other.product_name INTO v_collision
  FROM public.product_lines AS other
  WHERE other.id IS DISTINCT FROM p_product_id
    AND lower(trim(other.product_name)) = lower(v_name)
  LIMIT 1;

  IF v_collision IS NOT NULL THEN
    RAISE EXCEPTION
      'A product named "%" already exists. Rename that one, merge these products, or choose a different name.',
      v_collision
      USING ERRCODE = 'unique_violation';
  END IF;

  IF p_requires_serial IS TRUE THEN
    SELECT count(*)::integer INTO v_missing_serial
    FROM public.inventory_items AS item
    WHERE item.product_id = p_product_id
      AND item.deleted_at IS NULL
      AND item.status = 'In Stock'
      AND nullif(btrim(coalesce(item.serial_number, '')), '') IS NULL;
  END IF;

  PERFORM set_config('app.audit_source', 'admin_update_product_line', true);
  PERFORM set_config('app.audit_reason', 'admin product line edit', true);

  BEGIN
    UPDATE public.product_lines
    SET
      product_name = v_name,
      vendor = v_vendor,
      requires_serial = coalesce(p_requires_serial, requires_serial),
      requires_cloud_key = coalesce(p_requires_cloud_key, requires_cloud_key)
    WHERE id = p_product_id;
  EXCEPTION
    WHEN unique_violation THEN
      PERFORM set_config('app.audit_source', '', true);
      PERFORM set_config('app.audit_reason', '', true);
      RAISE EXCEPTION
        'A product with that name already exists. Rename the other product, merge them, or choose a different name.'
        USING ERRCODE = 'unique_violation';
  END;

  PERFORM set_config('app.audit_source', '', true);
  PERFORM set_config('app.audit_reason', '', true);

  SELECT * INTO v_line FROM public.product_lines WHERE id = p_product_id;

  RETURN jsonb_build_object(
    'id', v_line.id,
    'product_name', v_line.product_name,
    'vendor', v_line.vendor,
    'requires_serial', v_line.requires_serial,
    'requires_cloud_key', v_line.requires_cloud_key,
    'is_active', v_line.is_active,
    'retired_at', v_line.retired_at,
    'merged_into_id', v_line.merged_into_id,
    'in_stock_missing_serial', v_missing_serial,
    'warn_missing_serial', v_missing_serial > 0
  );
END;
$$;

COMMENT ON FUNCTION public.admin_update_product_line(text, text, text, boolean, boolean) IS
  'PL1: admin rename/vendor/requires_* edit. Collision → readable unique_violation. Enabling requires_serial warns (does not block) when in-stock kits lack serials.';

REVOKE ALL ON FUNCTION public.admin_update_product_line(text, text, text, boolean, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_product_line(text, text, text, boolean, boolean)
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. retire / unretire
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retire_product_line(
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
    RAISE EXCEPTION 'retire_product_line: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF nullif(btrim(coalesce(p_product_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'retire_product_line: product id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'retire_product_line: a reason is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_line FROM public.product_lines WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retire_product_line: product not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_line.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'retire_product_line: already merged into another product'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_line.is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'retire_product_line: already retired'
      USING ERRCODE = 'check_violation';
  END IF;

  -- MV1b live-kit guard (single hide concept inherits archive safety).
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
    RAISE EXCEPTION 'retire_product_line: % — return or move them first', array_to_string(v_parts, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.audit_source', 'retire_product_line', true);
  PERFORM set_config('app.audit_reason', v_reason, true);

  UPDATE public.product_lines
  SET
    is_active = false,
    retired_at = now(),
    retired_by = v_uid
  WHERE id = p_product_id;

  PERFORM set_config('app.audit_source', '', true);
  PERFORM set_config('app.audit_reason', '', true);

  SELECT * INTO v_line FROM public.product_lines WHERE id = p_product_id;
  RETURN jsonb_build_object(
    'id', v_line.id,
    'product_name', v_line.product_name,
    'vendor', v_line.vendor,
    'retired_at', v_line.retired_at,
    'is_active', v_line.is_active
  );
END;
$$;

COMMENT ON FUNCTION public.retire_product_line(text, text) IS
  'PL1b: admin retires a product (is_active=false + retired_at). Blocked while In Stock/POC/Rented. Hidden from pickers; history keeps the name.';

REVOKE ALL ON FUNCTION public.retire_product_line(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retire_product_line(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unretire_product_line(
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
BEGIN
  IF v_uid IS NULL OR v_my_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'unretire_product_line: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF nullif(btrim(coalesce(p_product_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'unretire_product_line: product id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'unretire_product_line: a reason is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_line FROM public.product_lines WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unretire_product_line: product not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_line.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'unretire_product_line: merged alias rows cannot be restored — use the surviving product'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_line.is_active IS TRUE THEN
    RAISE EXCEPTION 'unretire_product_line: product is already active'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.audit_source', 'unretire_product_line', true);
  PERFORM set_config('app.audit_reason', v_reason, true);

  UPDATE public.product_lines
  SET
    is_active = true,
    retired_at = NULL,
    retired_by = NULL
  WHERE id = p_product_id;

  PERFORM set_config('app.audit_source', '', true);
  PERFORM set_config('app.audit_reason', '', true);

  SELECT * INTO v_line FROM public.product_lines WHERE id = p_product_id;
  RETURN jsonb_build_object(
    'id', v_line.id,
    'product_name', v_line.product_name,
    'retired_at', v_line.retired_at,
    'is_active', v_line.is_active
  );
END;
$$;

COMMENT ON FUNCTION public.unretire_product_line(text, text) IS
  'PL1: admin restores a retired (non-merged) product to the catalogue.';

REVOKE ALL ON FUNCTION public.unretire_product_line(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unretire_product_line(text, text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. merge_product_lines
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.merge_product_lines(
  p_source_id text,
  p_target_id text,
  p_reason text,
  p_allow_cross_vendor boolean DEFAULT false
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
  v_source public.product_lines%ROWTYPE;
  v_target public.product_lines%ROWTYPE;
  v_inv integer := 0;
  v_req integer := 0;
BEGIN
  IF v_uid IS NULL OR v_my_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'merge_product_lines: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF nullif(btrim(coalesce(p_source_id, '')), '') IS NULL
     OR nullif(btrim(coalesce(p_target_id, '')), '') IS NULL THEN
    RAISE EXCEPTION 'merge_product_lines: source and target are required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_source_id = p_target_id THEN
    RAISE EXCEPTION 'merge_product_lines: source and target must differ'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_reason IS NULL OR char_length(v_reason) < 15 THEN
    RAISE EXCEPTION 'merge_product_lines: reason must be at least 15 characters'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Lock both rows in id order to avoid deadlocks, then load.
  PERFORM 1
  FROM public.product_lines
  WHERE id IN (p_source_id, p_target_id)
  ORDER BY id
  FOR UPDATE;

  SELECT * INTO v_source FROM public.product_lines WHERE id = p_source_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge_product_lines: source product not found'
      USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v_target FROM public.product_lines WHERE id = p_target_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'merge_product_lines: target product not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_source.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'merge_product_lines: source was already merged'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_target.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'merge_product_lines: target was already merged into another product'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_target.is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'merge_product_lines: target is retired — unretire it first or pick another target'
      USING ERRCODE = 'check_violation';
  END IF;

  IF lower(trim(v_source.vendor)) IS DISTINCT FROM lower(trim(v_target.vendor))
     AND coalesce(p_allow_cross_vendor, false) IS NOT TRUE THEN
    RAISE EXCEPTION
      'merge_product_lines: source vendor "%" differs from target "%" — tick allow cross-vendor to proceed',
      v_source.vendor, v_target.vendor
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::integer INTO v_inv
  FROM public.inventory_items WHERE product_id = p_source_id;

  SELECT count(*)::integer INTO v_req
  FROM public.stock_request_lines WHERE product_id = p_source_id;

  -- Audit context before every row move so inventory/request audits carry the merge reason.
  PERFORM set_config('app.audit_source', 'merge_product_lines', true);
  PERFORM set_config('app.audit_reason', v_reason, true);

  UPDATE public.inventory_items
  SET product_id = p_target_id
  WHERE product_id = p_source_id;

  UPDATE public.stock_request_lines
  SET product_id = p_target_id
  WHERE product_id = p_source_id;

  -- Also repoint any alias rows that already pointed at the source
  UPDATE public.product_lines
  SET merged_into_id = p_target_id
  WHERE merged_into_id = p_source_id;

  UPDATE public.product_lines
  SET
    merged_into_id = p_target_id,
    is_active = false,
    retired_at = coalesce(retired_at, now()),
    retired_by = coalesce(retired_by, v_uid)
  WHERE id = p_source_id;

  PERFORM set_config('app.audit_source', '', true);
  PERFORM set_config('app.audit_reason', '', true);

  RETURN jsonb_build_object(
    'source_id', p_source_id,
    'target_id', p_target_id,
    'inventory_moved', v_inv,
    'request_lines_moved', v_req,
    'reason', v_reason
  );
END;
$$;

COMMENT ON FUNCTION public.merge_product_lines(text, text, text, boolean) IS
  'PL1: admin merge — repoint inventory + request lines source→target, retire source as alias (merged_into_id). Reason ≥ 15 chars. Cross-vendor needs explicit flag.';

REVOKE ALL ON FUNCTION public.merge_product_lines(text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_product_lines(text, text, text, boolean)
  TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. Admin overview (counts for UI)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_product_lines_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_my_role public.app_role := public.get_my_role();
BEGIN
  IF v_uid IS NULL OR v_my_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'admin_product_lines_overview: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.product_name, x.vendor)
    FROM (
      SELECT
        pl.id,
        pl.product_name,
        pl.vendor,
        pl.requires_serial,
        pl.requires_cloud_key,
        pl.is_active,
        pl.retired_at,
        pl.retired_by,
        pl.merged_into_id,
        pl.reorder_level,
        pl.created_at,
        (
          SELECT count(*)::integer
          FROM public.inventory_items AS item
          WHERE item.product_id = pl.id
            AND item.deleted_at IS NULL
            AND item.status = 'In Stock'
        ) AS in_stock_count,
        (
          SELECT count(*)::integer
          FROM public.inventory_items AS item
          WHERE item.product_id = pl.id
            AND item.deleted_at IS NULL
        ) AS total_items,
        (
          SELECT count(*)::integer
          FROM public.stock_request_lines AS line
          WHERE line.product_id = pl.id
        ) AS request_lines_count
      FROM public.product_lines AS pl
    ) AS x
  ), '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION public.admin_product_lines_overview() IS
  'PL1: admin-only product list with inventory and request-line counts.';

REVOKE ALL ON FUNCTION public.admin_product_lines_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_product_lines_overview() TO authenticated, service_role;

-- Keep delete_product as-is (already blocks when inventory/request lines exist).

-- -----------------------------------------------------------------------------
-- 7. MV1 archive/restore → thin wrappers around retire/unretire (one hide concept)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.archive_product(
  p_product_id text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.retire_product_line(p_product_id, p_reason);
END;
$$;

COMMENT ON FUNCTION public.archive_product(text, text) IS
  'PL1b: thin wrapper → retire_product_line (single hide concept: Retired).';

REVOKE ALL ON FUNCTION public.archive_product(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_product(text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.restore_product(
  p_product_id text,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.unretire_product_line(p_product_id, p_reason);
END;
$$;

COMMENT ON FUNCTION public.restore_product(text, text) IS
  'PL1b: thin wrapper → unretire_product_line (single hide concept: Retired).';

REVOKE ALL ON FUNCTION public.restore_product(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_product(text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
