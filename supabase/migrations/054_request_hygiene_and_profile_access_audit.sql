-- Request hygiene: remove the audit verifier fixture, clear stale serviced_at,
-- and audit changes to profile role/active access.

BEGIN;

-- =============================================================================
-- 1. Remove the exact audit-verify fixture in FK-safe order
-- =============================================================================

DELETE FROM public.stock_request_events
WHERE request_id = 'a95a25eb-2edb-4baa-a1f6-1449a2bf316a'::uuid;

DELETE FROM public.stock_request_lines
WHERE request_id = 'a95a25eb-2edb-4baa-a1f6-1449a2bf316a'::uuid;

DELETE FROM public.stock_requests
WHERE id = 'a95a25eb-2edb-4baa-a1f6-1449a2bf316a'::uuid;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.inventory_items i
    JOIN public.product_lines p ON p.id = i.product_id
    WHERE p.product_name = '__audit_verify_product__'
  ) THEN
    RAISE EXCEPTION
      '054_request_hygiene: inventory_items still reference __audit_verify_product__';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stock_request_lines l
    JOIN public.product_lines p ON p.id = l.product_id
    WHERE p.product_name = '__audit_verify_product__'
  ) THEN
    RAISE EXCEPTION
      '054_request_hygiene: stock_request_lines still reference __audit_verify_product__';
  END IF;
END;
$$;

DELETE FROM public.product_lines
WHERE product_name = '__audit_verify_product__';

-- The client CLT-1774007295290-1pl6z68 (Reign Acre) is intentionally retained.

-- =============================================================================
-- 2. serviced_at follows the request lifecycle
-- =============================================================================

CREATE OR REPLACE FUNCTION public.tr_stock_requests_updated_at_and_side_effects()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();

  IF NEW.status = 'serviced'
    AND OLD.status IS DISTINCT FROM NEW.status
  THEN
    NEW.serviced_at := COALESCE(NEW.serviced_at, now());
  ELSIF OLD.status IN ('serviced')
    AND NEW.status NOT IN ('serviced', 'invoiced')
  THEN
    NEW.serviced_at := NULL;
  END IF;

  -- Reservation release remains in tr_stock_requests_guard_status_transition.
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tr_stock_requests_updated_at_and_side_effects() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_stock_requests_updated_at_and_side_effects() FROM anon, authenticated;

-- This changes serviced_at only. The status-change audit trigger returns early
-- because status is unchanged, so this backfill does not log request events.
UPDATE public.stock_requests
SET serviced_at = NULL
WHERE status NOT IN ('serviced', 'invoiced')
  AND serviced_at IS NOT NULL;

-- =============================================================================
-- 3. Immutable profile role/active audit
-- =============================================================================

CREATE TABLE public.profile_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  actor_id uuid NULL,
  from_role text,
  to_role text,
  from_active boolean,
  to_active boolean,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_profile_access_events_profile_created
  ON public.profile_access_events (profile_id, created_at);

COMMENT ON TABLE public.profile_access_events IS
  'Immutable audit log for initial profile access and subsequent role/active changes.';

ALTER TABLE public.profile_access_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.profile_access_events FROM PUBLIC;
REVOKE ALL ON TABLE public.profile_access_events FROM anon, authenticated;
GRANT SELECT ON TABLE public.profile_access_events TO authenticated;

CREATE POLICY profile_access_events_select_admin
  ON public.profile_access_events
  FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin');

-- No INSERT / UPDATE / DELETE policies or grants: clients can only read through
-- the admin SELECT policy. The trigger writes as its SECURITY DEFINER owner.

CREATE OR REPLACE FUNCTION public.tr_profiles_log_access_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.profile_access_events (
      profile_id,
      actor_id,
      from_role,
      to_role,
      from_active,
      to_active
    )
    VALUES (
      NEW.id,
      auth.uid(),
      NULL,
      NEW.role::text,
      NULL,
      NEW.active
    );
  ELSIF OLD.role IS DISTINCT FROM NEW.role
    OR OLD.active IS DISTINCT FROM NEW.active
  THEN
    INSERT INTO public.profile_access_events (
      profile_id,
      actor_id,
      from_role,
      to_role,
      from_active,
      to_active
    )
    VALUES (
      NEW.id,
      auth.uid(),
      OLD.role::text,
      NEW.role::text,
      OLD.active,
      NEW.active
    );
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tr_profiles_log_access_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_profiles_log_access_change() FROM anon, authenticated;

CREATE TRIGGER profiles_log_access_change
  AFTER INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_profiles_log_access_change();

COMMIT;
