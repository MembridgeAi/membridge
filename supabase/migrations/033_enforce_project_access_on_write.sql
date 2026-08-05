-- 033_enforce_project_access_on_write.sql — apply can_see_project to WRITES,
-- not only to reads. A member revoked from a project can currently still insert
-- and update memory_entries in it: write-only access to a project they cannot
-- read back.
--
-- THE ASYMMETRY, read out of this repo:
--
--   memory_entries_select  025:47  is_team_member AND can_see_project   <- gated
--   memory_entries_insert  schema.sql:124  author_id = auth.uid() AND is_team_member
--   memory_entries_update  012:16         author_id = auth.uid() AND is_team_member
--
-- 025 tightened SELECT and left the two write policies alone. Nothing in 025,
-- 026, 028 or 029 revisits them, so revocation has never applied to writing.
--
-- WHAT IS AND IS NOT HAPPENING TODAY — CORRECTED AFTER MEASURING IT.
-- The first draft of this header claimed a revoked member's daemon "keeps
-- uploading on every sync pass, indefinitely". THAT IS FALSE for the shipped
-- client, and the correction matters because it decides what this migration is
-- for. syncOnce probes visibleProjectIds once per team and, on positive
-- confirmation that a linked project is not in the visible set, stamps
-- teamAccessLost, drops the cached teammate rows and the durable archive, and
-- `continue`s — "no push, no pull, no backfill for a project we may not read"
-- (lib/teamsync.js:2096-2106). In the ordinary case the client declines to write
-- before the backend is ever asked. Verified in the suite, and pinned there as a
-- passing check so nobody re-derives the wrong story from this file.
--
-- SO WHY SHIP IT. Because that client gate is positive-confirmation only, and
-- visibleProjectIds (:1092-1112) returns NULL — meaning "skip the gate" — on a
-- thrown request, a non-array body, and, deliberately, an EMPTY visible set. Its
-- own comment names the cost it accepted: "revocation from a member's ONLY
-- project is not detected here", because [] cannot be distinguished from a
-- backend with no project_stats view, and the caller deletes local data on
-- absence so the ambiguous case has to fail safe.
--
-- What that comment could not know is that the undetected case was not merely a
-- stale read. Pre-033 the backend ACCEPTED the write. So a member revoked from
-- every project they could see — in practice, from their only one — skips the
-- gate, pushes, and the row lands in a project they cannot read back. No
-- attacker and no stale client required; that is the first-party code path.
--
-- Three more ways the same hole is reachable, none of which the client gate can
-- cover: a revocation that lands BETWEEN the probe and the push inside one pass;
-- any pass where the probe throws; and anyone using the project's anon key with
-- their own valid bearer token directly (the anon key is public by design), which
-- is a revoked member with curl.
--
-- 024's own header already says this is where the fix belongs: the Node check in
-- lib/api-access.js is the first gate and "RLS is the backstop if that check is
-- ever bypassed or wrong, not the only gate." For writes there was no backstop —
-- the client was the only gate. This adds the missing one. It also restores the
-- containment property 025 was written for: a project closed to somebody is not
-- closed if they can still write to it.
--
-- RISK CLASS: POLICY REPLACEMENT ONLY. No data is written or deleted. Reversible
-- by restoring the two prior policy bodies, which is what
-- supabase/rollback/pre-033-memory-write-policies.sql does.
--
-- BLAST RADIUS — EVERY WRITER OF memory_entries, which is one code path:
-- upsertEntries (lib/teamsync.js:857), reached from pushProject's fresh-entry
-- loop (:1321), its drift re-push (:1359) and the reshare path (:1679). All
-- three go through the same POST with on_conflict=project_id,author_id,ts,source,
-- so both policies below are on the same statement: `ignore-duplicates` needs
-- INSERT, `merge-duplicates` needs INSERT *and* UPDATE when it conflicts.
-- Tightening only one of the two would leave the drift re-push as a way back in.
--
-- WHAT A REJECTED PUSH DOES TO THE CLIENT TODAY — established before writing
-- this, because it decides whether the tightening is safe to ship:
--
--   * upsertEntries (:857) rethrows anything that is not a PGRST204
--     missing-column error, so an RLS refusal propagates.
--   * pushProject advances proj.teamPushTs only AFTER the upsert returns
--     (:1321-1323), batch by batch. So a refusal advances NO cursor. This is
--     correct fail-closed behaviour and notably NOT this codebase's signature
--     defect — there is no success flag on the failure path.
--   * syncOnce catches it (:2146-2154), appends to `errors`, logs, and lets the
--     PULL continue on purpose ("publishing and reading are INDEPENDENT").
--     state.teamLastSync is still stamped, and the project still counts as
--     synced.
--
--   CONSEQUENCE, STATED PLAINLY: in the fail-open window described above, a
--   revoked member's held entries can never land. They are retried on every
--   pass, forever, and each pass appends one more error. That is the honest
--   outcome — the writes SHOULD be refused — but it is a permanent rejection
--   presented through machinery built for transient ones, and it is not free.
--   (In the ordinary case the teamAccessLost gate fires first and the project is
--   skipped silently, so this does not arise.) It is the reason for the rlsHint
--   change that ships alongside this migration: rlsHint fires on
--   /security|not a member/i, which the PostgREST message
--   `new row violates row-level security policy for table "memory_entries"`
--   matches, and the advice it gave was "you're not a member of this team; join
--   it or run `membridge team unlink`". For a revoked-from-one-project member
--   that is WRONG on both counts and the unlink half is destructive. Shipping
--   this policy without that fix would turn a correct refusal into misleading
--   advice to tear down a correctly-linked project.
--
-- HOW TO APPLY — SQL EDITOR ONLY, NEVER `supabase db push` IN THIS PROJECT,
-- for the reason 031 and 032 both give. `create policy` has no `if not exists`
-- or `or replace` (011 §1's note), so each is dropped then created — the
-- convention every policy change here follows, and what makes this re-runnable.
--
-- UNAPPLIED AS OF THIS COMMIT. Nothing here has been run against any database.

-- ---------------------------------------------------------------------------
-- 1. INSERT. Adds the third conjunct only; the first two are restated verbatim
-- from schema.sql:124-127 so this file is a complete statement of the policy
-- rather than a diff nobody can read on its own.
--
-- can_see_project (028:113) is `security definer ... stable` and is already the
-- predicate memory_entries_select uses, so read and write now agree by
-- construction rather than by two policies happening to be kept in step.
-- ---------------------------------------------------------------------------
drop policy if exists memory_entries_insert on public.memory_entries;
create policy memory_entries_insert on public.memory_entries
  for insert with check (
    author_id = auth.uid()
    and public.is_team_member((select team_id from public.projects where id = project_id))
    and public.can_see_project(project_id)
  );

-- ---------------------------------------------------------------------------
-- 2. UPDATE. Both USING and WITH CHECK, deliberately.
--
-- USING decides which existing rows the caller may target; WITH CHECK decides
-- what the resulting row may look like. Gating only WITH CHECK would let a
-- revoked member keep REWRITING rows they had already published (the
-- merge-duplicates drift path does exactly that), and gating only USING would
-- let them move a row INTO a project they cannot see. Both, or the hole moves
-- rather than closes.
--
-- Body restated from 012:16-25 with the one conjunct added to each clause.
-- ---------------------------------------------------------------------------
drop policy if exists memory_entries_update on public.memory_entries;
create policy memory_entries_update on public.memory_entries
  for update
  using (
    author_id = auth.uid()
    and public.is_team_member((select team_id from public.projects where id = project_id))
    and public.can_see_project(project_id)
  )
  with check (
    author_id = auth.uid()
    and public.is_team_member((select team_id from public.projects where id = project_id))
    and public.can_see_project(project_id)
  );

-- ---------------------------------------------------------------------------
-- 3. WHAT THIS DOES NOT TOUCH, ON PURPOSE.
--
--   * DELETE. memory_entries has no delete policy at all, and RLS defaults
--     closed, so nobody can delete through the API today. Adding one here to
--     "be consistent" would OPEN a capability that does not exist. Left alone.
--   * A member's OWN already-published rows in a project they have since been
--     revoked from. Those stay in the table and stay visible to everyone who
--     can see the project. Revocation is forward-looking here, exactly as it is
--     for reads: 025 did not retract history either, and a departed member's
--     contributions are deliberately never deleted. Removing them would be a
--     data write with a completely different risk profile.
--   * The self-revoke case. A manager cannot revoke themselves — that is
--     guarded in lib/api-access.js, above this layer — so this policy cannot
--     lock an owner out of pushing to their own project.
-- ---------------------------------------------------------------------------
