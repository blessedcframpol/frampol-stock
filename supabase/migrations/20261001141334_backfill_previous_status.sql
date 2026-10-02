DO $i2a$
DECLARE
  rec record;
  v_serial text := '';
  v_running text;
  v_prev text;
  v_source text;
  v_bad integer;
  v_sample text;
BEGIN
  CREATE TEMP TABLE _i2a_end (
    serial text PRIMARY KEY,
    status text
  ) ON COMMIT DROP;

  FOR rec IN
    SELECT
      id,
      type,
      serial_number,
      metadata,
      coalesce(
        created_at,
        CASE
          WHEN id ~ '^TXN-[0-9]{10}'
            THEN to_timestamp((substring(id from '^TXN-([0-9]{10,})'))::bigint / 1000.0)
          ELSE NULL
        END,
        date::timestamptz
      ) AS record_time
    FROM public.transactions
    WHERE type <> 'Reversal'
    ORDER BY serial_number, record_time, id
  LOOP
    IF rec.serial_number IS DISTINCT FROM v_serial THEN
      IF v_serial <> '' THEN
        INSERT INTO _i2a_end (serial, status) VALUES (v_serial, v_running);
      END IF;
      v_serial := rec.serial_number;
      v_running := NULL;
    END IF;

    IF v_running IS NULL AND rec.type = 'Inbound' THEN
      v_prev := NULL;
      v_source := 'derived';
      v_running := 'In Stock';
    ELSIF v_running IS NULL
          AND rec.type = 'Decommissioned'
          AND rec.metadata->>'intakeSource' = 'unknown_serial' THEN
      v_prev := NULL;
      v_source := 'derived';
      v_running := 'Pending Inspection';
    ELSIF v_running IS NULL THEN
      SELECT opening.previous_status, opening.source
      INTO v_prev, v_source
      FROM public.ledger_opening_status(rec.type) AS opening;
      v_running := public.ledger_next_status(v_prev, rec.type, rec.metadata);
    ELSE
      v_prev := v_running;
      v_source := 'derived';
      v_running := public.ledger_next_status(v_prev, rec.type, rec.metadata);
    END IF;

    UPDATE public.transactions
    SET previous_status = v_prev,
        previous_status_source = v_source
    WHERE id = rec.id;
  END LOOP;

  IF v_serial <> '' THEN
    INSERT INTO _i2a_end (serial, status) VALUES (v_serial, v_running);
  END IF;

  UPDATE public.transactions
  SET previous_status = NULL,
      previous_status_source = 'unknown'
  WHERE type = 'Reversal';

  SELECT count(*)::integer, string_agg(item.serial_number, ', ' ORDER BY item.serial_number)
  INTO v_bad, v_sample
  FROM (
    SELECT item.serial_number
    FROM public.inventory_items AS item
    JOIN _i2a_end AS replay ON replay.serial = item.serial_number
    WHERE item.deleted_at IS NULL
      AND item.status IS DISTINCT FROM replay.status
    LIMIT 20
  ) AS item;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'previous_status backfill does not end at the live status for % serial(s): %', v_bad, v_sample;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.transactions WHERE previous_status_source IS NULL
  ) THEN
    RAISE EXCEPTION 'previous_status backfill left a row without a source';
  END IF;
END
$i2a$;

ALTER TABLE public.transactions
  ALTER COLUMN previous_status_source SET DEFAULT 'unknown';

ALTER TABLE public.transactions
  ALTER COLUMN previous_status_source SET NOT NULL;
