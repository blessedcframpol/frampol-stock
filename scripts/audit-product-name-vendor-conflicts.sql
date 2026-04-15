-- Run in Supabase SQL Editor on a database that still has inventory_items.name / vendor.
-- Lists product names (case/trim-insensitive) that appear under more than one normalized vendor.
--
-- Migration 032 does not block on this: it creates one product_lines row per name and picks a
-- canonical vendor (prefers any non-"General" vendor when both exist). All serials with that
-- name share the same product_id. Use this report for optional pre-migrate cleanup, or to
-- know which catalog rows may need a vendor tweak in product_lines after go-live.
--
-- Optional pre-migrate cleanup (legacy columns): align vendors before 032 if you want the
-- catalog to match your expectations without relying on the automatic rule.
--
--   UPDATE public.inventory_items
--   SET vendor = 'Starlink'
--   WHERE lower(trim(name)) = 'starlink standard kit v4'
--     AND coalesce(nullif(trim(vendor), ''), 'General') = 'General';

SELECT
  lower(trim(name)) AS name_key,
  array_agg(
    DISTINCT coalesce(nullif(trim(vendor), ''), 'General')
    ORDER BY coalesce(nullif(trim(vendor), ''), 'General')
  ) AS vendors,
  count(*)::bigint AS row_count
FROM public.inventory_items
GROUP BY lower(trim(name))
HAVING count(DISTINCT coalesce(nullif(trim(vendor), ''), 'General')) > 1
ORDER BY name_key;
