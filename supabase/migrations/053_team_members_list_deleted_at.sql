-- 053_team_members_list_deleted_at.sql — let a client tell a soft-deleted
-- account from a live one, by carrying auth.users.deleted_at on the one RPC
-- every present-tense membership surface already reads.
--
-- ===========================================================================
-- NOT APPLIED. Hand this to a human to run; nothing in this session has
-- touched any database. Unlike 052 (which is PARKED pending a product
-- decision), this one is READY: it closes a security hole, it needs no
-- decision, and it should go out with the next batch.
-- ===========================================================================
--
-- REGISTRY. Claimed as 053. `git show agent-sec:supabase/APPLY-RUNBOOK.md`
-- was read BEFORE this file was written, per the rule that table states and
-- three collisions were caused by breaking; it reads "Next free number: 052",
-- and 052 is this lane's, claimed by 052_account_deletion_fk_actions.sql on
-- this branch. 053 is therefore the next free number. The runbook does not
-- exist on `master`, so neither row could be added from here. Whoever merges
-- `agent-sec` must add BOTH and set next-free to 054:
--
--   | 052 | Account-deletion FK actions on five uncontested constraints
--         | `agent-deletion` | no |
--   | 053 | `team_members_list` carries `deleted_at`, so soft-deleted accounts
--           stop receiving team keys | `agent-deletion` | no |
--
-- INDEPENDENT OF 052. They share a subject and nothing else: 052 changes
-- referential actions, this changes one function's return shape. Either order,
-- or either alone. 052 is parked; this is not, and must not be held behind it.
--
-- ===========================================================================
-- WHAT THIS FIXES, AND WHY IT IS NOT COSMETIC
--
-- Supabase's dashboard offers a "soft delete" beside the hard delete. The hard
-- one hits seven foreign keys that reference auth.users with no on-delete
-- action and REFUSES (see docs/ACCOUNT-DELETION.md §1). The soft one sets
-- auth.users.deleted_at and LEAVES THE ROW, so it trips nothing. It always
-- succeeds, for every account, in every state.
--
-- And nothing in this codebase read that column. Verified before writing, all
-- read-only against the live catalog:
--
--   * information_schema.role_table_grants for auth.users returns ZERO rows --
--     no role holds any privilege on that table;
--   * PostgREST exposes only `public`, so there is no REST path to it;
--   * NOT ONE function or view in `public` reads auth.users. All eleven
--     identity functions were dumped and read (team_members_list, team_role,
--     is_team_member, is_team_member_uid, team_feed, create_team,
--     redeem_invite, remove_member, leave_team, my_entry_counts,
--     delete_my_entries); every one reads public.team_members or
--     public.memory_entries. `public` has exactly one view (project_stats) and
--     it does not touch auth either.
--
-- Identity in this product is fully denormalised into `public`. auth.users is
-- referenced by seven foreign keys and READ BY NOTHING. So the flag could
-- never arrive by accident -- and never without this file.
--
-- THE CONSEQUENCE THAT MATTERS. lib/teamsync.js has three key-sealing paths
-- (join-seal, re-seal, rekey) and all three derive their recipients from
-- team_members_list. A soft-deleted account's team_members row survives, so
-- every one of them went on sealing each NEW key epoch to that account's
-- public key. Offboarding somebody that way keeps handing them the keys,
-- forward, indefinitely, with nothing anywhere to show it. That is not a stale
-- roster entry; it is continuing to grant access to a person you believe you
-- removed. Four other surfaces (roster, access matrix, Insights, trust pins)
-- were also wrong, but only cosmetically.
-- ===========================================================================
--
-- ===========================================================================
-- DEPLOY ORDER: SAFE IN BOTH DIRECTIONS -- AND THIS FILE IS NOT THE FIX
--
-- The opposite of the 038/044/045/046 gate, and worth stating because those
-- headers have trained everyone here to look for a hard ordering rule.
--
--   migration first, old client   -> the extra column is ignored (PostgREST
--                                    returns JSON objects; nothing destructures
--                                    exhaustively). Behaves as today.
--   client first, no migration    -> `deleted_at` is absent, which the client
--                                    filter reads as LIVE. Behaves as today.
--                                    lib/teamsync.js activeMembers tests a
--                                    positive value rather than falsiness for
--                                    exactly this reason: reading "unknown" as
--                                    "deleted" would empty every recipient list
--                                    and break encryption for the whole team.
--
-- So neither order is dangerous. THE COROLLARY IS THE IMPORTANT PART:
-- **applying this file alone changes NOTHING.** The protection exists only
-- when the migration AND the client that filters on it are both out. Do not
-- record this as "fixed" on the strength of the migration having been applied
-- -- that is precisely the shape of bug this lane keeps finding (a success
-- state recorded for something the system never did).
--
-- Until BOTH are out, the operational answer stands and costs nothing:
-- **never use the dashboard's soft delete. Use "Remove from team"**
-- (remove_member), which takes the account off the roster, out of the access
-- matrix, out of Insights, and -- because the seal paths read
-- team_members_list -- out of every future key epoch. It is the operation that
-- actually does what soft delete only appears to do.
-- ===========================================================================
--
-- ===========================================================================
-- THE FOUR THINGS THAT WOULD MAKE THIS WRONG, each of which is a real trap
--
-- 1. `security definer`, and it already is. That is the ONLY reason the body
--    may read auth.users when no role holds a privilege on it. The
--    `is_team_member(p_team)` predicate in the WHERE clause therefore has to
--    stay: definer means RLS does NOT apply automatically, so the predicate IS
--    the authorization, exactly as 035 §2 spells out for my_entry_counts.
--    Dropping it would expose every team's roster to every signed-in user.
--
-- 2. `left join`, never a plain join. An inner join silently DROPS any member
--    whose auth.users row is genuinely gone -- which is precisely what 052
--    plus a real deletion path will start producing. That would turn a display
--    bug into members vanishing from rosters, access matrices and Insights,
--    and it would look like data loss rather than a join. The left join keeps
--    the member row and leaves deleted_at null, which reads as live -- the
--    conservative direction: an old row is shown, not silently removed.
--
-- 3. The timestamp, not a boolean. `deleted_at` is returned raw rather than a
--    derived `account_deleted` flag. The client only asks the yes/no question
--    today, so this discloses strictly more than is needed -- WHEN the account
--    was deleted, to every member of the team. That is a deliberate call, made
--    on the grounds that the raw fact is the durable one and a derived boolean
--    would have to be re-derived (and could drift) if anything ever needs the
--    date. Recorded rather than glossed: if the disclosure is unwanted, the
--    change is `(u.deleted_at is not null) as account_deleted` here and a
--    one-word change in lib/teamsync.js activeMembers. Nothing else moves.
--
-- 4. `drop function` first, because Postgres cannot change a function's return
--    type with `create or replace`. That is why this is a drop-then-create and
--    not the usual replace. Both statements run in the SQL editor's single
--    transaction, so there is no window where the function does not exist.
-- ===========================================================================
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH: attribution. The feed, the MCP
-- answers (search_memory, why), the day digests, the teammate-notes injection
-- and the ops contributor counts all name a deleted person on work they
-- actually did. None of those is factually WRONG, and erasing a name from work
-- someone did is not obviously better than keeping it -- an entry with no
-- author is a different kind of wrong, and the team loses who to ask. It
-- collides head-on with the conflict already in this tree: 029:312 and 033:156
-- say a departed member's contributions are never deleted, while 035 §1
-- deliberately lets a member erase their own. That is an open product decision
-- (docs/ACCOUNT-DELETION.md §6 and §8.4) and it must be answered ONCE for both,
-- or the product will say two different things about the same person. Nothing
-- here pre-empts it. lib/api-access.js readAudit is likewise left unfiltered on
-- purpose, with the reason written at the call site.
--
-- Re-runnable: drop-then-create, no data touched, no privileges changed.
-- Grants are restated because DROP FUNCTION destroys the ACL and a bare CREATE
-- would pick up Postgres' default PUBLIC grant plus Supabase's anon/
-- authenticated defaults -- the exact regression 010/013/014/017/025 walked
-- into four times with team_feed, documented in
-- docs/superpowers/specs/2026-08-01-security-audit-and-remediation-design.md.
--
-- The restatement REPRODUCES the live ACL rather than guessing at it. Read
-- from pg_proc.proacl before writing this file: team_members_list currently
-- holds exactly `postgres=X | authenticated=X | service_role=X` -- no PUBLIC,
-- no anon. So the revoke below is a no-op today and exists only to stop the
-- fresh CREATE from widening access; the grant restores what was there. For
-- contrast, team_feed's live ACL right now reads `=X/postgres | ... | anon=X`
-- -- PUBLIC and anon both present, which is that same regression still sitting
-- in production and is 042's job on `agent-sec`, not this file's.
--
-- Rollback: supabase/rollback/pre-053-team-members-list-deleted-at.sql.
--
-- Verify after applying (expect a deleted_at column, null for every live
-- account):
--   select * from public.team_members_list('<a team id you belong to>');


drop function if exists public.team_members_list(uuid);

create or replace function public.team_members_list(p_team uuid)
returns table (
  user_id uuid,
  display_name text,
  role text,
  joined_at timestamptz,
  deleted_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id, m.display_name, m.role, m.joined_at, u.deleted_at
  from public.team_members m
  -- left join: a member whose auth.users row is genuinely gone keeps their
  -- row here with a null deleted_at (read as live) rather than disappearing
  -- from every roster in the product. See §2 of the header.
  left join auth.users u on u.id = m.user_id
  where m.team_id = p_team and public.is_team_member(p_team)
  order by m.joined_at;
$$;

-- DROP FUNCTION destroyed the ACL; restate it. Same shape 035 uses for
-- delete_my_entries: never public/anon, always the two roles that need it.
revoke execute on function public.team_members_list(uuid) from public, anon;
grant execute on function public.team_members_list(uuid) to authenticated, service_role;
