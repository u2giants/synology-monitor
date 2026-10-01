-- Replica parity check (edge1 -> edge2 ShareSync).
-- The source NAS agent publishes the paths it saw change recently; the replica
-- NAS agent stats each one locally and raises an alert for anything missing.
-- One row per source NAS, replaced on every scan. Service role only.
CREATE TABLE IF NOT EXISTS public.replica_manifests (
  source_nas_id uuid PRIMARY KEY REFERENCES public.nas_units(id) ON DELETE CASCADE,
  scan_id       text        NOT NULL,
  scanned_at    timestamptz NOT NULL,
  window_hours  integer     NOT NULL,
  roots         text[]      NOT NULL,
  entry_count   integer     NOT NULL,
  truncated     boolean     NOT NULL DEFAULT false,
  entries       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.replica_manifests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.replica_manifests FROM anon, authenticated;
