-- Storage evaluates object SELECT (download / signed URL) as supabase_storage_admin.
-- get_my_role() was REVOKE'd from PUBLIC in 051, so those policies failed with
-- "Object not found" even when INSERT (running as authenticated) succeeded.

GRANT EXECUTE ON FUNCTION public.get_my_role() TO supabase_storage_admin;
GRANT EXECUTE ON FUNCTION public.get_my_role() TO authenticator;
