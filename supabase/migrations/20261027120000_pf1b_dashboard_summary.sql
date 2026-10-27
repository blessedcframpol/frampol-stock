-- PF1b: dashboard aggregates without downloading the inventory/transaction ledger.
-- Definitions match lib/inventory-products.inStockPoolCounts + lib/dashboard-metrics.

SET lock_timeout = '5s';

-- SECURITY INVOKER: inventory_items / active_transactions RLS applies as the caller.
-- (Same pattern as request_display_status / transaction_batch_page.)

CREATE OR REPLACE FUNCTION public.dashboard_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH tz AS (
    SELECT coalesce(
      nullif(btrim((SELECT timezone FROM public.app_settings WHERE id IS TRUE)), ''),
      'Africa/Harare'
    ) AS name
  ),
  today AS (
    SELECT (now() AT TIME ZONE (SELECT name FROM tz))::date AS d
  ),
  months AS (
    SELECT to_char(
      date_trunc('month', (SELECT d FROM today)) - (gs.n || ' months')::interval,
      'YYYY-MM'
    ) AS month_key,
    trim(to_char(
      date_trunc('month', (SELECT d FROM today)) - (gs.n || ' months')::interval,
      'Mon'
    )) AS month_label,
    gs.n AS ord
    FROM generate_series(5, 0, -1) AS gs(n)
  ),
  live AS (
    SELECT
      item.status,
      coalesce(nullif(btrim(item.stock_pool), ''), 'sale') AS pool,
      CASE
        WHEN nullif(btrim(pl.vendor), '') IS NULL THEN 'General'
        ELSE btrim(pl.vendor)
      END AS vendor_key
    FROM public.inventory_items AS item
    LEFT JOIN public.product_lines AS pl ON pl.id = item.product_id
    WHERE item.deleted_at IS NULL
  ),
  pools AS (
    SELECT
      count(*) FILTER (WHERE status = 'In Stock' AND pool = 'sale')::int AS in_stock_sale,
      count(*) FILTER (WHERE status = 'In Stock' AND pool = 'rental')::int AS in_stock_rental,
      count(*) FILTER (WHERE status = 'In Stock' AND pool = 'demo')::int AS in_stock_demo,
      count(*) FILTER (WHERE status = 'Sold')::int AS items_sold,
      count(*) FILTER (WHERE status = 'POC')::int AS poc_active
    FROM live
  ),
  in_stock_vendor AS (
    SELECT vendor_key AS vendor, count(*)::int AS units
    FROM live
    WHERE status = 'In Stock'
    GROUP BY vendor_key
  ),
  all_vendor AS (
    SELECT vendor_key AS vendor, count(*)::int AS units
    FROM live
    GROUP BY vendor_key
  ),
  sales AS (
    SELECT
      left(t.date, 7) AS month_key,
      count(*)::int AS units,
      count(*) FILTER (
        WHERE t.invoice_number = '00000'
          OR coalesce(t.metadata->>'not_invoiced_kind', '') = 'internal'
      )::int AS internal_units
    FROM public.active_transactions AS t
    WHERE t.type = 'Sale'
      AND left(t.date, 7) IN (SELECT month_key FROM months)
    GROUP BY left(t.date, 7)
  )
  SELECT jsonb_build_object(
    'in_stock_sale', pools.in_stock_sale,
    'in_stock_rental', pools.in_stock_rental,
    'in_stock_demo', pools.in_stock_demo,
    'items_sold', pools.items_sold,
    'poc_active', pools.poc_active,
    'in_stock_by_vendor', coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_object('vendor', v.vendor, 'units', v.units)
          ORDER BY v.units DESC, v.vendor ASC
        )
        FROM in_stock_vendor AS v
      ),
      '[]'::jsonb
    ),
    'all_units_by_vendor', coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_object('vendor', v.vendor, 'units', v.units)
          ORDER BY v.units DESC, v.vendor ASC
        )
        FROM all_vendor AS v
      ),
      '[]'::jsonb
    ),
    'monthly_sales', coalesce(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'month_key', m.month_key,
            'month', m.month_label,
            'units', coalesce(s.units, 0),
            'internal_units', coalesce(s.internal_units, 0),
            'internal_label', 'Internal'
          )
          ORDER BY m.ord DESC
        )
        FROM months AS m
        LEFT JOIN sales AS s ON s.month_key = m.month_key
      ),
      '[]'::jsonb
    )
  )
  FROM pools;
$$;

COMMENT ON FUNCTION public.dashboard_summary() IS
  'Dashboard stat cards + vendor charts + last-6-month sale units. Empty vendor → General. '
  'Sale units include 00000/internal (counted; internal_units + Internal label). SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.dashboard_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_summary() TO authenticated, service_role;
