-- VN1 follow-up: production default privileges left authenticated write grants on vendors.
-- RLS has no write policies (writes go through admin RPCs), so revoke to match the HY1 rule.
SET lock_timeout = '5s';

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.vendors FROM authenticated, anon;
