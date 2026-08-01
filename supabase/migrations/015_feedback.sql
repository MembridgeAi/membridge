-- 015_feedback.sql
-- The public.feedback table backing membridge.app/feedback (CLI + site nudges).
-- NOTE: this table was created directly in the dashboard before this migration
-- existed; the DDL below mirrors the LIVE shape exactly and is idempotent, so a
-- fresh environment reproduces prod and running it against prod is a no-op.
-- Anon may INSERT only (no SELECT/UPDATE/DELETE policy => reads fully denied).

create table if not exists public.feedback (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  tools      text    check (tools is null or char_length(tools) <= 200),
  feedback   text    not null check (char_length(feedback) between 1 and 5000),
  email      text    check (email is null or char_length(email) <= 254),
  quote_ok   boolean not null default false,
  ref        text    check (ref is null or char_length(ref) <= 40)
);

alter table public.feedback enable row level security;

drop policy if exists "anon can submit feedback" on public.feedback;
create policy "anon can submit feedback" on public.feedback
  for insert to anon with check (
    char_length(feedback) between 1 and 5000
    and (email is null or char_length(email) <= 254)
    and (tools is null or char_length(tools) <= 200)
    and (ref  is null or char_length(ref)  <= 40)
  );

grant insert on public.feedback to anon;
