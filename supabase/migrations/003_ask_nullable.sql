-- MemBridge: make memory_entries.ask nullable for the prompt-privacy gate.
-- Apply AFTER schema.sql (v1) and 002_team_v2.sql — this is a migration, not a
-- rewrite, so it runs against the already-live backend without touching rows.
-- Run in the Supabase SQL editor, or `supabase db push` if you use the CLI.
--
-- Why: with prompt sharing off (the default), the client uploads `ask: null`
-- (summary + files still go). The v1 column was `ask text not null`, so a live
-- backend would reject every default-gated push until this runs. Ship this
-- migration to the live backend BEFORE (or with) the client change.
--
-- Idempotent: `drop not null` is a no-op if the column is already nullable.

alter table public.memory_entries
  alter column ask drop not null;
