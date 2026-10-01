-- 060: Database-backed reorder levels, low-stock settings, and canonical low-stock view.
-- Apply after 059_viewer_role_policies.sql. This migration intentionally performs no
-- localStorage data migration; the live values already match the database defaults.

BEGIN;

ALTER TABLE public.product_lines
  ADD COLUMN reorder_level integer NULL
    CHECK (reorder_level IS NULL OR reorder_level >= 0),
  ADD COLUMN is_active boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.product_lines.reorder_level IS
  'Per-product low-stock threshold. NULL uses app_settings.default_reorder_level.';
COMMENT ON COLUMN public.product_lines.is_active IS
  'Inactive products are excluded from low-stock alerts.';

CREATE TABLE public.app_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  default_reorder_level integer NOT NULL DEFAULT 2
    CHECK (default_reorder_level >= 0),
  low_stock_emails_enabled boolean NOT NULL DEFAULT false,
  low_stock_recipients text[] NOT NULL DEFAULT '{}'::text[],
  timezone text NOT NULL DEFAULT 'Africa/Harare',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.app_settings IS
  'Singleton workspace settings row. Client roles may not insert or delete rows.';
COMMENT ON COLUMN public.app_settings.low_stock_emails_enabled IS
  'Configuration only; no low-stock email sender exists yet.';

CREATE OR REPLACE FUNCTION public.validate_app_settings_recipients()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  recipient text;
BEGIN
  FOREACH recipient IN ARRAY NEW.low_stock_recipients LOOP
    IF recipient !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
      RAISE EXCEPTION 'Invalid low-stock recipient email: %', recipient
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_app_settings_updated_metadata()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_app_settings_recipients() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_app_settings_updated_metadata() FROM PUBLIC;

CREATE TRIGGER tr_app_settings_validate_recipients
  BEFORE INSERT OR UPDATE OF low_stock_recipients
  ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_app_settings_recipients();

CREATE TRIGGER tr_app_settings_updated_metadata
  BEFORE UPDATE
  ON public.app_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_app_settings_updated_metadata();

INSERT INTO public.app_settings (id)
VALUES (true);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff read app_settings"
  ON public.app_settings
  FOR SELECT
  TO authenticated
  USING (
    COALESCE(
      (SELECT public.get_my_role()) = ANY (
        ARRAY['admin', 'sales', 'accounts', 'technicians', 'viewer']::public.app_role[]
      ),
      false
    )
  );

CREATE POLICY "Admin update app_settings"
  ON public.app_settings
  FOR UPDATE
  TO authenticated
  USING (
    COALESCE((SELECT public.get_my_role()) = 'admin'::public.app_role, false)
  )
  WITH CHECK (
    COALESCE((SELECT public.get_my_role()) = 'admin'::public.app_role, false)
  );

REVOKE ALL ON TABLE public.app_settings FROM PUBLIC, anon;
REVOKE INSERT, DELETE ON TABLE public.app_settings FROM authenticated;
GRANT SELECT, UPDATE ON TABLE public.app_settings TO authenticated;

CREATE INDEX idx_inventory_items_live_in_stock_product
  ON public.inventory_items (product_id)
  WHERE deleted_at IS NULL AND status = 'In Stock';

CREATE VIEW public.low_stock_products
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
WHERE product.is_active;

COMMENT ON VIEW public.low_stock_products IS
  'Only low-stock definition: active products, live In Stock inventory, and effective reorder threshold.';

REVOKE ALL ON TABLE public.low_stock_products FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.low_stock_products TO authenticated;

DO $$
BEGIN
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
    RAISE EXCEPTION '060: low_stock_products must use security_invoker';
  END IF;
END;
$$;

COMMIT;
