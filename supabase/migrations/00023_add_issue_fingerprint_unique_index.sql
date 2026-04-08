create unique index if not exists smon_issues_user_fingerprint_unique
on public.smon_issues (user_id, fingerprint)
where fingerprint is not null;
