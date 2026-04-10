-- AI model settings table
-- Stores configurable model IDs for diagnosis and remediation pipelines.
-- Both use OpenRouter (OPENROUTER_API_KEY).

create table if not exists smon_ai_settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table smon_ai_settings enable row level security;

create policy "authenticated_read" on smon_ai_settings
  for select to authenticated using (true);

create policy "authenticated_write" on smon_ai_settings
  for all to authenticated using (true) with check (true);

-- Defaults: diagnosis uses Gemini 2.5 Flash (bulk log analysis, cheap + fast),
-- remediation uses GPT-5.4 (NAS Copilot, needs stronger reasoning for SSH fix commands).
insert into smon_ai_settings (key, value) values
  ('diagnosis_model',   'google/gemini-2.5-flash'),
  ('remediation_model', 'openai/gpt-5.4')
on conflict (key) do nothing;
