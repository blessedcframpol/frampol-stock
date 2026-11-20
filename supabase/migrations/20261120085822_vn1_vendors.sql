-- VN1: vendors catalog + admin RPCs (add/rename/move/delete/merge).
-- SET lock_timeout; no BEGIN/COMMIT (apply-migrations-commit wraps).
-- Does not rewrite production business data beyond seeding vendors from product_lines.

SET lock_timeout = '5s';

-- -----------------------------------------------------------------------------
-- 1. vendors table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vendors (
  name text PRIMARY KEY,
  is_protected boolean NOT NULL DEFAULT false,
  protected_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  CONSTRAINT vendors_name_nonempty_chk CHECK (nullif(btrim(name), '') IS NOT NULL),
  CONSTRAINT vendors_protected_reason_chk CHECK (
    is_protected IS FALSE
    OR nullif(btrim(coalesce(protected_reason, '')), '') IS NOT NULL
  )
);

COMMENT ON TABLE public.vendors IS
  'VN1: catalogue of vendor names. product_lines.vendor FK ON UPDATE CASCADE.';
COMMENT ON COLUMN public.vendors.is_protected IS
  'When true, rename/delete/merge-as-source are blocked (code/SQL hard-codes the name).';
COMMENT ON COLUMN public.vendors.protected_reason IS
  'Plain-language reason shown to admins when a protected action is refused.';

CREATE UNIQUE INDEX IF NOT EXISTS vendors_name_lower_uidx
  ON public.vendors (lower(btrim(name)));

-- Seed from distinct product_lines.vendor (exact spellings).
INSERT INTO public.vendors (name, is_protected, protected_reason)
SELECT DISTINCT
  btrim(pl.vendor) AS name,
  false,
  NULL
FROM public.product_lines pl
WHERE nullif(btrim(pl.vendor), '') IS NOT NULL
ON CONFLICT (name) DO NOTHING;

-- Ensure General exists (default fallback).
INSERT INTO public.vendors (name, is_protected, protected_reason)
VALUES (
  'General',
  true,
  'General is the default vendor when none is chosen. Renaming it would break new products and empty vendor handling.'
)
ON CONFLICT (name) DO UPDATE
SET
  is_protected = true,
  protected_reason = EXCLUDED.protected_reason;

UPDATE public.vendors
SET
  is_protected = true,
  protected_reason = 'Rentals, rental pool moves, convert-to-sale, and inspection "Rent out" are only allowed for Starlink kits.'
WHERE name = 'Starlink';

UPDATE public.vendors
SET
  is_protected = true,
  protected_reason = 'Accounts staff may only issue Fortinet units; requests must be all-Fortinet or none; cloud-key rules use Fortinet.'
WHERE name = 'Fortinet';

ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendors_select_authenticated ON public.vendors;
CREATE POLICY vendors_select_authenticated
  ON public.vendors FOR SELECT TO authenticated
  USING ((SELECT public.get_my_role()) IS NOT NULL);

-- No INSERT/UPDATE/DELETE policies for authenticated — writes via SECURITY DEFINER RPCs only.
REVOKE ALL ON TABLE public.vendors FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.vendors TO authenticated;
GRANT ALL ON TABLE public.vendors TO service_role;

DROP TRIGGER IF EXISTS tr_vendors_audit ON public.vendors;
CREATE TRIGGER tr_vendors_audit
  AFTER INSERT OR DELETE OR UPDATE ON public.vendors
  FOR EACH ROW EXECUTE FUNCTION public.audit_capture('name');

-- -----------------------------------------------------------------------------
-- 2. product_lines.vendor → FK vendors(name) ON UPDATE CASCADE
-- -----------------------------------------------------------------------------
-- Normalize blanks to General before FK.
UPDATE public.product_lines
SET vendor = 'General'
WHERE nullif(btrim(vendor), '') IS NULL
   OR btrim(vendor) = '';

UPDATE public.product_lines
SET vendor = btrim(vendor)
WHERE vendor IS DISTINCT FROM btrim(vendor);

-- Any leftover unknown vendors (should be none after seed).
INSERT INTO public.vendors (name, is_protected, protected_reason)
SELECT DISTINCT btrim(pl.vendor), false, NULL
FROM public.product_lines pl
WHERE NOT EXISTS (
  SELECT 1 FROM public.vendors v WHERE v.name = btrim(pl.vendor)
)
ON CONFLICT (name) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'product_lines_vendor_fkey'
      AND conrelid = 'public.product_lines'::regclass
  ) THEN
    ALTER TABLE public.product_lines
      ADD CONSTRAINT product_lines_vendor_fkey
      FOREIGN KEY (vendor) REFERENCES public.vendors (name)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. ensure_product_line — create vendor row if missing (floor flows keep working)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_product_line(p_product_name text, p_vendor text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := lower(trim(p_product_name));
  v_norm_vendor text := coalesce(nullif(trim(p_vendor), ''), 'General');
  v_canon text;
  v_id text;
  v_existing_vendor text;
  v_role public.app_role := public.get_my_role();
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('admin', 'technicians', 'sales') THEN
    RAISE EXCEPTION 'ensure_product_line: not permitted';
  END IF;

  IF v_key = '' THEN
    RAISE EXCEPTION 'ensure_product_line: product name is required';
  END IF;

  -- Prefer canonical casing from vendors when a case-insensitive match exists.
  SELECT v.name INTO v_canon
  FROM public.vendors v
  WHERE lower(btrim(v.name)) = lower(v_norm_vendor)
  LIMIT 1;
  IF FOUND THEN
    v_norm_vendor := v_canon;
  ELSE
    INSERT INTO public.vendors (name, is_protected, protected_reason, created_by)
    VALUES (v_norm_vendor, false, NULL, auth.uid())
    ON CONFLICT (name) DO NOTHING;
    SELECT v.name INTO v_norm_vendor
    FROM public.vendors v
    WHERE lower(btrim(v.name)) = lower(v_norm_vendor)
    LIMIT 1;
  END IF;

  SELECT pl.id, pl.vendor
  INTO v_id, v_existing_vendor
  FROM public.product_lines pl
  WHERE lower(trim(pl.product_name)) = v_key
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    IF v_existing_vendor IS DISTINCT FROM v_norm_vendor THEN
      RAISE EXCEPTION 'ensure_product_line: product "%" already exists under vendor "%" (cannot use vendor "%")',
        trim(p_product_name), v_existing_vendor, v_norm_vendor;
    END IF;
    RETURN v_id;
  END IF;

  BEGIN
    v_id := 'PL-' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO public.product_lines (id, product_name, vendor)
    VALUES (v_id, trim(p_product_name), v_norm_vendor);
    RETURN v_id;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT pl.id, pl.vendor INTO v_id, v_existing_vendor
      FROM public.product_lines pl
      WHERE lower(trim(pl.product_name)) = v_key
      LIMIT 1;
      IF v_id IS NULL THEN
        RAISE;
      END IF;
      IF v_existing_vendor IS DISTINCT FROM v_norm_vendor THEN
        RAISE EXCEPTION 'ensure_product_line: product "%" already exists under vendor "%" (cannot use vendor "%")',
          trim(p_product_name), v_existing_vendor, v_norm_vendor;
      END IF;
      RETURN v_id;
  END;
END;
$$;

COMMENT ON FUNCTION public.ensure_product_line(text, text) IS
  'VN1: create/find product line; creates vendors row if missing so floor flows do not require pre-registration.';

REVOKE ALL ON FUNCTION public.ensure_product_line(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_product_line(text, text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Admin RPCs
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_vendor(p_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_existing text;
BEGIN
  IF v_uid IS NULL OR v_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'Only an admin can add a vendor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Enter a vendor name'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT v.name INTO v_existing
  FROM public.vendors v
  WHERE lower(btrim(v.name)) = lower(v_name)
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION '% already exists', v_existing
      USING ERRCODE = 'unique_violation';
  END IF;

  PERFORM set_config('app.audit_source', 'add_vendor', true);
  PERFORM set_config('app.audit_reason', 'admin added vendor', true);
  INSERT INTO public.vendors (name, created_by) VALUES (v_name, v_uid);
  PERFORM set_config('app.audit_source', '', true);
  PERFORM set_config('app.audit_reason', '', true);

  RETURN jsonb_build_object('name', v_name);
END;
$$;

COMMENT ON FUNCTION public.add_vendor(text) IS 'VN1: admin creates a vendor. Case-insensitive duplicate → readable error.';
REVOKE ALL ON FUNCTION public.add_vendor(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_vendor(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rename_vendor(p_old text, p_new text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_old text := nullif(btrim(coalesce(p_old, '')), '');
  v_new text := nullif(btrim(coalesce(p_new, '')), '');
  v_row public.vendors%ROWTYPE;
  v_collision text;
  v_products integer;
BEGIN
  IF v_uid IS NULL OR v_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'Only an admin can rename a vendor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_old IS NULL OR v_new IS NULL THEN
    RAISE EXCEPTION 'Choose the current name and the new name'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_row FROM public.vendors WHERE name = v_old FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That vendor was not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_row.is_protected THEN
    RAISE EXCEPTION 'Cannot rename % — %', v_old, coalesce(v_row.protected_reason, 'it is used by the system')
      USING ERRCODE = 'check_violation';
  END IF;

  IF lower(v_old) = lower(v_new) AND v_old IS DISTINCT FROM v_new THEN
    -- Casing-only rename of the same vendor
    NULL;
  ELSE
    SELECT v.name INTO v_collision
    FROM public.vendors v
    WHERE lower(btrim(v.name)) = lower(v_new)
      AND v.name IS DISTINCT FROM v_old
    LIMIT 1;
    IF v_collision IS NOT NULL THEN
      RAISE EXCEPTION
        '% already exists. Use Merge to combine these vendors instead of renaming.',
        v_collision
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  SELECT count(*)::integer INTO v_products
  FROM public.product_lines WHERE vendor = v_old;

  PERFORM set_config('app.audit_source', 'rename_vendor', true);
  PERFORM set_config('app.audit_reason', format('rename %s → %s', v_old, v_new), true);
  UPDATE public.vendors SET name = v_new WHERE name = v_old;
  PERFORM set_config('app.audit_source', '', true);
  PERFORM set_config('app.audit_reason', '', true);

  RETURN jsonb_build_object(
    'old_name', v_old,
    'new_name', v_new,
    'products_updated', v_products
  );
END;
$$;

COMMENT ON FUNCTION public.rename_vendor(text, text) IS
  'VN1: admin rename; CASCADE updates product_lines.vendor. Protected vendors blocked.';
REVOKE ALL ON FUNCTION public.rename_vendor(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_vendor(text, text) TO authenticated, service_role;

-- VN1b: shared assessment for move/merge previews and guards.
CREATE OR REPLACE FUNCTION public.vendor_product_move_assessment(
  p_product_ids text[],
  p_target_vendor text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target text;
  v_target_row public.vendors%ROWTYPE;
  v_from text[];
  v_product_count integer := 0;
  v_kit_count integer := 0;
  v_starlink_out_ids text[];
  v_fortinet_out_ids text[];
  v_starlink_out_kits integer := 0;
  v_fortinet_open integer := 0;
  v_source_prot jsonb := '[]'::jsonb;
  v_requires_reason boolean := false;
  v_blocked boolean := false;
  v_blocks jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_into_starlink boolean := false;
  v_out_starlink boolean := false;
  v_into_fortinet boolean := false;
  v_out_fortinet boolean := false;
  v_into_general boolean := false;
  v_out_general boolean := false;
  v_prot_reasons text := '';
BEGIN
  IF p_product_ids IS NULL OR cardinality(p_product_ids) = 0 THEN
    RAISE EXCEPTION 'Select at least one product'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT v.* INTO v_target_row
  FROM public.vendors v
  WHERE lower(btrim(v.name)) = lower(btrim(coalesce(p_target_vendor, '')))
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vendor "%" does not exist — add it first', p_target_vendor
      USING ERRCODE = 'no_data_found';
  END IF;
  v_target := v_target_row.name;

  SELECT count(*)::integer INTO v_product_count
  FROM public.product_lines pl
  WHERE pl.id = ANY (p_product_ids);

  SELECT coalesce(array_agg(x ORDER BY x), '{}'::text[])
  INTO v_from
  FROM (
    SELECT DISTINCT pl.vendor AS x
    FROM public.product_lines pl
    WHERE pl.id = ANY (p_product_ids)
  ) d;

  SELECT count(*)::integer INTO v_kit_count
  FROM public.inventory_items i
  WHERE i.product_id = ANY (p_product_ids)
    AND i.deleted_at IS NULL;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', v.name,
    'protected_reason', v.protected_reason
  ) ORDER BY v.name), '[]'::jsonb)
  INTO v_source_prot
  FROM public.vendors v
  WHERE v.is_protected
    AND v.name = ANY (v_from);

  IF jsonb_array_length(v_source_prot) > 0 OR v_target_row.is_protected THEN
    v_requires_reason := true;
  END IF;

  SELECT coalesce(array_agg(pl.id), '{}'::text[])
  INTO v_starlink_out_ids
  FROM public.product_lines pl
  WHERE pl.id = ANY (p_product_ids)
    AND pl.vendor = 'Starlink'
    AND v_target IS DISTINCT FROM 'Starlink';

  SELECT coalesce(array_agg(pl.id), '{}'::text[])
  INTO v_fortinet_out_ids
  FROM public.product_lines pl
  WHERE pl.id = ANY (p_product_ids)
    AND pl.vendor = 'Fortinet'
    AND v_target IS DISTINCT FROM 'Fortinet';

  v_out_starlink := cardinality(v_starlink_out_ids) > 0;
  v_into_starlink := v_target = 'Starlink' AND EXISTS (
    SELECT 1 FROM public.product_lines pl
    WHERE pl.id = ANY (p_product_ids) AND pl.vendor IS DISTINCT FROM 'Starlink'
  );
  v_out_fortinet := cardinality(v_fortinet_out_ids) > 0;
  v_into_fortinet := v_target = 'Fortinet' AND EXISTS (
    SELECT 1 FROM public.product_lines pl
    WHERE pl.id = ANY (p_product_ids) AND pl.vendor IS DISTINCT FROM 'Fortinet'
  );
  v_out_general := EXISTS (
    SELECT 1 FROM public.product_lines pl
    WHERE pl.id = ANY (p_product_ids)
      AND pl.vendor = 'General'
      AND v_target IS DISTINCT FROM 'General'
  );
  v_into_general := v_target = 'General' AND EXISTS (
    SELECT 1 FROM public.product_lines pl
    WHERE pl.id = ANY (p_product_ids) AND pl.vendor IS DISTINCT FROM 'General'
  );

  IF v_out_starlink THEN
    SELECT count(*)::integer INTO v_starlink_out_kits
    FROM public.inventory_items i
    WHERE i.product_id = ANY (v_starlink_out_ids)
      AND i.deleted_at IS NULL
      AND (
        i.status IN ('Rented', 'POC')
        OR i.stock_pool = 'rental'
      );
    IF v_starlink_out_kits > 0 THEN
      v_blocked := true;
      v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
        'code', 'starlink_out_active',
        'count', v_starlink_out_kits
      ));
    END IF;
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'move_out_of_starlink'));
  END IF;

  IF v_out_fortinet THEN
    SELECT count(DISTINCT sr.id)::integer INTO v_fortinet_open
    FROM public.stock_requests sr
    JOIN public.stock_request_lines srl ON srl.request_id = sr.id
    WHERE srl.product_id = ANY (v_fortinet_out_ids)
      AND sr.review_state NOT IN ('closed', 'cancelled', 'rejected');
    IF v_fortinet_open > 0 THEN
      v_blocked := true;
      v_blocks := v_blocks || jsonb_build_array(jsonb_build_object(
        'code', 'fortinet_open_requests',
        'count', v_fortinet_open
      ));
    END IF;
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'move_out_of_fortinet'));
  END IF;

  IF v_into_starlink THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'move_into_starlink'));
  END IF;
  IF v_into_fortinet THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'move_into_fortinet'));
  END IF;
  IF v_into_general THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'move_into_general'));
  END IF;
  IF v_out_general THEN
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'move_out_of_general'));
  END IF;

  SELECT string_agg(x, E'\n' ORDER BY x) INTO v_prot_reasons
  FROM (
    SELECT format('%s — %s', e->>'name', e->>'protected_reason') AS x
    FROM jsonb_array_elements(v_source_prot) e
    UNION ALL
    SELECT format('%s — %s', v_target, v_target_row.protected_reason)
    WHERE v_target_row.is_protected
  ) s;

  RETURN jsonb_build_object(
    'target', v_target,
    'from_vendors', to_jsonb(v_from),
    'product_count', v_product_count,
    'kit_count', v_kit_count,
    'source_protected', v_source_prot,
    'target_protected', CASE
      WHEN v_target_row.is_protected THEN jsonb_build_object(
        'name', v_target,
        'protected_reason', v_target_row.protected_reason
      )
      ELSE NULL
    END,
    'protected_reasons_text', coalesce(v_prot_reasons, ''),
    'requires_reason', v_requires_reason,
    'blocked', v_blocked,
    'blocks', v_blocks,
    'warnings', v_warnings,
    'starlink_out_kit_count', v_starlink_out_kits,
    'fortinet_open_request_count', v_fortinet_open
  );
END;
$$;

COMMENT ON FUNCTION public.vendor_product_move_assessment(text[], text) IS
  'VN1b: read-only assessment for moving products between vendors (blocks + warning codes).';
REVOKE ALL ON FUNCTION public.vendor_product_move_assessment(text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendor_product_move_assessment(text[], text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.preview_vendor_product_move(
  p_target_vendor text,
  p_product_ids text[] DEFAULT NULL,
  p_source_vendor text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_ids text[];
BEGIN
  IF v_uid IS NULL OR v_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'Only an admin can preview vendor moves'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_product_ids IS NOT NULL AND cardinality(p_product_ids) > 0 THEN
    v_ids := p_product_ids;
  ELSIF nullif(btrim(coalesce(p_source_vendor, '')), '') IS NOT NULL THEN
    SELECT coalesce(array_agg(pl.id), '{}'::text[])
    INTO v_ids
    FROM public.product_lines pl
    WHERE pl.vendor = btrim(p_source_vendor);
  ELSE
    RAISE EXCEPTION 'Select products or a source vendor'
      USING ERRCODE = 'check_violation';
  END IF;

  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object(
      'target', nullif(btrim(coalesce(p_target_vendor, '')), ''),
      'from_vendors', '[]'::jsonb,
      'product_count', 0,
      'kit_count', 0,
      'source_protected', '[]'::jsonb,
      'target_protected', NULL,
      'protected_reasons_text', '',
      'requires_reason', false,
      'blocked', false,
      'blocks', '[]'::jsonb,
      'warnings', '[]'::jsonb,
      'starlink_out_kit_count', 0,
      'fortinet_open_request_count', 0
    );
  END IF;

  RETURN public.vendor_product_move_assessment(v_ids, p_target_vendor);
END;
$$;

COMMENT ON FUNCTION public.preview_vendor_product_move(text, text[], text) IS
  'VN1b: admin preview of move/merge consequences before confirm.';
REVOKE ALL ON FUNCTION public.preview_vendor_product_move(text, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_vendor_product_move(text, text[], text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.move_products_to_vendor(
  p_product_ids text[],
  p_vendor text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_vendor text := nullif(btrim(coalesce(p_vendor, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_assess jsonb;
  v_canon text;
  v_moved integer := 0;
  v_block jsonb;
  v_msg text;
BEGIN
  IF v_uid IS NULL OR v_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'Only an admin can move products between vendors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_product_ids IS NULL OR cardinality(p_product_ids) = 0 THEN
    RAISE EXCEPTION 'Select at least one product'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_vendor IS NULL THEN
    RAISE EXCEPTION 'Choose a vendor'
      USING ERRCODE = 'check_violation';
  END IF;

  v_assess := public.vendor_product_move_assessment(p_product_ids, v_vendor);
  v_canon := v_assess->>'target';

  IF (v_assess->>'requires_reason')::boolean
     AND (v_reason IS NULL OR char_length(v_reason) < 15) THEN
    RAISE EXCEPTION
      'Explain why (at least 15 characters). %',
      nullif(v_assess->>'protected_reasons_text', '')
      USING ERRCODE = 'check_violation';
  END IF;

  IF (v_assess->>'blocked')::boolean THEN
    FOR v_block IN SELECT * FROM jsonb_array_elements(v_assess->'blocks')
    LOOP
      IF v_block->>'code' = 'starlink_out_active' THEN
        IF (v_block->>'count')::int = 1 THEN
          v_msg := '1 kit is out on rental — return them first';
        ELSE
          v_msg := format('%s kits are out on rental — return them first', v_block->>'count');
        END IF;
        RAISE EXCEPTION '%', v_msg USING ERRCODE = 'check_violation';
      ELSIF v_block->>'code' = 'fortinet_open_requests' THEN
        IF (v_block->>'count')::int = 1 THEN
          RAISE EXCEPTION '1 open request uses this product'
            USING ERRCODE = 'check_violation';
        ELSE
          RAISE EXCEPTION '% open requests use this product', v_block->>'count'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    END LOOP;
    RAISE EXCEPTION 'This move is blocked' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.audit_source', 'move_products_to_vendor', true);
  PERFORM set_config(
    'app.audit_reason',
    coalesce(v_reason, format('move products to %s', v_canon)),
    true
  );

  UPDATE public.product_lines
  SET vendor = v_canon
  WHERE id = ANY (p_product_ids)
    AND vendor IS DISTINCT FROM v_canon;

  GET DIAGNOSTICS v_moved = ROW_COUNT;

  PERFORM set_config('app.audit_source', '', true);
  PERFORM set_config('app.audit_reason', '', true);

  RETURN jsonb_build_object(
    'vendor', v_canon,
    'products_moved', v_moved,
    'products_requested', cardinality(p_product_ids),
    'kits_affected', (v_assess->>'kit_count')::integer,
    'from_vendors', coalesce(
      (SELECT string_agg(x, ', ' ORDER BY x)
       FROM jsonb_array_elements_text(v_assess->'from_vendors') t(x)),
      ''
    ),
    'protected_reasons_text', v_assess->>'protected_reasons_text'
  );
END;
$$;

COMMENT ON FUNCTION public.move_products_to_vendor(text[], text, text) IS
  'VN1b: admin moves product_lines; guarded when locked vendors / rental / open Fortinet requests.';
REVOKE ALL ON FUNCTION public.move_products_to_vendor(text[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_products_to_vendor(text[], text, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.delete_vendor(p_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_row public.vendors%ROWTYPE;
  v_products integer;
BEGIN
  IF v_uid IS NULL OR v_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'Only an admin can delete a vendor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Choose a vendor to delete'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_row FROM public.vendors WHERE name = v_name FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That vendor was not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_row.is_protected THEN
    RAISE EXCEPTION 'Cannot delete % — %', v_name, coalesce(v_row.protected_reason, 'it is used by the system')
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*)::integer INTO v_products
  FROM public.product_lines WHERE vendor = v_name;
  IF v_products > 0 THEN
    RAISE EXCEPTION
      'Move its products first — % still has % product(s)',
      v_name, v_products
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  PERFORM set_config('app.audit_source', 'delete_vendor', true);
  PERFORM set_config('app.audit_reason', format('delete vendor %s', v_name), true);
  DELETE FROM public.vendors WHERE name = v_name;
  PERFORM set_config('app.audit_source', '', true);
  PERFORM set_config('app.audit_reason', '', true);

  RETURN jsonb_build_object('name', v_name, 'deleted', true);
END;
$$;

COMMENT ON FUNCTION public.delete_vendor(text) IS
  'VN1: admin deletes an empty, non-protected vendor.';
REVOKE ALL ON FUNCTION public.delete_vendor(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_vendor(text) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.merge_vendors(text, text);

CREATE OR REPLACE FUNCTION public.merge_vendors(
  p_source text,
  p_target text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
  v_source text := nullif(btrim(coalesce(p_source, '')), '');
  v_target text := nullif(btrim(coalesce(p_target, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_src public.vendors%ROWTYPE;
  v_tgt public.vendors%ROWTYPE;
  v_ids text[];
  v_assess jsonb;
  v_moved integer := 0;
  v_block jsonb;
  v_msg text;
BEGIN
  IF v_uid IS NULL OR v_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'Only an admin can merge vendors'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_source IS NULL OR v_target IS NULL THEN
    RAISE EXCEPTION 'Choose a source vendor and a target vendor'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_source = v_target THEN
    RAISE EXCEPTION 'Source and target must be different vendors'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_src FROM public.vendors WHERE name = v_source FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source vendor was not found'
      USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v_tgt FROM public.vendors WHERE name = v_target FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target vendor was not found'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_src.is_protected THEN
    RAISE EXCEPTION 'Cannot merge away % — %', v_source, coalesce(v_src.protected_reason, 'it is used by the system')
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(array_agg(pl.id), '{}'::text[])
  INTO v_ids
  FROM public.product_lines pl
  WHERE pl.vendor = v_source;

  IF cardinality(v_ids) > 0 THEN
    v_assess := public.vendor_product_move_assessment(v_ids, v_target);

    IF (v_assess->>'requires_reason')::boolean
       AND (v_reason IS NULL OR char_length(v_reason) < 15) THEN
      RAISE EXCEPTION
        'Explain why (at least 15 characters). %',
        nullif(v_assess->>'protected_reasons_text', '')
        USING ERRCODE = 'check_violation';
    END IF;

    IF (v_assess->>'blocked')::boolean THEN
      FOR v_block IN SELECT * FROM jsonb_array_elements(v_assess->'blocks')
      LOOP
        IF v_block->>'code' = 'starlink_out_active' THEN
          IF (v_block->>'count')::int = 1 THEN
            v_msg := '1 kit is out on rental — return them first';
          ELSE
            v_msg := format('%s kits are out on rental — return them first', v_block->>'count');
          END IF;
          RAISE EXCEPTION '%', v_msg USING ERRCODE = 'check_violation';
        ELSIF v_block->>'code' = 'fortinet_open_requests' THEN
          IF (v_block->>'count')::int = 1 THEN
            RAISE EXCEPTION '1 open request uses this product'
              USING ERRCODE = 'check_violation';
          ELSE
            RAISE EXCEPTION '% open requests use this product', v_block->>'count'
              USING ERRCODE = 'check_violation';
          END IF;
        END IF;
      END LOOP;
      RAISE EXCEPTION 'This merge is blocked' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF v_tgt.is_protected AND (v_reason IS NULL OR char_length(v_reason) < 15) THEN
    RAISE EXCEPTION
      'Explain why (at least 15 characters). % — %',
      v_target, coalesce(v_tgt.protected_reason, 'it is used by the system')
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.audit_source', 'merge_vendors', true);
  PERFORM set_config(
    'app.audit_reason',
    coalesce(v_reason, format('merge %s into %s', v_source, v_target)),
    true
  );

  UPDATE public.product_lines
  SET vendor = v_target
  WHERE vendor = v_source;
  GET DIAGNOSTICS v_moved = ROW_COUNT;

  DELETE FROM public.vendors WHERE name = v_source;

  PERFORM set_config('app.audit_source', '', true);
  PERFORM set_config('app.audit_reason', '', true);

  RETURN jsonb_build_object(
    'source', v_source,
    'target', v_target,
    'products_moved', v_moved
  );
END;
$$;

COMMENT ON FUNCTION public.merge_vendors(text, text, text) IS
  'VN1b: merge vendors; source must not be protected; protected target needs reason ≥ 15.';
REVOKE ALL ON FUNCTION public.merge_vendors(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_vendors(text, text, text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Admin overview of vendors (counts for UI)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_vendors_overview()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role public.app_role := public.get_my_role();
BEGIN
  IF v_uid IS NULL OR v_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RAISE EXCEPTION 'Only an admin can view the vendors list'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(row_to_json(x)::jsonb ORDER BY x.name)
    FROM (
      SELECT
        v.name,
        v.is_protected,
        v.protected_reason,
        v.created_at,
        (
          SELECT count(*)::integer
          FROM public.product_lines pl
          WHERE pl.vendor = v.name
        ) AS product_count,
        (
          SELECT count(*)::integer
          FROM public.inventory_items i
          JOIN public.product_lines pl ON pl.id = i.product_id
          WHERE pl.vendor = v.name
            AND i.deleted_at IS NULL
            AND i.status = 'In Stock'
        ) AS in_stock_count
      FROM public.vendors v
    ) AS x
  ), '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION public.admin_vendors_overview() IS 'VN1: admin vendor list with product and in-stock counts.';
REVOKE ALL ON FUNCTION public.admin_vendors_overview() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_vendors_overview() TO authenticated, service_role;

-- admin_update_product_line already defaults blank vendor to General; FK enforces existence.
-- When editing to a new spelling, UI must add_vendor first.

NOTIFY pgrst, 'reload schema';
