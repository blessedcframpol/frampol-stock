-- The schema-specific default in 20261001125205 does not replace Postgres's
-- built-in GRANT EXECUTE ON FUNCTIONS TO PUBLIC. Anon inherits that grant.
-- This revokes it for functions postgres creates.

BEGIN;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM anon, public;

COMMIT;
