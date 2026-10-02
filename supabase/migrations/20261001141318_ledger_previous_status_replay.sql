-- Legal predecessors of a movement. Several predecessors → In Stock when that is legal, source unknown.
CREATE FUNCTION public.ledger_opening_status(p_type text)
RETURNS TABLE (previous_status text, source text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH legal AS (
    SELECT pair.status
    FROM (VALUES
      ('In Stock', 'Sale'),
      ('POC', 'Sale'),
      ('In Stock', 'POC Out'),
      ('In Stock', 'Rentals'),
      ('In Stock', 'Dispose'),
      ('Maintenance', 'Dispose'),
      ('RMA Hold', 'Dispose'),
      ('Pending Inspection', 'Dispose'),
      ('In Stock', 'Transfer'),
      ('POC', 'Transfer'),
      ('Rented', 'Transfer'),
      ('Maintenance', 'Transfer'),
      ('RMA Hold', 'Transfer'),
      ('Pending Inspection', 'Transfer'),
      ('In Stock', 'Remediation Loaner Issue'),
      ('POC', 'POC Return'),
      ('Rented', 'Rental Return'),
      ('Sold', 'Sale Return'),
      ('Sold', 'Decommissioned'),
      ('POC', 'Decommissioned'),
      ('Rented', 'Decommissioned'),
      ('Maintenance', 'Inbound'),
      ('RMA Hold', 'Inbound'),
      ('Pending Inspection', 'Inspection Pass'),
      ('Pending Inspection', 'Inspection Fail')
    ) AS pair(status, movement)
    WHERE pair.movement = p_type
  ),
  picked AS (
    SELECT
      CASE
        WHEN count(*) = 0 THEN NULL
        WHEN count(*) = 1 THEN min(status)
        WHEN bool_or(status = 'In Stock') THEN 'In Stock'
        ELSE min(status)
      END AS previous_status,
      CASE WHEN count(*) = 1 THEN 'derived' ELSE 'unknown' END AS source
    FROM legal
  )
  SELECT picked.previous_status, picked.source
  FROM picked;
$$;

COMMENT ON FUNCTION public.ledger_opening_status(text) IS
  'Status before a movement that has no earlier row. One legal predecessor is derived. Several is unknown, and In Stock is chosen when it is legal because every alternative leaves the same later status.';

-- Next status. An illegal pair (a phantom Inbound of a unit already In Stock) leaves the status unchanged.
CREATE FUNCTION public.ledger_next_status(p_previous text, p_type text, p_metadata jsonb)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_next text;
BEGIN
  IF p_previous IS NULL AND p_type = 'Inbound' THEN
    RETURN 'In Stock';
  END IF;
  IF p_previous IS NULL
     AND p_type = 'Decommissioned'
     AND p_metadata->>'intakeSource' = 'unknown_serial' THEN
    RETURN 'Pending Inspection';
  END IF;
  IF p_previous IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    v_next := public.movement_result_status(p_previous, p_type);
  EXCEPTION
    WHEN check_violation THEN
      v_next := p_previous;
  END;
  RETURN v_next;
END;
$$;

COMMENT ON FUNCTION public.ledger_next_status(text, text, jsonb) IS
  'Status after a movement. A create Inbound yields In Stock. An illegal pair, including a second Inbound of an In Stock unit, does not change status.';

REVOKE ALL ON FUNCTION public.ledger_opening_status(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ledger_next_status(text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_opening_status(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ledger_next_status(text, text, jsonb) TO authenticated, service_role;
