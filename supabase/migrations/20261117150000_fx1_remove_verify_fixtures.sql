-- FX1: remove reviewed verify-fixture residue (data only).
-- Source: tmp/fx1-ids-prod-safe.json (Phase 0 letter prefixes + 061/065/066/068/075).
-- Asserts exact present counts before delete; never deletes more than this list.
-- Posted-transaction DELETE allowed only while app.fx1_fixture_sweep=1 (function
-- temporarily swapped in this transaction, then restored). Audit triggers stay ON.
-- Auth users: delete when all 32 listed ids are present; skip when none present;
-- abort if a partial subset is present.
SET lock_timeout = '5s';

CREATE TEMP TABLE fx1_items (id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO fx1_items (id) VALUES
  ('ITEM-E1070-1'),
  ('ITEM-E1070-6'),
  ('ITEM-H1077-1'),
  ('ITEM-H1077-18'),
  ('ITEM-I2B068-1'),
  ('ITEM-I2B068-14'),
  ('ITEM-I2B068-4'),
  ('ITEM-I2B068-9'),
  ('ITEM-INV075-1'),
  ('ITEM-INV075-10'),
  ('ITEM-INV075-13'),
  ('ITEM-INV075-16'),
  ('ITEM-INV075-19'),
  ('ITEM-INV075-22'),
  ('ITEM-INV075-4'),
  ('ITEM-INV075-7'),
  ('ITEM-K1073-1'),
  ('ITEM-K1073-15'),
  ('ITEM-K1073-22'),
  ('ITEM-K1073-28'),
  ('ITEM-K1073-35'),
  ('ITEM-K1073-42'),
  ('ITEM-K1073-49'),
  ('ITEM-K1073-8'),
  ('ITEM-OB1076-1'),
  ('ITEM-OB1076-11'),
  ('ITEM-OB1076-16'),
  ('ITEM-OB1076-23'),
  ('ITEM-OB1076-28'),
  ('ITEM-OB1076-6'),
  ('ITEM-P1071-1'),
  ('ITEM-P1071-4'),
  ('ITEM-P1072-1'),
  ('ITEM-P1072-4'),
  ('ITEM-P1072-7'),
  ('ITEM-R3069-1'),
  ('ITEM-R3069-14'),
  ('ITEM-R3069-19'),
  ('ITEM-R3069-24'),
  ('ITEM-R3069-29'),
  ('ITEM-R3069-34'),
  ('ITEM-R3069-4'),
  ('ITEM-R3069-41'),
  ('ITEM-R3069-48'),
  ('ITEM-R3069-55'),
  ('ITEM-R3069-62'),
  ('ITEM-R3069-69'),
  ('ITEM-R3069-76'),
  ('ITEM-R3069-79'),
  ('ITEM-R3069-86'),
  ('ITEM-R3069-9'),
  ('ITEM-R3069-93'),
  ('ITEM-R3069-98'),
  ('ITEM-RR1078-1'),
  ('ITEM-RR1078-10'),
  ('ITEM-RR1078-13'),
  ('ITEM-RR1078-16'),
  ('ITEM-RR1078-19'),
  ('ITEM-RR1078-22'),
  ('ITEM-RR1078-27'),
  ('ITEM-RR1078-4'),
  ('ITEM-RR1078-7'),
  ('ITEM-RS1074-1'),
  ('ITEM-RS1074-14'),
  ('ITEM-RS1074-19'),
  ('verify-066-item-move'),
  ('verify-066-item-status');

CREATE TEMP TABLE fx1_txns (id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO fx1_txns (id) VALUES
  ('TXN-34db247d11bc458ea62ce5b6fd8e3185'),
  ('TXN-67af294fceda499db41d5d3bcdce3670'),
  ('TXN-83609796f8ad4e4399dc8b5f175cb804'),
  ('TXN-b83f90e2828549b89525f242d69960a1'),
  ('TXN-cc3e4be1f2c14fcfb6eaa8bcaa072289'),
  ('TXN-E1070-11'),
  ('TXN-E1070-2'),
  ('TXN-E1070-4'),
  ('TXN-E1070-7'),
  ('TXN-E1070-9'),
  ('TXN-H1077-10'),
  ('TXN-H1077-12'),
  ('TXN-H1077-14'),
  ('TXN-H1077-16'),
  ('TXN-H1077-19'),
  ('TXN-H1077-2'),
  ('TXN-H1077-4'),
  ('TXN-H1077-6'),
  ('TXN-H1077-8'),
  ('TXN-I2B068-10'),
  ('TXN-I2B068-12'),
  ('TXN-I2B068-15'),
  ('TXN-I2B068-17'),
  ('TXN-I2B068-2'),
  ('TXN-I2B068-5'),
  ('TXN-I2B068-7'),
  ('TXN-INSP-1791294776837'),
  ('TXN-INSP-1791294781444'),
  ('TXN-INSP-1791295018290'),
  ('TXN-INSP-1791295018906'),
  ('TXN-INSP-1791295020751'),
  ('TXN-INSP-1791295022600'),
  ('TXN-INSP-1791295024443'),
  ('TXN-INSP-1791295096310'),
  ('TXN-INSP-1791295109861'),
  ('TXN-INSP-1791295110492'),
  ('TXN-INSP-1791295111124'),
  ('TXN-INSP-1791295111753'),
  ('TXN-INSP-1791295113414'),
  ('TXN-INV075-11'),
  ('TXN-INV075-14'),
  ('TXN-INV075-17'),
  ('TXN-INV075-2'),
  ('TXN-INV075-20'),
  ('TXN-INV075-23'),
  ('TXN-INV075-25'),
  ('TXN-INV075-27'),
  ('TXN-INV075-29'),
  ('TXN-INV075-41'),
  ('TXN-INV075-5'),
  ('TXN-INV075-8'),
  ('TXN-K1073-11'),
  ('TXN-K1073-13'),
  ('TXN-K1073-16'),
  ('TXN-K1073-18'),
  ('TXN-K1073-2'),
  ('TXN-K1073-20'),
  ('TXN-K1073-23'),
  ('TXN-K1073-29'),
  ('TXN-K1073-31'),
  ('TXN-K1073-33'),
  ('TXN-K1073-36'),
  ('TXN-K1073-38'),
  ('TXN-K1073-4'),
  ('TXN-K1073-40'),
  ('TXN-K1073-43'),
  ('TXN-K1073-45'),
  ('TXN-K1073-47'),
  ('TXN-K1073-50'),
  ('TXN-K1073-52'),
  ('TXN-K1073-54'),
  ('TXN-K1073-9'),
  ('TXN-OB1076-12'),
  ('TXN-OB1076-14'),
  ('TXN-OB1076-17'),
  ('TXN-OB1076-19'),
  ('TXN-OB1076-2'),
  ('TXN-OB1076-21'),
  ('TXN-OB1076-24'),
  ('TXN-OB1076-26'),
  ('TXN-OB1076-29'),
  ('TXN-OB1076-31'),
  ('TXN-OB1076-4'),
  ('TXN-OB1076-7'),
  ('TXN-OB1076-9'),
  ('TXN-P1071-2'),
  ('TXN-P1071-5'),
  ('TXN-P1072-12'),
  ('TXN-P1072-14'),
  ('TXN-P1072-2'),
  ('TXN-P1072-5'),
  ('TXN-P1072-8'),
  ('TXN-R3069-10'),
  ('TXN-R3069-12'),
  ('TXN-R3069-15'),
  ('TXN-R3069-17'),
  ('TXN-R3069-2'),
  ('TXN-R3069-20'),
  ('TXN-R3069-22'),
  ('TXN-R3069-25'),
  ('TXN-R3069-27'),
  ('TXN-R3069-30'),
  ('TXN-R3069-32'),
  ('TXN-R3069-35'),
  ('TXN-R3069-37'),
  ('TXN-R3069-39'),
  ('TXN-R3069-42'),
  ('TXN-R3069-44'),
  ('TXN-R3069-46'),
  ('TXN-R3069-49'),
  ('TXN-R3069-5'),
  ('TXN-R3069-51'),
  ('TXN-R3069-53'),
  ('TXN-R3069-56'),
  ('TXN-R3069-58'),
  ('TXN-R3069-60'),
  ('TXN-R3069-63'),
  ('TXN-R3069-65'),
  ('TXN-R3069-67'),
  ('TXN-R3069-7'),
  ('TXN-R3069-70'),
  ('TXN-R3069-72'),
  ('TXN-R3069-74'),
  ('TXN-R3069-77'),
  ('TXN-R3069-80'),
  ('TXN-R3069-82'),
  ('TXN-R3069-84'),
  ('TXN-R3069-87'),
  ('TXN-R3069-89'),
  ('TXN-R3069-91'),
  ('TXN-R3069-94'),
  ('TXN-R3069-96'),
  ('TXN-R3069-99'),
  ('TXN-REV-1791294300823-1'),
  ('TXN-REV-1791294727403-1'),
  ('TXN-REV-1791294729882-1'),
  ('TXN-REV-1791294732133-1'),
  ('TXN-REV-1791294741239-1'),
  ('TXN-REV-1791294744168-1'),
  ('TXN-REV-1791294747095-1'),
  ('TXN-REV-1791294750020-1'),
  ('TXN-REV-1791294752950-1'),
  ('TXN-REV-1791294755877-1'),
  ('TXN-REV-1791294758810-1'),
  ('TXN-REV-1791294763207-1'),
  ('TXN-REV-1791294766581-1'),
  ('TXN-REV-1791294769926-1'),
  ('TXN-REV-1791294773286-1'),
  ('TXN-REV-1791294777891-1'),
  ('TXN-REV-1791294782497-1'),
  ('TXN-REV-1791294785424-1'),
  ('TXN-REV-1791294788997-1'),
  ('TXN-REV-1791294791523-1'),
  ('TXN-REV-1791294793626-1'),
  ('TXN-REV-1791295002941-1'),
  ('TXN-REV-1791295024866-1'),
  ('TXN-REV-1791295039222-1'),
  ('TXN-REV-1791295080997-1'),
  ('TXN-REV-1791295081228-1'),
  ('TXN-REV-1791295081446-1'),
  ('TXN-REV-1791295081666-1'),
  ('TXN-REV-1791295081885-1'),
  ('TXN-REV-1791295093329-1'),
  ('TXN-RR1078-11'),
  ('TXN-RR1078-14'),
  ('TXN-RR1078-17'),
  ('TXN-RR1078-2'),
  ('TXN-RR1078-20'),
  ('TXN-RR1078-23'),
  ('TXN-RR1078-25'),
  ('TXN-RR1078-28'),
  ('TXN-RR1078-30'),
  ('TXN-RR1078-32'),
  ('TXN-RR1078-5'),
  ('TXN-RR1078-8'),
  ('TXN-RS1074-12'),
  ('TXN-RS1074-15'),
  ('TXN-RS1074-2'),
  ('TXN-RS1074-4'),
  ('txn-verify-061-late'),
  ('txn-verify-061-order-early'),
  ('txn-verify-061-order-late'),
  ('txn-verify-061-reversal'),
  ('txn-verify-061-write'),
  ('TXN-verify-065-ambig'),
  ('TXN-verify-065-dangle'),
  ('TXN-verify-065-poc'),
  ('TXN-verify-065-return'),
  ('TXN-verify-065-substr'),
  ('verify-066-txn-early'),
  ('verify-066-txn-later'),
  ('verify-066-txn-move');

CREATE TEMP TABLE fx1_clients (id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO fx1_clients (id) VALUES
  ('CLT-H1077'),
  ('CLT-RR1078-NONE'),
  ('CLT-RR1078-SITE'),
  ('CLT-verify-065-acme'),
  ('CLT-verify-065-owner'),
  ('CLT-verify-065-text'),
  ('CLT-verify-065-twin-a'),
  ('CLT-verify-065-twin-b');

CREATE TEMP TABLE fx1_invoices (batch_id text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO fx1_invoices (batch_id) VALUES
  ('TXN-verify-065-ambig'),
  ('TXN-verify-065-dangle'),
  ('TXN-verify-065-substr');

CREATE TEMP TABLE fx1_invoice_events (id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO fx1_invoice_events (id) VALUES
  ('0bb260d1-ded6-49e3-8fce-442a85f84233'),
  ('1cb6147f-c4c8-4708-a65f-bf637095bba6'),
  ('3cbbf7ed-1e7a-4e51-b8c5-833341cc48c6');

CREATE TEMP TABLE fx1_users (id uuid PRIMARY KEY) ON COMMIT DROP;
INSERT INTO fx1_users (id) VALUES
  ('40166109-6f51-45e1-a93c-77c3e8d8efa7'),
  ('79aba17d-b257-4d93-b4eb-b5078b596972'),
  ('8777dcbf-81d0-4a7b-9e9f-83c5767375d2'),
  ('43e2d787-357f-4a54-b852-07a0708e0c2a'),
  ('a9eebe1c-e094-4d94-a239-13a3a5a3f83a'),
  ('ad4cf7d9-8c8c-4506-9d6b-e6ff99c0ebb9'),
  ('5be29eb5-e557-41ba-8464-9097989c5804'),
  ('77d80b07-d4a0-4776-a730-9094eb56bc20'),
  ('638f3cda-cd9a-4fc0-b636-d9b1160f144e'),
  ('c270ccc8-a250-4c2b-ba26-d19cee8097bc'),
  ('e72385a4-07cc-4752-aa2d-328a45dc3dd6'),
  ('221c472f-7e02-4808-8640-1f96954b4a99'),
  ('9c04072f-2cae-4632-98e3-13dce2934f16'),
  ('ff57eebc-1bff-4e07-bdeb-903ed31de63a'),
  ('b3986e93-c004-4df4-af9a-3a2c99e38ec2'),
  ('25fa6f29-5dc7-4b8a-afd2-c3aad9d61863'),
  ('f46ae76b-c834-47e5-95e1-dd0c74b20643'),
  ('38bfb3a7-fe3e-40e6-8c69-b282cb2622ab'),
  ('6213b633-10ca-48ef-9368-791d1984d389'),
  ('251275cc-891b-4e04-b532-2dd43164b91b'),
  ('53fe9692-0676-4c2c-a504-f4989dd8b36f'),
  ('da6947f5-688a-47d3-875c-de5031f6caa8'),
  ('beb9ffb4-1251-4914-9503-c1394bed5f56'),
  ('f5a02394-5392-4d6a-83a4-fd281b3a7ae0'),
  ('d985b328-c07a-467a-a968-1f540e7f56f0'),
  ('ee45f869-7427-4573-8403-4b06d92d06ba'),
  ('1eca71e8-77a9-4407-ab7e-989df11b7102'),
  ('5449b6ce-1dda-49fa-8bb8-b9bcd1b7d819'),
  ('76ef1ebc-f541-4289-9d1f-e88a63c13c6e'),
  ('973a130d-f262-412f-8cd6-c260481e4508'),
  ('e834b596-327e-4a7e-bb68-53e61e473c4a'),
  ('2a43ebff-a27c-4ccb-8e17-2d6fa4f7938b');

DO $assert$
DECLARE
  v_items int;
  v_txns int;
  v_clients int;
  v_invoices int;
  v_events int;
  v_users int;
BEGIN
  SELECT count(*)::int INTO v_items
  FROM public.inventory_items i JOIN fx1_items f ON f.id = i.id;
  IF v_items IS DISTINCT FROM 67 THEN
    RAISE EXCEPTION 'fx1: inventory_items present=% expected=67 — aborting', v_items;
  END IF;

  SELECT count(*)::int INTO v_txns
  FROM public.transactions t JOIN fx1_txns f ON f.id = t.id;
  IF v_txns IS DISTINCT FROM 192 THEN
    RAISE EXCEPTION 'fx1: transactions present=% expected=192 — aborting', v_txns;
  END IF;

  SELECT count(*)::int INTO v_clients
  FROM public.clients c JOIN fx1_clients f ON f.id = c.id;
  IF v_clients IS DISTINCT FROM 8 THEN
    RAISE EXCEPTION 'fx1: clients present=% expected=8 — aborting', v_clients;
  END IF;

  SELECT count(*)::int INTO v_invoices
  FROM public.batch_invoices b JOIN fx1_invoices f ON f.batch_id = b.batch_id;
  IF v_invoices IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'fx1: batch_invoices present=% expected=3 — aborting', v_invoices;
  END IF;

  SELECT count(*)::int INTO v_events
  FROM public.batch_invoice_events e JOIN fx1_invoice_events f ON f.id = e.id;
  IF v_events IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'fx1: batch_invoice_events present=% expected=3 — aborting', v_events;
  END IF;

  SELECT count(*)::int INTO v_users
  FROM auth.users u JOIN fx1_users f ON f.id = u.id;
  IF v_users NOT IN (0, 32) THEN
    RAISE EXCEPTION 'fx1: auth.users present=% expected 0 or 32 — aborting', v_users;
  END IF;

  PERFORM set_config('app.fx1_users_present', v_users::text, true);
END;
$assert$;

SELECT set_config('request.jwt.claim.sub', 'ccf0717b-0323-49c6-a6c3-59d45cc849f2', true);
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"ccf0717b-0323-49c6-a6c3-59d45cc849f2","role":"authenticated"}',
  true
);
SELECT set_config('app.audit_source', 'fx1_fixture_cleanup', true);
SELECT set_config('app.audit_reason', 'FX1 remove verify fixtures', true);

DELETE FROM public.batch_invoice_events e
USING fx1_invoice_events f
WHERE e.id = f.id;

DELETE FROM public.batch_invoices b
USING fx1_invoices f
WHERE b.batch_id = f.batch_id;

-- Capture exact reject-fn definition + md5 before temporary sweep swap.
CREATE TEMP TABLE fx1_reject_fn (
  md5 text NOT NULL,
  def text NOT NULL
) ON COMMIT DROP;
INSERT INTO fx1_reject_fn (md5, def)
SELECT md5(d), d
FROM (
  SELECT pg_get_functiondef('public.transactions_reject_posted_change()'::regprocedure) AS d
) AS src;

CREATE OR REPLACE FUNCTION public.transactions_reject_posted_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $reject$
DECLARE
  v_correction text := nullif(current_setting('app.transaction_correction', true), '');
  v_invoice_only boolean;
  v_sweep text := nullif(current_setting('app.fx1_fixture_sweep', true), '');
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

  IF v_invoice_only THEN
    RETURN NEW;
  END IF;

  IF OLD.type IS DISTINCT FROM NEW.type
    OR OLD.date IS DISTINCT FROM NEW.date
    OR OLD.client IS DISTINCT FROM NEW.client
    OR OLD.client_id IS DISTINCT FROM NEW.client_id
    OR OLD.item_name IS DISTINCT FROM NEW.item_name
    OR OLD.serial_number IS DISTINCT FROM NEW.serial_number
    OR OLD.invoice_number IS DISTINCT FROM NEW.invoice_number
    OR OLD.from_location IS DISTINCT FROM NEW.from_location
    OR OLD.to_location IS DISTINCT FROM NEW.to_location
    OR OLD.batch_id IS DISTINCT FROM NEW.batch_id
  THEN
    RAISE EXCEPTION 'transactions: posted fields are locked'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$reject$;

REVOKE ALL ON FUNCTION public.transactions_reject_posted_change() FROM PUBLIC, anon, authenticated;

SELECT set_config('app.fx1_fixture_sweep', '1', true);

DELETE FROM public.transactions t
USING fx1_txns f
WHERE t.id = f.id;

SELECT set_config('app.fx1_fixture_sweep', '', true);

-- Restore captured definition; abort unless md5 matches and sweep GUC is gone.
DO $restore$
DECLARE
  v_before text;
  v_def text;
  v_after text;
  v_body text;
BEGIN
  SELECT md5, def INTO v_before, v_def FROM fx1_reject_fn;
  EXECUTE v_def;
  REVOKE ALL ON FUNCTION public.transactions_reject_posted_change() FROM PUBLIC, anon, authenticated;

  v_body := pg_get_functiondef('public.transactions_reject_posted_change()'::regprocedure);
  v_after := md5(v_body);
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'fx1: reject fn md5 mismatch after restore (before=% after=%)', v_before, v_after;
  END IF;
  IF position('fx1_fixture_sweep' in v_body) > 0 THEN
    RAISE EXCEPTION 'fx1: reject fn still references app.fx1_fixture_sweep after restore';
  END IF;
END;
$restore$;

DELETE FROM public.inventory_items i
USING fx1_items f
WHERE i.id = f.id;

DELETE FROM public.clients c
USING fx1_clients f
WHERE c.id = f.id
  AND c.id IS DISTINCT FROM 'CLT-1774007295290-1pl6z68';

DO $users$
BEGIN
  IF current_setting('app.fx1_users_present', true) = '32' THEN
    DELETE FROM auth.users u
    USING fx1_users f
    WHERE u.id = f.id;
  END IF;
END;
$users$;

DO $final$
BEGIN
  IF EXISTS (SELECT 1 FROM public.inventory_items i JOIN fx1_items f ON f.id = i.id) THEN
    RAISE EXCEPTION 'fx1: inventory_items remain after delete';
  END IF;
  IF EXISTS (SELECT 1 FROM public.transactions t JOIN fx1_txns f ON f.id = t.id) THEN
    RAISE EXCEPTION 'fx1: transactions remain after delete';
  END IF;
  IF EXISTS (SELECT 1 FROM public.clients c JOIN fx1_clients f ON f.id = c.id) THEN
    RAISE EXCEPTION 'fx1: clients remain after delete';
  END IF;
  IF current_setting('app.fx1_users_present', true) = '32'
     AND EXISTS (SELECT 1 FROM auth.users u JOIN fx1_users f ON f.id = u.id) THEN
    RAISE EXCEPTION 'fx1: auth.users remain after delete';
  END IF;
END;
$final$;
