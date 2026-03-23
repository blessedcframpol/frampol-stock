-- Multiple site addresses per client (same JSON shape as quick_scans.sites).

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS sites JSONB;

COMMENT ON COLUMN public.clients.sites IS 'Office / branch / delivery sites: [{ "name"?: string, "address": string }, ...]. Primary address column stays in sync with the first site.';

UPDATE public.clients
SET sites = jsonb_build_array(jsonb_build_object('address', address))
WHERE address IS NOT NULL
  AND btrim(address) <> ''
  AND (
    sites IS NULL
    OR sites = 'null'::jsonb
    OR jsonb_typeof(sites) <> 'array'
    OR (jsonb_typeof(sites) = 'array' AND jsonb_array_length(sites) = 0)
  );
