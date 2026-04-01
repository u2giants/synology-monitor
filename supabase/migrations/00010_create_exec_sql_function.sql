-- Minimal migration to enable SQL execution via API
-- This creates a wrapper function that can execute arbitrary SQL
-- Only callable by service_role (which we have the key for)

create or replace function exec_sql(sql text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  execute sql;
end;
$$;

-- Grant execute to service_role
grant execute on function exec_sql(text) to service_role;
