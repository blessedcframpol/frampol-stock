-- 066: anon cannot execute functions in public.
-- Default privileges were granting EXECUTE to anon on every new function.
-- REVOKE FROM PUBLIC does not remove that direct grant.
-- set_updated_at has no trigger and no caller (pg_depend only records the
-- function's own language and schema), so it is dropped.

BEGIN;

REVOKE ALL ON FUNCTION public.apply_stock_movement(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dispatched_page(integer, integer, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.guard_quick_scan_reversal_order() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.inventory_items_guard_status_transition() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.profile_display_labels(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reverse_quick_scan_batch(text, jsonb, jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_app_settings_updated_metadata() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transaction_batch_page(integer, integer, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.validate_app_settings_recipients() FROM PUBLIC, anon;

DROP FUNCTION public.set_updated_at();

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, public;

-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin was denied
-- (42501 permission denied to change default privileges). Migrations
-- create functions as postgres. The built-in PUBLIC grant is revoked
-- for that role in 20261001125632_revoke_function_public_default.sql.

COMMIT;
