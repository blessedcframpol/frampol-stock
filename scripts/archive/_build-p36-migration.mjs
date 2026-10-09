/**
 * Builds 20261009120000_p36_movement_payload_rules.sql from the live function dump.
 * Run: node scripts/archive/_build-p36-migration.mjs
 */
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const dir = path.dirname(fileURLToPath(import.meta.url))
const dump = fs.readFileSync(path.join(dir, "_apply_stock_movement_prod.sql"), "utf8")

const inject = `
  PERFORM public.validate_apply_stock_movement_payload(
    p_inventory_upserts,
    p_inventory_inserts,
    p_transactions
  );
`

if (!dump.includes("AS $function$\nDECLARE")) {
  throw new Error("unexpected dump shape")
}
if (dump.includes("validate_apply_stock_movement_payload")) {
  throw new Error("dump already contains validate call")
}

const patched = dump.replace(
  "AS $function$\nDECLARE",
  `AS $function$\nDECLARE`,
).replace(
  "AS $function$\nDECLARE",
  `AS $function$\nBEGIN${inject}  -- continue into original DECLARE block via nested block\n  DECLARE`,
)

// The above breaks DECLARE after BEGIN. Better inject after the outer BEGIN of the function body.
// Re-read: structure is AS $function$ \n DECLARE ... BEGIN ... END; \n $function$
const better = dump.replace(
  /(\$function\$\nDECLARE\n[\s\S]*?\nBEGIN\n)/,
  `$1${inject}`,
)

if (!better.includes("validate_apply_stock_movement_payload")) {
  throw new Error("inject failed")
}

const helpers = `-- P3.6: server rejects incomplete Transfer / Dispose / In-location / Sale-Rentals invoice payloads.
-- App checks are feedback only; this is the source of truth inside apply_stock_movement.
-- No BEGIN/COMMIT: rehearse-migration and apply paths wrap their own transactions.

CREATE OR REPLACE FUNCTION public.is_warehouse_location(p_location text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT btrim(coalesce(p_location, '')) IN ('Warehouse A', 'Warehouse B', 'Service Center');
$$;

COMMENT ON FUNCTION public.is_warehouse_location(text) IS
  'True for Warehouse A, Warehouse B, or Service Center.';

REVOKE ALL ON FUNCTION public.is_warehouse_location(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_warehouse_location(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.validate_apply_stock_movement_payload(
  p_inventory_upserts jsonb,
  p_inventory_inserts jsonb,
  p_transactions jsonb
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_type text;
  v_type_count integer;
  v_choice text;
  v_number text;
  v_reason text;
  v_problem text;
BEGIN
  IF p_transactions IS NULL
     OR jsonb_typeof(p_transactions) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_transactions) = 0 THEN
    RETURN;
  END IF;

  SELECT count(DISTINCT t.type)::integer
  INTO v_type_count
  FROM jsonb_to_recordset(p_transactions) AS t(type text);

  IF v_type_count <> 1 THEN
    RETURN;
  END IF;

  SELECT t.type INTO v_type
  FROM jsonb_to_recordset(p_transactions) AS t(type text)
  LIMIT 1;

  IF v_type = 'Transfer' AND EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_transactions) AS t(serial_number text, to_location text)
    LEFT JOIN LATERAL (
      SELECT item.location
      FROM public.inventory_items AS item
      WHERE item.serial_number = t.serial_number
        AND item.deleted_at IS NULL
      ORDER BY item.id
      LIMIT 1
    ) AS cur ON true
    WHERE nullif(btrim(coalesce(t.to_location, '')), '') IS NULL
       OR cur.location IS NULL
       OR btrim(t.to_location) IS NOT DISTINCT FROM btrim(coalesce(cur.location, ''))
  ) THEN
    RAISE EXCEPTION 'Transfer needs a destination different from the current location'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_type = 'Dispose'
     AND coalesce(current_setting('app.inspection_case', true), '') = ''
     AND EXISTS (
       SELECT 1
       FROM jsonb_to_recordset(p_transactions) AS t(disposal_reason text, authorised_by text)
       WHERE char_length(btrim(coalesce(t.disposal_reason, ''))) < 15
          OR nullif(btrim(coalesce(t.authorised_by, '')), '') IS NULL
          OR btrim(t.authorised_by) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR NOT EXISTS (
            SELECT 1
            FROM public.profiles AS profile
            WHERE profile.id = btrim(t.authorised_by)::uuid
              AND profile.role = 'admin'
              AND profile.active IS TRUE
          )
     ) THEN
    RAISE EXCEPTION 'Dispose needs a reason (at least 15 characters) and an authorising admin'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_type IN ('Inbound', 'POC Return', 'Rental Return', 'Sale Return', 'Decommissioned') THEN
    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(p_transactions) AS t(to_location text)
      WHERE NOT public.is_warehouse_location(t.to_location)
    ) THEN
      RAISE EXCEPTION 'In movements must use a warehouse location'
        USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(coalesce(p_inventory_upserts, '[]'::jsonb)) AS u(location text)
      WHERE NOT public.is_warehouse_location(u.location)
    ) OR EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(coalesce(p_inventory_inserts, '[]'::jsonb)) AS i(location text)
      WHERE NOT public.is_warehouse_location(i.location)
    ) THEN
      RAISE EXCEPTION 'In movements must use a warehouse location'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF v_type IN ('Sale', 'Rentals') THEN
    FOR v_choice, v_number, v_reason IN
      SELECT
        nullif(btrim(coalesce(t.metadata->>'invoice_choice', '')), ''),
        btrim(coalesce(t.invoice_number, '')),
        btrim(coalesce(t.metadata->>'invoice_reason', ''))
      FROM jsonb_to_recordset(p_transactions) AS t(invoice_number text, metadata jsonb)
    LOOP
      IF v_choice = 'number' THEN
        v_problem := public.real_invoice_number_problem(v_number);
        IF v_problem IS NOT NULL THEN
          RAISE EXCEPTION '%', v_problem
            USING ERRCODE = 'check_violation';
        END IF;
      ELSIF v_choice = 'pending' THEN
        IF v_number <> '' THEN
          RAISE EXCEPTION 'Invoice pending does not take a number'
            USING ERRCODE = 'check_violation';
        END IF;
      ELSIF v_choice = 'not_invoiced' THEN
        IF char_length(v_reason) < 15 THEN
          RAISE EXCEPTION '00000 needs a reason of at least 15 characters'
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        RAISE EXCEPTION 'Sale and Rentals need an invoice number, Invoice pending, or 00000 — not invoiced'
          USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.validate_apply_stock_movement_payload(jsonb, jsonb, jsonb) IS
  'P3.6 payload gates for Transfer, Dispose, In warehouses, and Sale/Rentals invoice choice.';

REVOKE ALL ON FUNCTION public.validate_apply_stock_movement_payload(jsonb, jsonb, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_apply_stock_movement_payload(jsonb, jsonb, jsonb)
  TO authenticated, service_role;

`

const footer = `
COMMENT ON FUNCTION public.apply_stock_movement(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) IS
  'Atomic stock movement. Runs P3.6 payload validation before writing.';

REVOKE ALL ON FUNCTION public.apply_stock_movement(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_stock_movement(jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  TO authenticated, service_role;
`

const out = helpers + "\n" + better.trim() + ";\n" + footer
const dest = path.join(dir, "../../supabase/migrations/20261009120000_p36_movement_payload_rules.sql")
fs.writeFileSync(dest, out)
console.log("wrote", dest, out.length, "chars")
