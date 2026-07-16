-- SECURITY FIX: SECURITY DEFINER functions were callable by `anon` over the public API.
--
-- Found 2026-07-16 while installing 00042. VERIFIED EXPLOITABLE against production
-- with nothing but the public anon key (which is baked into the browser bundle
-- served at mon.designflow.app — anyone with devtools has it):
--
--   POST /rest/v1/rpc/exec_sql            {"sql":"SELECT 1"}  -> HTTP 204  (arbitrary SQL ran)
--   POST /rest/v1/rpc/smon_get_openai_key {}                  -> HTTP 200  (returned the live sk-or-v1-… key)
--
-- exec_sql is SECURITY DEFINER owned by postgres, so that is arbitrary SQL as a
-- superuser-equivalent: DROP TABLE, read auth.users, exfiltrate anything. There is
-- no rollback project. This was a total, remotely-exploitable compromise of the
-- production database, open since at least the function's creation.
--
-- ROOT CAUSE — the trap that makes this repo-wide:
--   1. Postgres grants EXECUTE on new functions to PUBLIC by default.
--   2. This Supabase project ALSO has ALTER DEFAULT PRIVILEGES granting EXECUTE on
--      new functions in `public` to `anon` and `authenticated`.
--   3. PostgREST exposes every function in `public` as an RPC endpoint.
-- So `GRANT EXECUTE … TO service_role` (as 00010 did for exec_sql) does NOT restrict
-- anything — it grants an additional role while anon keeps the default grant. The
-- only thing that restricts is an explicit REVOKE.
--
-- RULE: every CREATE FUNCTION in this repo must be followed by
--   REVOKE ALL ON FUNCTION <sig> FROM PUBLIC, anon, authenticated;
-- and only then GRANT to the roles that genuinely need it. See AGENTS.md § 15.
--
-- Verified before applying: no application code calls any of these via .rpc(); they
-- are invoked by pg_cron (which runs as `postgres`) or internally by other SQL
-- functions. service_role and postgres retain access, so nothing legitimate breaks.

DO $$
DECLARE
  f record;
  revoked int := 0;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig, p.proname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    RAISE NOTICE 'Revoked anon/authenticated EXECUTE on SECURITY DEFINER function: %', f.proname;
    revoked := revoked + 1;
  END LOOP;

  RAISE NOTICE 'Total SECURITY DEFINER functions closed to anon: %', revoked;
END;
$$;

-- Re-assert the grants the system actually needs. exec_sql is used by
-- scripts/run-telemetry-retention-cleanup.mjs with the service_role key.
DO $$
BEGIN
  IF to_regprocedure('public.exec_sql(text)') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role';
  END IF;
END;
$$;

-- Guard: fail loudly if anything in public is still SECURITY DEFINER + anon-callable.
DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(p.proname, ', ')
  INTO leaked
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER functions still callable by anon: %', leaked;
  END IF;
END;
$$;
