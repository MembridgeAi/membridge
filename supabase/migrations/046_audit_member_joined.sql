-- 046_audit_member_joined.sql: make a join auditable. Today it structurally
-- cannot be recorded, so the one event that means somebody GAINED access to the
-- team's memory is the only one the trail has never held.
--
-- THE FINDING (auditor's finding 2, pinned as failing checks in
-- test/suites/invite-lifetime.test.js on branch agent-hunt, commit fcab31a).
-- POST /api/team/join writes a `member-joined` row through
-- lib/api-access.js recordAudit, as the joiner. team_audit's insert policy is
-- `is_team_manager(team_id) and actor_id = auth.uid()` (024 §5, tightened by
-- 025 §5), and a fresh joiner is by definition role 'member' -- so the insert
-- is refused by RLS, and recordAudit swallows the refusal by design (a failed
-- log must never turn a completed action into a 500 the user retries). The
-- result: the write always fails, always silently, on every join since the
-- trail existed. Confirmed empirically, not only by reading -- production
-- team_audit holds invite-created and invite-revoked rows and ZERO joins,
-- across a team people have demonstrably joined.
--
-- The comment at lib/server.js:2667 claimed the row "lands on a team the
-- caller is now a member of -- team_audit's RLS insert policy requires exactly
-- that". The policy requires MANAGER, not member. That comment is corrected in
-- the same commit as this file, and the dead recordAudit call is removed: a
-- call that can only ever fail is worse than no call, because it reads as
-- coverage.
--
-- ===========================================================================
-- WHY A TRIGGER AND NOT THE RECOMMENDED RPC
--
-- The audit's recommendation was to write the event from inside
-- `join_team` / `redeem_invite`, which are already `security definer`, rather
-- than from the joiner's RLS context. The reasoning is right -- inside a
-- definer function the insert runs as the function owner, which is the table
-- owner, and a table owner is not subject to that table's RLS unless the table
-- carries FORCE ROW LEVEL SECURITY (it does not; nothing in this schema sets
-- it). That is exactly how 035 §3 already writes its own-data-deleted row. But
-- the SHAPE is worse than a trigger on three counts, and one of them is a
-- collision that would silently revert another lane's work:
--
-- 1. IT WOULD CLOBBER 038. Writing the event inside redeem_invite means
--    restating that function's whole body with `create or replace`. The
--    security lane's 038_invite_redeem_atomic.sql is changing that same
--    function, and this branch cannot see its contents. Applied after 038, a
--    restatement built from 029's body reverts their atomicity fix, in
--    silence, with no error and no failing test. A trigger touches neither
--    function, so the two migrations are independent in both orders.
--
-- 2. ZERO ARGUMENT SURFACE. A definer function that writes audit rows is a
--    function that can write ANY audit row, so what it accepts as arguments is
--    the whole security question. A trigger accepts nothing at all: team_id,
--    actor and subject are read off the row Postgres just inserted. There is
--    no parameter through which a caller could name a different team, a
--    different actor, or a different action. A separate
--    `record_join_audit(p_team uuid)` RPC would have been the weakest option
--    of the three -- it takes a team from the caller and can be called at any
--    time, so a member could mint join events for a team they are in whenever
--    they liked.
--
-- 3. IT CANNOT DRIFT FROM THE FACT IT RECORDS. The event fires from the INSERT
--    itself, so a row exists if and only if a membership row was created. The
--    `on conflict do nothing` no-op case (joining twice) writes nothing, with
--    no FOUND bookkeeping -- and 029's own header records how easily that
--    bookkeeping goes wrong, having had to capture `v_joined := found`
--    immediately because a later insert clobbered it. Any future path that
--    creates a membership is covered without being edited. This is the same
--    argument 032 makes for moving project_access materialization onto an
--    AFTER INSERT trigger on public.projects, and the same pattern.
--
-- WHAT RLS WOULD HAVE CHECKED, AND WHAT REPLACES IT. The insert policy has two
-- halves and they are treated differently on purpose:
--
--   * `actor_id = auth.uid()` -- the anti-blame-shifting half (025 §5: "a role
--     check alone lets an owner/admin blame another member for their own
--     write"). PRESERVED, by construction rather than by re-checking: actor_id
--     is `new.user_id`, and every path that inserts a membership row inserts
--     `auth.uid()` there (create_team, join_team and redeem_invite all do, and
--     team_members has NO insert policy at all -- schema.sql:112 defines only
--     team_members_select, so RLS defaults closed and no client can insert a
--     membership row directly). The actor cannot be steered.
--   * `is_team_manager(team_id)` -- DELIBERATELY NOT re-implemented. It is the
--     bug: it is why a joiner cannot record their own arrival. The invariant
--     that replaces it is narrower than a role check, not weaker: this
--     function can write exactly one row, describing the membership insert
--     that is happening, and cannot be reached any other way.
--
-- KNOWN LIMIT, stated rather than discovered later: if a future feature lets a
-- manager add a member directly, the row would name the ADDED PERSON as actor,
-- not the manager who added them. For today's paths actor and subject are the
-- same person, so nothing is misattributed; a future add-member path needs its
-- own event with its own actor, not a widening of this one.
--
-- Deploy gate, same discipline as 044/045: apply to the LIVE Supabase before
-- shipping. The offline suite runs against test/mock-supabase.js, which models
-- the trigger, so a missing live migration will NOT be caught by CI -- and the
-- symptom is silence, which is the entire finding. Re-runnable: `create or
-- replace` for the function, drop-then-create for the trigger (`create
-- trigger` has no `or replace` before PG14 and no `if not exists` at all --
-- the same convention 031 and 032 follow).
--
-- Rollback: supabase/rollback/pre-046-audit-member-joined.sql.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The trigger function.
--
-- `security definer` so the insert runs as the function owner and is therefore
-- not filtered by team_audit's manager-only insert policy. `set search_path =
-- public` pinned, without exception: a definer function with a caller-
-- influenced search_path is how a definer function becomes a privilege
-- escalation, and every definer function in this schema pins it.
--
-- detail carries memberId and targetName, mirroring the shape member-removed
-- already writes (lib/server.js) so lib/api-access.js readAudit resolves both
-- rows through one code path. targetName is `new.display_name` -- the value
-- the database STORED, read off the inserted row, not a parameter. It is not
-- the "caller-supplied free text in the audit trail" hazard the remove-member
-- route refuses to accept: this exact string is already this person's
-- display_name on team_members, is already what every other audit row about
-- them renders through nameById, and is already bounded by that column's
-- `char_length between 1 and 80` check. Capturing it adds no reachable
-- surface; what it adds is a row that stays readable after they leave, which
-- is the same durability property member-removed needed.
-- ---------------------------------------------------------------------------
create or replace function public.audit_member_joined()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.team_audit (team_id, actor_id, action, object_type, object_key, detail)
  values (
    new.team_id,
    new.user_id,
    'member-joined',
    'member',
    new.user_id::text,
    jsonb_build_object('memberId', new.user_id::text, 'targetName', new.display_name)
  );
  return null; -- AFTER trigger: the return value is ignored
end;
$$;

-- Not callable as a function: Postgres refuses to execute a `returns trigger`
-- function outside a trigger context ("trigger functions can only be called as
-- trigger triggers"), so this revoke is belt and braces rather than the
-- boundary. It is here because the boundary should not depend on a reader
-- knowing that rule.
revoke all on function public.audit_member_joined() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The trigger.
--
-- FOR EACH ROW, AFTER INSERT, and gated `when (new.role <> 'owner')`.
--
-- The role gate excludes exactly one path: create_team (schema.sql:149) inserts
-- the founder's own row with role 'owner'. A team's founder is not joining it,
-- and auditing that as a join would put a member-joined event on every team at
-- the moment of creation, before anyone could have joined anything. If team
-- creation deserves an audit event it is a different action with different
-- semantics ('team-created'), and it is not in scope here.
--
-- AFTER, not BEFORE: the row must exist before it is described. A BEFORE
-- trigger can still have its insert rolled back by a later constraint failure,
-- which would leave the trail asserting a join that did not happen -- the same
-- ordering rule lib/api-access.js recordAudit states for its own callers
-- ("only call this AFTER the mutation itself resolved").
-- ---------------------------------------------------------------------------
drop trigger if exists team_members_audit_join on public.team_members;
create trigger team_members_audit_join
  after insert on public.team_members
  for each row
  when (new.role <> 'owner')
  execute function public.audit_member_joined();

-- ---------------------------------------------------------------------------
-- DELIBERATELY NOT HERE
--
-- * team_audit's insert POLICY is unchanged. Widening it so a member could
--   POST their own row would let any member write any row about themselves --
--   arbitrary actions, arbitrary object keys, at any time. The whole point of
--   moving the write into a definer path is that the trail gains exactly one
--   new row it can produce, and no new row anyone can compose.
--
-- * no departure event. leave_team writes none, and cannot from the client for
--   the same reason a join could not: the leaver is not a manager, and by the
--   time the row would be written they are not a member either. That is the
--   mirror image of this finding and is not fixed here -- it needs the same
--   treatment on an AFTER DELETE trigger, and a decision about whether a
--   removal (which the daemon already audits as `member-removed`) would then
--   be double-counted. Named so it is not mistaken for covered.
--
-- * actorName for a departed member. readAudit resolves actor_id against the
--   CURRENT roster and falls back to 'Unknown', so once this person leaves,
--   their own join event says "Unknown joined". detail.targetName above keeps
--   the row readable, but the actor column has the same latent gap
--   lib/api-access.js targetName had until this branch fixed it. Pre-existing
--   and applies to every action, so it is reported rather than widened into
--   this migration.
-- ---------------------------------------------------------------------------
