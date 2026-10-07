-- T3 fixture sweep (DRAFT — do not apply until reviewed).
-- Source of truth: scripts/t3-fixture-sweep.json (status=remove only; HOLD omitted).
-- Reign Acre client CLT-1774007295290-1pl6z68 is NOT deleted.
-- Audit actor: Blessed admin ccf0717b-0323-49c6-a6c3-59d45cc849f2.
-- Posted-transaction DELETE uses SET LOCAL app.t3_fixture_sweep=1 inside this
-- migration only; the escape is removed before COMMIT by restoring the lock fn.

BEGIN;

SELECT set_config('request.jwt.claim.sub', 'ccf0717b-0323-49c6-a6c3-59d45cc849f2', true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"ccf0717b-0323-49c6-a6c3-59d45cc849f2","role":"authenticated"}',
  true
);
SELECT set_config('app.audit_source', 'maintenance', true);

CREATE OR REPLACE FUNCTION public.transactions_reject_posted_change()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_correction text := nullif(current_setting('app.transaction_correction', true), '');
  v_invoice_only boolean;
  v_sweep text := nullif(current_setting('app.t3_fixture_sweep', true), '');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF v_sweep = '1' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'transactions: posted rows cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_invoice_only :=
    v_correction = 'invoice_number'
    AND OLD.invoice_number IS DISTINCT FROM NEW.invoice_number
    AND OLD.type IS NOT DISTINCT FROM NEW.type
    AND OLD.date IS NOT DISTINCT FROM NEW.date
    AND OLD.client IS NOT DISTINCT FROM NEW.client
    AND OLD.client_id IS NOT DISTINCT FROM NEW.client_id
    AND OLD.item_name IS NOT DISTINCT FROM NEW.item_name
    AND OLD.serial_number IS NOT DISTINCT FROM NEW.serial_number
    AND OLD.from_location IS NOT DISTINCT FROM NEW.from_location
    AND OLD.to_location IS NOT DISTINCT FROM NEW.to_location
    AND OLD.batch_id IS NOT DISTINCT FROM NEW.batch_id;

  IF NOT v_invoice_only THEN
    RAISE EXCEPTION 'transactions: posted rows cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$fn$;

SELECT set_config('app.t3_fixture_sweep', '1', true);

-- 1. batch_invoice_events
SELECT set_config('app.audit_reason', 'T3 fixture sweep 065', true);
DELETE FROM public.batch_invoice_events
WHERE id IN (
  '0bb260d1-ded6-49e3-8fce-442a85f84233',
  '1cb6147f-c4c8-4708-a65f-bf637095bba6',
  '3cbbf7ed-1e7a-4e51-b8c5-833341cc48c6'
);

-- 2. batch_invoices
SELECT set_config('app.audit_reason', 'T3 fixture sweep 065', true);
DELETE FROM public.batch_invoices
WHERE batch_id IN (
  'TXN-verify-065-ambig',
  'TXN-verify-065-dangle',
  'TXN-verify-065-substr'
);

-- 3. holding_extensions
SELECT set_config('app.audit_reason', 'T3 fixture sweep p33b', true);
DELETE FROM public.holding_extensions
WHERE id IN (
  '5d726feb-a353-474b-bb96-40d47bc1dd67'
);

-- 4. transactions
SELECT set_config('app.audit_reason', 'T3 fixture sweep 061', true);
DELETE FROM public.transactions
WHERE id IN (
  'txn-verify-061-late',
  'txn-verify-061-write',
  'txn-verify-061-order-early',
  'txn-verify-061-order-late',
  'txn-verify-061-reversal'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 065', true);
DELETE FROM public.transactions
WHERE id IN (
  'TXN-verify-065-substr',
  'TXN-verify-065-ambig',
  'TXN-verify-065-dangle',
  'TXN-verify-065-poc',
  'TXN-verify-065-return'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 066', true);
DELETE FROM public.transactions
WHERE id IN (
  'verify-066-txn-early',
  'verify-066-txn-later',
  'verify-066-txn-move',
  'TXN-REV-1791294300823-1'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 067', true);
DELETE FROM public.transactions
WHERE id IN (
  'verify-067-inbound',
  'verify-067-sale'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 068', true);
DELETE FROM public.transactions
WHERE id IN (
  'TXN-I2B068-2',
  'TXN-REV-1791294727403-1',
  'TXN-I2B068-5',
  'TXN-I2B068-7',
  'TXN-REV-1791294729882-1',
  'TXN-I2B068-10',
  'TXN-I2B068-12',
  'TXN-REV-1791294732133-1',
  'TXN-I2B068-15',
  'TXN-I2B068-17'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 069', true);
DELETE FROM public.transactions
WHERE id IN (
  'TXN-R3069-2',
  'TXN-REV-1791294741239-1',
  'TXN-R3069-5',
  'TXN-R3069-7',
  'TXN-REV-1791294744168-1',
  'TXN-R3069-10',
  'TXN-R3069-12',
  'TXN-REV-1791294747095-1',
  'TXN-R3069-15',
  'TXN-R3069-17',
  'TXN-REV-1791294750020-1',
  'TXN-R3069-20',
  'TXN-R3069-22',
  'TXN-REV-1791294752950-1',
  'TXN-R3069-25',
  'TXN-R3069-27',
  'TXN-REV-1791294755877-1',
  'TXN-R3069-30',
  'TXN-R3069-32',
  'TXN-REV-1791294758810-1',
  'TXN-R3069-35',
  'TXN-R3069-37',
  'TXN-R3069-39',
  'TXN-REV-1791294763207-1',
  'TXN-R3069-42',
  'TXN-R3069-44',
  'TXN-R3069-46',
  'TXN-REV-1791294766581-1',
  'TXN-R3069-49',
  'TXN-R3069-51',
  'TXN-R3069-53',
  'TXN-REV-1791294769926-1',
  'TXN-R3069-56',
  'TXN-R3069-58',
  'TXN-R3069-60',
  'TXN-REV-1791294773286-1',
  'TXN-R3069-63',
  'TXN-R3069-65',
  'TXN-R3069-67',
  'TXN-INSP-1791294776837',
  'TXN-REV-1791294777891-1',
  'TXN-R3069-70',
  'TXN-R3069-72',
  'TXN-R3069-74',
  'TXN-INSP-1791294781444',
  'TXN-REV-1791294782497-1',
  'TXN-R3069-77',
  'TXN-REV-1791294785424-1',
  'TXN-R3069-80',
  'TXN-R3069-82',
  'TXN-R3069-84',
  'TXN-REV-1791294788997-1',
  'TXN-R3069-87',
  'TXN-R3069-89',
  'TXN-R3069-91',
  'TXN-REV-1791294791523-1',
  'TXN-R3069-94',
  'TXN-R3069-96',
  'TXN-REV-1791294793626-1',
  'TXN-R3069-99'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 070', true);
DELETE FROM public.transactions
WHERE id IN (
  'TXN-E1070-2',
  'TXN-E1070-4',
  'TXN-E1070-7',
  'TXN-E1070-9',
  'TXN-E1070-11'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 071', true);
DELETE FROM public.transactions
WHERE id IN (
  'TXN-P1071-2',
  'TXN-P1071-5'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 072', true);
DELETE FROM public.transactions
WHERE id IN (
  'TXN-P1072-2',
  'TXN-P1072-5',
  'TXN-P1072-8',
  'TXN-P1072-12',
  'TXN-P1072-14',
  'TXN-REV-1791295002941-1'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 073', true);
DELETE FROM public.transactions
WHERE id IN (
  'TXN-K1073-2',
  'TXN-K1073-4',
  'TXN-K1073-9',
  'TXN-K1073-11',
  'TXN-K1073-13',
  'TXN-K1073-16',
  'TXN-K1073-18',
  'TXN-K1073-20',
  'TXN-K1073-23',
  'TXN-K1073-29',
  'TXN-K1073-31',
  'TXN-K1073-33',
  'TXN-INSP-1791295018290',
  'TXN-INSP-1791295018906',
  'TXN-K1073-36',
  'TXN-K1073-38',
  'TXN-K1073-40',
  'TXN-INSP-1791295020751',
  'TXN-K1073-43',
  'TXN-K1073-45',
  'TXN-K1073-47',
  'TXN-INSP-1791295022600',
  'TXN-K1073-50',
  'TXN-K1073-52',
  'TXN-K1073-54',
  'TXN-INSP-1791295024443',
  'TXN-REV-1791295024866-1'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 074', true);
DELETE FROM public.transactions
WHERE id IN (
  'TXN-RS1074-2',
  'TXN-RS1074-4',
  'TXN-RS1074-12',
  'TXN-REV-1791295039222-1',
  'TXN-RS1074-15'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 075', true);
DELETE FROM public.transactions
WHERE id IN (
  'TXN-INV075-2',
  'TXN-INV075-5',
  'TXN-INV075-8',
  'TXN-INV075-11',
  'TXN-INV075-14',
  'TXN-INV075-17',
  'TXN-INV075-20',
  'TXN-INV075-23',
  'TXN-INV075-25',
  'TXN-INV075-27',
  'TXN-INV075-29',
  'TXN-INV075-41'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 076', true);
DELETE FROM public.transactions
WHERE id IN (
  'TXN-OB1076-2',
  'TXN-OB1076-4',
  'TXN-OB1076-7',
  'TXN-OB1076-9',
  'TXN-OB1076-12',
  'TXN-OB1076-14',
  'TXN-OB1076-17',
  'TXN-OB1076-19',
  'TXN-OB1076-21',
  'TXN-OB1076-24',
  'TXN-OB1076-26',
  'TXN-OB1076-29',
  'TXN-OB1076-31',
  'TXN-83609796f8ad4e4399dc8b5f175cb804',
  'TXN-b83f90e2828549b89525f242d69960a1',
  'TXN-67af294fceda499db41d5d3bcdce3670',
  'TXN-cc3e4be1f2c14fcfb6eaa8bcaa072289',
  'TXN-34db247d11bc458ea62ce5b6fd8e3185',
  'TXN-REV-1791295080997-1',
  'TXN-REV-1791295081228-1',
  'TXN-REV-1791295081446-1',
  'TXN-REV-1791295081666-1',
  'TXN-REV-1791295081885-1'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 077', true);
DELETE FROM public.transactions
WHERE id IN (
  'TXN-H1077-2',
  'TXN-H1077-4',
  'TXN-REV-1791295093329-1',
  'TXN-H1077-6',
  'TXN-H1077-8',
  'TXN-H1077-10',
  'TXN-H1077-12',
  'TXN-INSP-1791295096310',
  'TXN-H1077-14',
  'TXN-H1077-16',
  'TXN-H1077-19'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 078', true);
DELETE FROM public.transactions
WHERE id IN (
  'TXN-RR1078-2',
  'TXN-RR1078-5',
  'TXN-INSP-1791295109861',
  'TXN-RR1078-8',
  'TXN-INSP-1791295110492',
  'TXN-RR1078-11',
  'TXN-INSP-1791295111124',
  'TXN-RR1078-14',
  'TXN-INSP-1791295111753',
  'TXN-RR1078-17',
  'TXN-RR1078-20',
  'TXN-INSP-1791295113414',
  'TXN-RR1078-23',
  'TXN-RR1078-25',
  'TXN-RR1078-28',
  'TXN-RR1078-30',
  'TXN-RR1078-32'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep p33b', true);
DELETE FROM public.transactions
WHERE id IN (
  'txn-VERIFY-P33B-SALE-1791295207307',
  'txn-Sale-VERIFY-P33B-STOCK-1791295211975',
  'txn-Remediation Loaner Issue-VERIFY-P33B-LOAN-1791295211975',
  'txn-Sale Return-VERIFY-P33B-LOAN-1791295211975',
  'txn-Transfer-VERIFY-P33B-XFER-POC-1791295211975',
  'txn-Transfer-VERIFY-P33B-XFER-RENT-1791295211975'
);

-- 5. inventory_items
SELECT set_config('app.audit_reason', 'T3 fixture sweep 066', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'verify-066-item-status',
  'verify-066-item-move'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 067', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'verify-067-item'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 068', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'ITEM-I2B068-1',
  'ITEM-I2B068-4',
  'ITEM-I2B068-9',
  'ITEM-I2B068-14'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 069', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'ITEM-R3069-1',
  'ITEM-R3069-4',
  'ITEM-R3069-9',
  'ITEM-R3069-14',
  'ITEM-R3069-19',
  'ITEM-R3069-24',
  'ITEM-R3069-29',
  'ITEM-R3069-34',
  'ITEM-R3069-55',
  'ITEM-R3069-41',
  'ITEM-R3069-48',
  'ITEM-R3069-62',
  'ITEM-R3069-69',
  'ITEM-R3069-76',
  'ITEM-R3069-79',
  'ITEM-R3069-86',
  'ITEM-R3069-93',
  'ITEM-R3069-98'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 070', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'ITEM-E1070-6',
  'ITEM-E1070-1'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 071', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'ITEM-P1071-4',
  'ITEM-P1071-1'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 072', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'ITEM-P1072-4',
  'ITEM-P1072-7',
  'ITEM-P1072-1'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 073', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'ITEM-K1073-1',
  'ITEM-K1073-22',
  'ITEM-K1073-28',
  'ITEM-K1073-8',
  'ITEM-K1073-15',
  'ITEM-K1073-35',
  'ITEM-K1073-42',
  'ITEM-K1073-49'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 074', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'ITEM-RS1074-1',
  'ITEM-RS1074-14',
  'ITEM-RS1074-19'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 075', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'ITEM-INV075-13',
  'ITEM-INV075-16',
  'ITEM-INV075-19',
  'ITEM-INV075-22',
  'ITEM-INV075-1',
  'ITEM-INV075-4',
  'ITEM-INV075-7',
  'ITEM-INV075-10'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 076', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'ITEM-OB1076-16',
  'ITEM-OB1076-1',
  'ITEM-OB1076-6',
  'ITEM-OB1076-11',
  'ITEM-OB1076-23',
  'ITEM-OB1076-28'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 077', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'ITEM-H1077-1',
  'ITEM-H1077-18'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 078', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'ITEM-RR1078-19',
  'ITEM-RR1078-1',
  'ITEM-RR1078-4',
  'ITEM-RR1078-7',
  'ITEM-RR1078-10',
  'ITEM-RR1078-13',
  'ITEM-RR1078-16',
  'ITEM-RR1078-22',
  'ITEM-RR1078-27'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep p33b', true);
DELETE FROM public.inventory_items
WHERE id IN (
  'item-VERIFY-P33B-SALE-1791295207307',
  'item-VERIFY-P33B-EXT-1791295207307',
  'item-VERIFY-P33B-MAINT-1791295211975',
  'item-VERIFY-P33B-STOCK-1791295211975',
  'item-VERIFY-P33B-LOAN-1791295211975',
  'item-VERIFY-P33B-XFER-POC-1791295211975',
  'item-VERIFY-P33B-XFER-RENT-1791295211975'
);

-- 6. fixture clients (not Reign Acre)
SELECT set_config('app.audit_reason', 'T3 fixture sweep 065', true);
DELETE FROM public.clients
WHERE id IN (
  'CLT-verify-065-acme',
  'CLT-verify-065-owner',
  'CLT-verify-065-text',
  'CLT-verify-065-twin-a',
  'CLT-verify-065-twin-b'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 077', true);
DELETE FROM public.clients
WHERE id IN (
  'CLT-H1077'
);

SELECT set_config('app.audit_reason', 'T3 fixture sweep 078', true);
DELETE FROM public.clients
WHERE id IN (
  'CLT-RR1078-NONE',
  'CLT-RR1078-SITE'
);

-- 7. Keep readable labels for deleted test users in the audit view, then
--    delete profiles / auth only after every fixture business row is gone.
CREATE TABLE IF NOT EXISTS public.deleted_users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text,
  role text,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  deleted_by uuid,
  reason text
);

COMMENT ON TABLE public.deleted_users IS
  'Labels for users removed from auth/profiles so audit_log_read can still show who acted.';

REVOKE ALL ON public.deleted_users FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.deleted_users TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.audit_log_read(
  p_table text DEFAULT NULL,
  p_row text DEFAULT NULL,
  p_user text DEFAULT NULL,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $read$
DECLARE
  v_tz text;
  v_user text := nullif(btrim(coalesce(p_user, '')), '');
BEGIN
  IF coalesce(public.get_my_role()::text, '') <> 'admin' THEN
    RAISE EXCEPTION 'audit_log_read: admin only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT coalesce(nullif(btrim(timezone), ''), 'Africa/Harare')
  INTO v_tz
  FROM public.app_settings
  WHERE id IS TRUE;
  v_tz := coalesce(v_tz, 'Africa/Harare');

  RETURN (
    SELECT coalesce(jsonb_agg(to_jsonb(entry) ORDER BY entry.at DESC, entry.id DESC), '[]'::jsonb)
    FROM (
      SELECT
        log.id,
        log.table_name,
        log.row_id,
        log.action,
        log.changed,
        log.actor,
        coalesce(
          nullif(btrim(profile.display_name), ''),
          profile.email,
          nullif(btrim(gone.display_name), ''),
          gone.email
        ) AS actor_name,
        log.source,
        log.reason,
        log.at,
        log.transaction_id
      FROM public.audit_log AS log
      LEFT JOIN public.profiles AS profile ON profile.id::text = log.actor
      LEFT JOIN public.deleted_users AS gone ON gone.id::text = log.actor
      WHERE (nullif(btrim(coalesce(p_table, '')), '') IS NULL OR log.table_name = btrim(p_table))
        AND (nullif(btrim(coalesce(p_row, '')), '') IS NULL OR log.row_id = btrim(p_row))
        AND (
          v_user IS NULL
          OR log.actor = v_user
          OR profile.display_name ILIKE '%' || v_user || '%'
          OR profile.email ILIKE '%' || v_user || '%'
          OR gone.display_name ILIKE '%' || v_user || '%'
          OR gone.email ILIKE '%' || v_user || '%'
        )
        AND (p_from IS NULL OR (log.at AT TIME ZONE v_tz)::date >= p_from)
        AND (p_to IS NULL OR (log.at AT TIME ZONE v_tz)::date <= p_to)
      ORDER BY log.at DESC, log.id DESC
      LIMIT 500
    ) AS entry
  );
END;
$read$;

SELECT set_config('app.audit_reason', 'T3 fixture sweep users', true);

INSERT INTO public.deleted_users (id, email, display_name, role, deleted_by, reason)
SELECT
  p.id,
  p.email,
  coalesce(nullif(btrim(p.display_name), ''), p.email),
  p.role::text,
  'ccf0717b-0323-49c6-a6c3-59d45cc849f2'::uuid,
  'T3 fixture sweep users'
FROM public.profiles AS p
WHERE p.id IN (
  '40166109-6f51-45e1-a93c-77c3e8d8efa7',
  '79aba17d-b257-4d93-b4eb-b5078b596972',
  '8777dcbf-81d0-4a7b-9e9f-83c5767375d2',
  '43e2d787-357f-4a54-b852-07a0708e0c2a',
  'a9eebe1c-e094-4d94-a239-13a3a5a3f83a',
  'ad4cf7d9-8c8c-4506-9d6b-e6ff99c0ebb9',
  '5be29eb5-e557-41ba-8464-9097989c5804',
  '77d80b07-d4a0-4776-a730-9094eb56bc20',
  '638f3cda-cd9a-4fc0-b636-d9b1160f144e',
  'c270ccc8-a250-4c2b-ba26-d19cee8097bc',
  'e72385a4-07cc-4752-aa2d-328a45dc3dd6',
  '221c472f-7e02-4808-8640-1f96954b4a99',
  '9c04072f-2cae-4632-98e3-13dce2934f16',
  'ff57eebc-1bff-4e07-bdeb-903ed31de63a',
  'b3986e93-c004-4df4-af9a-3a2c99e38ec2',
  '25fa6f29-5dc7-4b8a-afd2-c3aad9d61863',
  'f46ae76b-c834-47e5-95e1-dd0c74b20643',
  '38bfb3a7-fe3e-40e6-8c69-b282cb2622ab',
  '6213b633-10ca-48ef-9368-791d1984d389',
  '251275cc-891b-4e04-b532-2dd43164b91b',
  '53fe9692-0676-4c2c-a504-f4989dd8b36f',
  'da6947f5-688a-47d3-875c-de5031f6caa8',
  'beb9ffb4-1251-4914-9503-c1394bed5f56',
  'f5a02394-5392-4d6a-83a4-fd281b3a7ae0',
  'd985b328-c07a-467a-a968-1f540e7f56f0',
  'ee45f869-7427-4573-8403-4b06d92d06ba',
  '1eca71e8-77a9-4407-ab7e-989df11b7102',
  '5449b6ce-1dda-49fa-8bb8-b9bcd1b7d819',
  '76ef1ebc-f541-4289-9d1f-e88a63c13c6e',
  '973a130d-f262-412f-8cd6-c260481e4508',
  'e834b596-327e-4a7e-bb68-53e61e473c4a',
  '2a43ebff-a27c-4ccb-8e17-2d6fa4f7938b',
  'b65e9f22-7436-4d12-82a2-a3fde5fe87a4',
  '52a6bfe1-fe8a-416d-a4d8-afc94418e18d',
  '17572a3c-eabf-48e3-b722-8099c89a425d',
  '9ef3adbb-eee4-42f4-acfe-e8501e604cfd',
  '18156b75-3c17-4ed7-911d-a4ed928d4543'
)
ON CONFLICT (id) DO UPDATE
SET email = EXCLUDED.email,
    display_name = EXCLUDED.display_name,
    role = EXCLUDED.role,
    deleted_at = now(),
    deleted_by = EXCLUDED.deleted_by,
    reason = EXCLUDED.reason;

DELETE FROM public.profiles
WHERE id IN (
  '40166109-6f51-45e1-a93c-77c3e8d8efa7',
  '79aba17d-b257-4d93-b4eb-b5078b596972',
  '8777dcbf-81d0-4a7b-9e9f-83c5767375d2',
  '43e2d787-357f-4a54-b852-07a0708e0c2a',
  'a9eebe1c-e094-4d94-a239-13a3a5a3f83a',
  'ad4cf7d9-8c8c-4506-9d6b-e6ff99c0ebb9',
  '5be29eb5-e557-41ba-8464-9097989c5804',
  '77d80b07-d4a0-4776-a730-9094eb56bc20',
  '638f3cda-cd9a-4fc0-b636-d9b1160f144e',
  'c270ccc8-a250-4c2b-ba26-d19cee8097bc',
  'e72385a4-07cc-4752-aa2d-328a45dc3dd6',
  '221c472f-7e02-4808-8640-1f96954b4a99',
  '9c04072f-2cae-4632-98e3-13dce2934f16',
  'ff57eebc-1bff-4e07-bdeb-903ed31de63a',
  'b3986e93-c004-4df4-af9a-3a2c99e38ec2',
  '25fa6f29-5dc7-4b8a-afd2-c3aad9d61863',
  'f46ae76b-c834-47e5-95e1-dd0c74b20643',
  '38bfb3a7-fe3e-40e6-8c69-b282cb2622ab',
  '6213b633-10ca-48ef-9368-791d1984d389',
  '251275cc-891b-4e04-b532-2dd43164b91b',
  '53fe9692-0676-4c2c-a504-f4989dd8b36f',
  'da6947f5-688a-47d3-875c-de5031f6caa8',
  'beb9ffb4-1251-4914-9503-c1394bed5f56',
  'f5a02394-5392-4d6a-83a4-fd281b3a7ae0',
  'd985b328-c07a-467a-a968-1f540e7f56f0',
  'ee45f869-7427-4573-8403-4b06d92d06ba',
  '1eca71e8-77a9-4407-ab7e-989df11b7102',
  '5449b6ce-1dda-49fa-8bb8-b9bcd1b7d819',
  '76ef1ebc-f541-4289-9d1f-e88a63c13c6e',
  '973a130d-f262-412f-8cd6-c260481e4508',
  'e834b596-327e-4a7e-bb68-53e61e473c4a',
  '2a43ebff-a27c-4ccb-8e17-2d6fa4f7938b',
  'b65e9f22-7436-4d12-82a2-a3fde5fe87a4',
  '52a6bfe1-fe8a-416d-a4d8-afc94418e18d',
  '17572a3c-eabf-48e3-b722-8099c89a425d',
  '9ef3adbb-eee4-42f4-acfe-e8501e604cfd',
  '18156b75-3c17-4ed7-911d-a4ed928d4543'
);

DELETE FROM auth.identities
WHERE user_id IN (
  '40166109-6f51-45e1-a93c-77c3e8d8efa7',
  '79aba17d-b257-4d93-b4eb-b5078b596972',
  '8777dcbf-81d0-4a7b-9e9f-83c5767375d2',
  '43e2d787-357f-4a54-b852-07a0708e0c2a',
  'a9eebe1c-e094-4d94-a239-13a3a5a3f83a',
  'ad4cf7d9-8c8c-4506-9d6b-e6ff99c0ebb9',
  '5be29eb5-e557-41ba-8464-9097989c5804',
  '77d80b07-d4a0-4776-a730-9094eb56bc20',
  '638f3cda-cd9a-4fc0-b636-d9b1160f144e',
  'c270ccc8-a250-4c2b-ba26-d19cee8097bc',
  'e72385a4-07cc-4752-aa2d-328a45dc3dd6',
  '221c472f-7e02-4808-8640-1f96954b4a99',
  '9c04072f-2cae-4632-98e3-13dce2934f16',
  'ff57eebc-1bff-4e07-bdeb-903ed31de63a',
  'b3986e93-c004-4df4-af9a-3a2c99e38ec2',
  '25fa6f29-5dc7-4b8a-afd2-c3aad9d61863',
  'f46ae76b-c834-47e5-95e1-dd0c74b20643',
  '38bfb3a7-fe3e-40e6-8c69-b282cb2622ab',
  '6213b633-10ca-48ef-9368-791d1984d389',
  '251275cc-891b-4e04-b532-2dd43164b91b',
  '53fe9692-0676-4c2c-a504-f4989dd8b36f',
  'da6947f5-688a-47d3-875c-de5031f6caa8',
  'beb9ffb4-1251-4914-9503-c1394bed5f56',
  'f5a02394-5392-4d6a-83a4-fd281b3a7ae0',
  'd985b328-c07a-467a-a968-1f540e7f56f0',
  'ee45f869-7427-4573-8403-4b06d92d06ba',
  '1eca71e8-77a9-4407-ab7e-989df11b7102',
  '5449b6ce-1dda-49fa-8bb8-b9bcd1b7d819',
  '76ef1ebc-f541-4289-9d1f-e88a63c13c6e',
  '973a130d-f262-412f-8cd6-c260481e4508',
  'e834b596-327e-4a7e-bb68-53e61e473c4a',
  '2a43ebff-a27c-4ccb-8e17-2d6fa4f7938b',
  'b65e9f22-7436-4d12-82a2-a3fde5fe87a4',
  '52a6bfe1-fe8a-416d-a4d8-afc94418e18d',
  '17572a3c-eabf-48e3-b722-8099c89a425d',
  '9ef3adbb-eee4-42f4-acfe-e8501e604cfd',
  '18156b75-3c17-4ed7-911d-a4ed928d4543'
);

DELETE FROM auth.users
WHERE id IN (
  '40166109-6f51-45e1-a93c-77c3e8d8efa7',
  '79aba17d-b257-4d93-b4eb-b5078b596972',
  '8777dcbf-81d0-4a7b-9e9f-83c5767375d2',
  '43e2d787-357f-4a54-b852-07a0708e0c2a',
  'a9eebe1c-e094-4d94-a239-13a3a5a3f83a',
  'ad4cf7d9-8c8c-4506-9d6b-e6ff99c0ebb9',
  '5be29eb5-e557-41ba-8464-9097989c5804',
  '77d80b07-d4a0-4776-a730-9094eb56bc20',
  '638f3cda-cd9a-4fc0-b636-d9b1160f144e',
  'c270ccc8-a250-4c2b-ba26-d19cee8097bc',
  'e72385a4-07cc-4752-aa2d-328a45dc3dd6',
  '221c472f-7e02-4808-8640-1f96954b4a99',
  '9c04072f-2cae-4632-98e3-13dce2934f16',
  'ff57eebc-1bff-4e07-bdeb-903ed31de63a',
  'b3986e93-c004-4df4-af9a-3a2c99e38ec2',
  '25fa6f29-5dc7-4b8a-afd2-c3aad9d61863',
  'f46ae76b-c834-47e5-95e1-dd0c74b20643',
  '38bfb3a7-fe3e-40e6-8c69-b282cb2622ab',
  '6213b633-10ca-48ef-9368-791d1984d389',
  '251275cc-891b-4e04-b532-2dd43164b91b',
  '53fe9692-0676-4c2c-a504-f4989dd8b36f',
  'da6947f5-688a-47d3-875c-de5031f6caa8',
  'beb9ffb4-1251-4914-9503-c1394bed5f56',
  'f5a02394-5392-4d6a-83a4-fd281b3a7ae0',
  'd985b328-c07a-467a-a968-1f540e7f56f0',
  'ee45f869-7427-4573-8403-4b06d92d06ba',
  '1eca71e8-77a9-4407-ab7e-989df11b7102',
  '5449b6ce-1dda-49fa-8bb8-b9bcd1b7d819',
  '76ef1ebc-f541-4289-9d1f-e88a63c13c6e',
  '973a130d-f262-412f-8cd6-c260481e4508',
  'e834b596-327e-4a7e-bb68-53e61e473c4a',
  '2a43ebff-a27c-4ccb-8e17-2d6fa4f7938b',
  'b65e9f22-7436-4d12-82a2-a3fde5fe87a4',
  '52a6bfe1-fe8a-416d-a4d8-afc94418e18d',
  '17572a3c-eabf-48e3-b722-8099c89a425d',
  '9ef3adbb-eee4-42f4-acfe-e8501e604cfd',
  '18156b75-3c17-4ed7-911d-a4ed928d4543'
);

SELECT set_config('app.t3_fixture_sweep', '', true);
SELECT set_config('app.audit_source', '', true);
SELECT set_config('app.audit_reason', '', true);

-- Restore posted-row lock without the sweep escape.
CREATE OR REPLACE FUNCTION public.transactions_reject_posted_change()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_correction text := nullif(current_setting('app.transaction_correction', true), '');
  v_invoice_only boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transactions: posted rows cannot be deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_invoice_only :=
    v_correction = 'invoice_number'
    AND OLD.invoice_number IS DISTINCT FROM NEW.invoice_number
    AND OLD.type IS NOT DISTINCT FROM NEW.type
    AND OLD.date IS NOT DISTINCT FROM NEW.date
    AND OLD.client IS NOT DISTINCT FROM NEW.client
    AND OLD.client_id IS NOT DISTINCT FROM NEW.client_id
    AND OLD.item_name IS NOT DISTINCT FROM NEW.item_name
    AND OLD.serial_number IS NOT DISTINCT FROM NEW.serial_number
    AND OLD.from_location IS NOT DISTINCT FROM NEW.from_location
    AND OLD.to_location IS NOT DISTINCT FROM NEW.to_location
    AND OLD.batch_id IS NOT DISTINCT FROM NEW.batch_id;

  IF NOT v_invoice_only THEN
    RAISE EXCEPTION 'transactions: posted rows cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$fn$;

DO $assert$
DECLARE
  v_clients int;
  v_items int;
  v_invoices int;
  v_users int;
BEGIN
  SELECT count(*) INTO v_clients FROM public.clients
  WHERE id LIKE 'CLT-verify-%' OR id IN ('CLT-H1077','CLT-RR1078-NONE','CLT-RR1078-SITE');
  IF v_clients <> 0 THEN
    RAISE EXCEPTION 'T3 sweep: fixture clients remain (%)', v_clients;
  END IF;

  SELECT count(*) INTO v_items FROM public.inventory_items
  WHERE serial_number ~* '^(verify-|RR1078|H1077|OB1076|INV075|P1071|P1072|E1070|R3069|K1073|RS1074|I2B068|VERIFY-P33B)'
     OR id ~* '^(ITEM-RS1074|ITEM-I2B068|ITEM-R3069|ITEM-E1070|ITEM-P107|ITEM-K1073|ITEM-INV075|ITEM-OB1076|ITEM-H1077|ITEM-RR1078|item-VERIFY|verify-)';
  IF v_items <> 0 THEN
    RAISE EXCEPTION 'T3 sweep: fixture inventory_items remain (%)', v_items;
  END IF;

  SELECT count(*) INTO v_invoices FROM public.batch_invoices WHERE batch_id LIKE '%verify%';
  IF v_invoices <> 0 THEN
    RAISE EXCEPTION 'T3 sweep: fixture invoices remain (%)', v_invoices;
  END IF;

  SELECT count(*) INTO v_users FROM auth.users WHERE email ~* '^verify-';
  IF v_users <> 0 THEN
    RAISE EXCEPTION 'T3 sweep: fixture auth users remain (%)', v_users;
  END IF;

  SELECT count(*) INTO v_users FROM public.deleted_users
  WHERE reason = 'T3 fixture sweep users';
  IF v_users < 37 THEN
    RAISE EXCEPTION 'T3 sweep: expected 37 deleted_users labels, found %', v_users;
  END IF;

  -- Dry-run surface targets (live totals may move before apply):
  -- clients directory after ≈ 1870
  -- In Stock after ≈ 360
  -- Pending Inspection after ≈ 1
  -- Monthly sales after ≈ 1182
  -- available after ≈ 357
END
$assert$;

COMMIT;
