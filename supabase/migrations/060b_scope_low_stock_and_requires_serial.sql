-- 060b: Scope low_stock_products to product lines that have been stocked, and
-- flag stocked lines that the serviced guard currently skips.
-- Apply after 060_settings_db.sql. Does not edit 060. Does not delete product lines.
--
-- requires_serial is not Starlink-only after this update. The intake form does
-- not read the flag. Fulfillment still shows the serial picker on every line.
-- The flag does change the request-detail serial rule, the billing caption,
-- the fulfill "Mark serviced" block, and the invoice gate.

BEGIN;

CREATE OR REPLACE VIEW public.low_stock_products
WITH (security_invoker = true)
AS
SELECT
  product.id AS product_id,
  product.product_name,
  product.vendor,
  COALESCE(stock.in_stock_count, 0)::integer AS in_stock_count,
  COALESCE(product.reorder_level, settings.default_reorder_level)::integer
    AS effective_reorder_level,
  COALESCE(stock.in_stock_count, 0)
    <= COALESCE(product.reorder_level, settings.default_reorder_level)
    AS is_low
FROM public.product_lines AS product
CROSS JOIN public.app_settings AS settings
LEFT JOIN (
  SELECT
    item.product_id,
    count(*)::integer AS in_stock_count
  FROM public.inventory_items AS item
  WHERE item.status = 'In Stock'
    AND item.deleted_at IS NULL
  GROUP BY item.product_id
) AS stock
  ON stock.product_id = product.id
WHERE product.is_active
  AND EXISTS (
    SELECT 1
    FROM public.inventory_items AS held
    WHERE held.product_id = product.id
      AND held.deleted_at IS NULL
  );

COMMENT ON VIEW public.low_stock_products IS
  'Only low-stock definition: active products with at least one non-deleted inventory row, live In Stock count, and effective reorder threshold. Sold-out products stay visible. Never-stocked catalogue lines do not.';

REVOKE ALL ON TABLE public.low_stock_products FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.low_stock_products TO authenticated;

-- Stocked lines whose requires_serial = false lets a request reach serviced
-- with no serials. These 25 ids each had at least one non-deleted inventory
-- item when this migration was written. Lines with no live inventory are left
-- unchanged. No product line is deleted.
DO $$
DECLARE
  expected text[] := ARRAY[
    'PL-022d1903026b45ceaf4293f3ccfd7bb0', -- 48V PoE Injecter - 15W
    'PL-382a23ef01f84c5aa0a5ac1dafc02e20', -- FS-224D-FPOE
    'PL-3911577333cdb3a8ded2c3b46d30e04a', -- FortiGate 50G
    'PL-3d010ae61fcbf87f74313f59958a2d4b', -- enterprise kits
    'PL-4093359d6aac85e92ef72e6793182d7b', -- FortiSwitch 108f
    'PL-4670652d03a34ef8a8dcd5d52b085864', -- U6 Mesh Pro
    'PL-49fbaf666e3ba8f49891f3bc29a42257', -- Fortigate 70G
    'PL-4b57780789714ec19148e06854b767da', -- PoE+ Adapter - 30W
    'PL-5323a43c586a108190315b01a593643d', -- Fortigate 30G
    'PL-608d6ede67a2675a66536c9994077cac', -- Unifi Switch Ultra 60W
    'PL-72da374e9c548fa784f527308a28ede8', -- Fortiswitch 224d fpoe
    'PL-92fd8e2e69abc6088d3e62d9f514dd19', -- Dell XPS 15 9530
    'PL-ab35894cb263dcadce66d81f370aca17', -- Standard Kits
    'PL-bb6691a15a2c422693f700e54f19e780', -- Ruijie RG-EG106GW(T) - Router
    'PL-c3f944b12888987870f330129f5cf6f2', -- Unifi Cloud Gateway Ultra (UCG)
    'PL-c5ed17b5fe1d4d31a89f51da5a5d3422', -- Fortigate 120G
    'PL-c6fc174cbbea0bb1490dbe541c42705f', -- Ruijie 5 Port Router - RG-EG305
    'PL-c94aeb13f308762c16bf17149913e35c', -- FortiSwitch 124f
    'PL-d7a9e00072714a8db99a511b40eebe7d', -- Cudy Router WR1300
    'PL-d9008da2d314433983be1992b28d0e7d', -- U7 Long-Range AP
    'PL-e30f2f5bd84044ad8e23f992b5b0f553', -- RG-EG105G-P-V3
    'PL-eeebede5d0501e652f63e9c52388c6c0', -- 48 port POE
    'PL-f35ac4d643594a46b6f3c888a97dd240', -- Unifi U6+
    'PL-f3ee0d0dc1264eb192146a22d20a6f45', -- Starlink Standard Kit v4(Rental)
    'PL-f5386c813b2649e78e3ff3aaf90adccc'  -- FortiAP-231F
  ];
  actual text[];
BEGIN
  SELECT coalesce(array_agg(product.id ORDER BY product.id), '{}'::text[])
  INTO actual
  FROM public.product_lines AS product
  WHERE NOT product.requires_serial
    AND EXISTS (
      SELECT 1
      FROM public.inventory_items AS item
      WHERE item.product_id = product.id
        AND item.deleted_at IS NULL
    );

  IF actual IS DISTINCT FROM (
    SELECT coalesce(array_agg(id ORDER BY id), '{}'::text[])
    FROM unnest(expected) AS id
  ) THEN
    RAISE EXCEPTION
      '060b: stocked lines with requires_serial = false changed before apply. Found %',
      actual;
  END IF;
END;
$$;

UPDATE public.product_lines
SET requires_serial = true
WHERE id IN (
  'PL-022d1903026b45ceaf4293f3ccfd7bb0',
  'PL-382a23ef01f84c5aa0a5ac1dafc02e20',
  'PL-3911577333cdb3a8ded2c3b46d30e04a',
  'PL-3d010ae61fcbf87f74313f59958a2d4b',
  'PL-4093359d6aac85e92ef72e6793182d7b',
  'PL-4670652d03a34ef8a8dcd5d52b085864',
  'PL-49fbaf666e3ba8f49891f3bc29a42257',
  'PL-4b57780789714ec19148e06854b767da',
  'PL-5323a43c586a108190315b01a593643d',
  'PL-608d6ede67a2675a66536c9994077cac',
  'PL-72da374e9c548fa784f527308a28ede8',
  'PL-92fd8e2e69abc6088d3e62d9f514dd19',
  'PL-ab35894cb263dcadce66d81f370aca17',
  'PL-bb6691a15a2c422693f700e54f19e780',
  'PL-c3f944b12888987870f330129f5cf6f2',
  'PL-c5ed17b5fe1d4d31a89f51da5a5d3422',
  'PL-c6fc174cbbea0bb1490dbe541c42705f',
  'PL-c94aeb13f308762c16bf17149913e35c',
  'PL-d7a9e00072714a8db99a511b40eebe7d',
  'PL-d9008da2d314433983be1992b28d0e7d',
  'PL-e30f2f5bd84044ad8e23f992b5b0f553',
  'PL-eeebede5d0501e652f63e9c52388c6c0',
  'PL-f35ac4d643594a46b6f3c888a97dd240',
  'PL-f3ee0d0dc1264eb192146a22d20a6f45',
  'PL-f5386c813b2649e78e3ff3aaf90adccc'
)
AND NOT requires_serial;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.product_lines AS product
    WHERE NOT product.requires_serial
      AND EXISTS (
        SELECT 1
        FROM public.inventory_items AS item
        WHERE item.product_id = product.id
          AND item.deleted_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION
      '060b: a product line with non-deleted inventory still has requires_serial = false';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = 'low_stock_products'
      AND relation.relkind = 'v'
      AND relation.reloptions @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION '060b: low_stock_products must use security_invoker';
  END IF;
END;
$$;

COMMIT;
