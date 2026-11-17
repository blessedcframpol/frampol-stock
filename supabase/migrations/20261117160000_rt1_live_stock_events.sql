-- RT1: one Realtime signal per transaction batch (statement-level), not per serial.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.live_stock_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id text NOT NULL,
  movement_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS live_stock_events_created_at_idx
  ON public.live_stock_events (created_at);

CREATE INDEX IF NOT EXISTS live_stock_events_batch_id_idx
  ON public.live_stock_events (batch_id);

COMMENT ON TABLE public.live_stock_events IS
  'RT1: statement-level stock movement signal (one row per batch insert). Pruned after 1 day.';

ALTER TABLE public.live_stock_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS live_stock_events_select_authenticated ON public.live_stock_events;
CREATE POLICY live_stock_events_select_authenticated
  ON public.live_stock_events
  FOR SELECT
  TO authenticated
  USING (true);

REVOKE ALL ON TABLE public.live_stock_events FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.live_stock_events TO authenticated;
GRANT ALL ON TABLE public.live_stock_events TO service_role;

CREATE OR REPLACE FUNCTION public.trg_live_stock_events_from_transactions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.live_stock_events (batch_id, movement_type)
  SELECT
    coalesce(nullif(btrim(batch_id), ''), id::text) AS batch_id,
    min(type) AS movement_type
  FROM new_rows
  GROUP BY 1;

  DELETE FROM public.live_stock_events
  WHERE created_at < now() - interval '1 day';

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.trg_live_stock_events_from_transactions() IS
  'RT1: after INSERT on transactions, emit one live_stock_events row per batch_id.';

DROP TRIGGER IF EXISTS transactions_live_stock_events_stmt ON public.transactions;
CREATE TRIGGER transactions_live_stock_events_stmt
  AFTER INSERT ON public.transactions
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.trg_live_stock_events_from_transactions();

ALTER TABLE public.live_stock_events REPLICA IDENTITY FULL;

DO $realtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'live_stock_events'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.live_stock_events;
    END IF;
  END IF;
END;
$realtime$;

-- Audit invariant: every public table is audited or excluded with a reason.
INSERT INTO public.audit_trigger_exclusions (table_name, reason)
SELECT 'live_stock_events', 'RT1 realtime signal rows (one per stock batch), pruned after 1 day; not durable business state'
WHERE NOT EXISTS (SELECT 1 FROM public.audit_trigger_exclusions WHERE table_name = 'live_stock_events');
