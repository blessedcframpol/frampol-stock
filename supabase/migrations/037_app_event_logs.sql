-- Operational / error logs for support and audit (movement failures, API errors).

CREATE TABLE IF NOT EXISTS public.app_event_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  severity TEXT NOT NULL CHECK (severity IN ('error', 'warn', 'info')),
  source TEXT NOT NULL CHECK (source IN ('client', 'api')),
  context TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  metadata JSONB,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  request_id TEXT
);

COMMENT ON TABLE public.app_event_logs IS 'Append-only operational events (client movement failures, server API errors).';
COMMENT ON COLUMN public.app_event_logs.context IS 'Stable code e.g. movement_persist, transaction-batches GET';
COMMENT ON COLUMN public.app_event_logs.request_id IS 'Correlates with API error payloads when logged from server routes.';

CREATE INDEX IF NOT EXISTS idx_app_event_logs_created_at ON public.app_event_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_event_logs_severity ON public.app_event_logs(severity);
CREATE INDEX IF NOT EXISTS idx_app_event_logs_context ON public.app_event_logs(context);

ALTER TABLE public.app_event_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "app_event_logs_insert_own" ON public.app_event_logs;
CREATE POLICY "app_event_logs_insert_own"
  ON public.app_event_logs FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id IS NOT NULL
    AND user_id = auth.uid()
  );

DROP POLICY IF EXISTS "app_event_logs_admin_select" ON public.app_event_logs;
CREATE POLICY "app_event_logs_admin_select"
  ON public.app_event_logs FOR SELECT
  TO authenticated
  USING ((SELECT public.get_my_role()) = 'admin');
