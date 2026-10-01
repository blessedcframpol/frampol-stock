-- Allow Transfer while a unit is out on POC or rental. Status stays the same.
-- Twin of lib/movement-transitions.mjs. Maintenance is still not produced here.

BEGIN;

CREATE OR REPLACE FUNCTION public.movement_result_status(p_status text, p_type text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_next text;
BEGIN
  v_next := CASE p_status
    WHEN 'In Stock' THEN CASE p_type
      WHEN 'Sale' THEN 'Sold'
      WHEN 'POC Out' THEN 'POC'
      WHEN 'Rentals' THEN 'Rented'
      WHEN 'Dispose' THEN 'Disposed'
      WHEN 'Transfer' THEN 'In Stock'
      WHEN 'Remediation Loaner Issue' THEN 'Sold'
      ELSE NULL
    END
    WHEN 'Sold' THEN CASE p_type
      WHEN 'Sale Return' THEN 'RMA Hold'
      WHEN 'Decommissioned' THEN 'Pending Inspection'
      ELSE NULL
    END
    WHEN 'POC' THEN CASE p_type
      WHEN 'Sale' THEN 'Sold'
      WHEN 'POC Return' THEN 'In Stock'
      WHEN 'Decommissioned' THEN 'Pending Inspection'
      WHEN 'Transfer' THEN 'POC'
      ELSE NULL
    END
    WHEN 'Rented' THEN CASE p_type
      WHEN 'Rental Return' THEN 'In Stock'
      WHEN 'Decommissioned' THEN 'Pending Inspection'
      WHEN 'Transfer' THEN 'Rented'
      ELSE NULL
    END
    WHEN 'Maintenance' THEN CASE p_type
      WHEN 'Inbound' THEN 'In Stock'
      WHEN 'Dispose' THEN 'Disposed'
      WHEN 'Transfer' THEN 'Maintenance'
      ELSE NULL
    END
    WHEN 'RMA Hold' THEN CASE p_type
      WHEN 'Inbound' THEN 'In Stock'
      WHEN 'Dispose' THEN 'Disposed'
      WHEN 'Transfer' THEN 'RMA Hold'
      ELSE NULL
    END
    WHEN 'Pending Inspection' THEN CASE p_type
      WHEN 'Inspection Pass' THEN 'In Stock'
      WHEN 'Inspection Fail' THEN 'RMA Hold'
      WHEN 'Dispose' THEN 'Disposed'
      WHEN 'Transfer' THEN 'Pending Inspection'
      ELSE NULL
    END
    ELSE NULL
  END;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Invalid movement: % from %', p_type, p_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_next;
END;
$$;

COMMIT;
