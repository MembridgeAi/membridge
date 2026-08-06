-- 052_account_deletion_fk_actions.sql — give five of the seven foreign keys
-- that block account deletion an on-delete action, so that deleting a user
-- stops failing on constraints whose correct behaviour is not in dispute.
--
-- ===========================================================================
-- *** NOT APPLIED. DO NOT APPLY YET. THIS FILE IS AWAITING A DECISION. ***
--
-- Every other pending migration in this tree is "written, not yet applied,
-- apply it before the next release". THIS ONE IS DIFFERENT and the difference
-- is the point: it is one half of a feature whose other half is a product
-- decision that has not been made. Applying it alone does not make account
-- deletion work — `memory_entries.author_id` still blocks every real user —
-- and it quietly removes five of the seven guardrails that currently make a
-- dashboard deletion refuse rather than half-succeed.
--
-- Read docs/ACCOUNT-DELETION.md §6 first. If §6 is still open, this file is
-- still parked. It is committed so the work is not lost and so the decision
-- can be made against something concrete, NOT because it is ready.
-- ===========================================================================
--
-- REGISTRY. 052 is the next free number per supabase/APPLY-RUNBOOK.md on
-- `agent-sec` ("Next free number: 052"), read with `git show
-- agent-sec:supabase/APPLY-RUNBOOK.md` BEFORE this file was written, which is
-- the rule the runbook states and the one three collisions were caused by
-- breaking. The runbook does not exist on `master`, so the claiming row could
-- not be added from this branch. Whoever merges `agent-sec` must add:
--
--   | 052 | Account-deletion FK actions on five uncontested constraints
--         | `agent-deletion` | no |
--
-- and set next-free to 053. Until then test/suites/migration-state.test.js
-- (also `agent-sec`-only) fails this file on the unclaimed-number gate. That
-- is the gate doing its job, not a defect here.
--
-- PREREQUISITE: 050_team_audit_actor_set_null.sql, on `agent-removal`.
-- team_audit.actor_id is the seventh blocking constraint and 050 already fixes
-- it, with the reasoning this file's §"SET NULL, NOT CASCADE" is built on. It
-- is deliberately NOT restated here. Reaching into another lane's file to
-- redo work they have already argued is the hazard 046 exists to avoid, and
-- 050's own header sets that rule. Apply 050; this file assumes it.
--
-- ===========================================================================
-- THE FINDING, IN FULL, BECAUSE THIS FILE ONLY ADDRESSES PART OF IT
--
-- Seven foreign keys reference auth.users with no on-delete action, so any
-- account that has ever done anything cannot be deleted. Read from the LIVE
-- catalog on 2026-08-05, not from schema.sql:
--
--   BLOCKING (no action, not deferrable -> 23503 at statement time):
--     teams.created_by          NOT NULL   founded a team          <- §1 here
--     projects.created_by       NOT NULL   linked a project        <- §2 here
--     projects.archived_by      nullable   archived one            <- §3 here
--     project_access.updated_by nullable   set someone's access    <- §4 here
--     invites.created_by        NOT NULL   minted an invite        <- §5 here
--     team_audit.actor_id       nullable   audited team action     <- 050
--     memory_entries.author_id  NOT NULL   EVER SYNCED ANYTHING    <- NOT FIXED
--
--   ALREADY CORRECT (on delete cascade), unchanged by this file:
--     team_members.user_id, member_pubkeys.user_id, team_keys.member_user_id
--
-- 050's header counts these as "SIX foreign keys" and then lists seven. The
-- list is right, the count is one low. Seven block; 050 fixes one; this file
-- fixes five; ONE REMAINS ON PURPOSE.
--
-- memory_entries.author_id is not fixed here because its correct behaviour is
-- a policy question this codebase has already argued with itself about:
-- 029:312 and 033:156 both state a departed member's contributions are never
-- deleted, while 035 §1 deliberately scopes its delete policy on author_id
-- ALONE so that a departed or revoked member is not stranded. Both positions
-- are reasoned. Account deletion sits on the seam. docs/ACCOUNT-DELETION.md §5
-- costs out cascade / set-null / explicit-choice; §6 states the decision and
-- leaves it to the product owner.
--
-- LEAVING IT BLOCKING IS THE SAFE STATE, not an omission. While it blocks, a
-- dashboard deletion attempt REFUSES. A refused deletion is recoverable; a
-- 2,000-row cascade with no audit row, or a set-null that leaves author_name
-- in place and reports success, is not.
-- ===========================================================================
--
-- ===========================================================================
-- SET NULL, NOT CASCADE, ON ALL FIVE — and on two of them cascade is not
-- merely untidy, it is destructive.
--
-- 1. teams.created_by AND projects.created_by SIT AT THE HEAD OF A CASCADE
--    CHAIN INTO EVERY OTHER MEMBER'S DATA.
--
--      teams -> projects        (projects.team_id, on delete cascade)
--      projects -> memory_entries (memory_entries.project_id, on delete cascade)
--
--    So `on delete cascade` on teams.created_by means: the founder deletes
--    their account, and the team, its projects, its audit trail and EVERY
--    MEMBER'S ENTRIES go with it. On projects.created_by it is the same one
--    level down. Live figures: marco@melika.com founded 2 teams and linked 3
--    projects; that single cascade would take all 2,275 memory_entries rows
--    across all three authors. Cascade is never the answer on a created_by.
--
-- 2. THE ROWS RECORD WHAT SOMEONE DID TO OTHER PEOPLE. project_access.
--    updated_by is on rows about OTHER MEMBERS' access to projects. An admin
--    who revoked five colleagues is the actor on five rows that are about
--    those colleagues. Deleting your account must not be a way to unmake
--    decisions imposed on other people. Same argument 050 makes for
--    team_audit.actor_id, applied to the table next to it.
--
-- 3. THE SCHEMA ALREADY MADE THIS CALL. ops_audit.target_team is
--    `references public.teams (id) on delete set null` (021:42) — a dead link
--    on a record worth keeping, answered with set null, on the one table whose
--    whole purpose is to outlive what it describes.
--
-- WHAT SET NULL COSTS, said plainly: attribution. After this, a team page
-- cannot say who founded the team, a project cannot say who linked or archived
-- it, and an access row cannot say who last changed it. That is the intended
-- trade — the FACT survives, the PERSON does not. Nothing is lost that any
-- code depends on; see the next section.
--
-- WHAT SET NULL DOES NOT ACHIEVE: it is not erasure. It severs the link
-- between a row and an account. Where a display name is stored as text beside
-- the id — memory_entries.author_name (not null), team_audit detail.targetName
-- — the name survives untouched, because no foreign key can reach a text
-- column. Anyone reading this file for GDPR assurance should read this
-- paragraph as the answer: IT IS NOT SUFFICIENT. Scrubbing those names is an
-- UPDATE on tables designed to be append-only (024/025 §5) and is a separate,
-- deliberate decision, not something to smuggle in behind a constraint change.
-- ===========================================================================
--
-- ===========================================================================
-- DROPPING NOT NULL ON teams.created_by AND projects.created_by IS SAFE, AND
-- THIS WAS CHECKED RATHER THAN ASSUMED.
--
-- set null on a NOT NULL column is not legal, so §1 and §2 must loosen the
-- column first. That is a schema weakening and it deserves proof, because if
-- anything authorized on created_by, nulling it would be a privilege bug.
--
-- Checked against the LIVE catalog, not the repo:
--
--   * NO RLS POLICY reads created_by. Every policy on teams, projects,
--     memory_entries, project_access, team_audit, team_members, team_keys and
--     member_pubkeys was dumped and read: authorization runs through
--     is_team_member / is_team_manager / can_see_project / auth.uid(), and
--     is_team_manager resolves team_role from team_members.role. Ownership is
--     a MEMBERSHIP ROLE, never the creator id.
--   * ONLY FIVE FUNCTIONS MENTION created_by — create_team, link_project,
--     create_invite, ops_create_onboarding_invite, ops_onboarding_invites —
--     and the first three only WRITE it. The two ops functions read
--     onboarding_invites.created_by, which is a TEXT column and a different
--     thing entirely; no auth.users reference, untouched here.
--   * NOTHING IN lib/, ui/src/ OR bin/ reads created_by at all. It is not on
--     the team_feed wire and no client renders it.
--
-- So created_by is informational today. A null reads as "the account that
-- created this is gone", which is a true statement, and no code branches on it.
--
-- Whoever adds a UI for it later: a null here is a POSITIVE FACT (the account
-- was deleted), not "we could not resolve this person". 050's closing note
-- makes the same distinction for team_audit and it applies verbatim.
-- ===========================================================================
--
-- ===========================================================================
-- WHAT THIS FILE DOES NOT DO, AND WHY DELETION STILL WILL NOT WORK AFTER IT
--
-- Stated here rather than in the doc alone, because the tempting misreading of
-- this file is "constraints fixed, ship it".
--
-- 1. memory_entries.author_id STILL BLOCKS. Every user with a single synced
--    entry remains undeletable. That is deliberate — see above.
--
-- 2. THE LAST OWNER IS UNGUARDED, and this file makes that live rather than
--    theoretical. THIS IS NOT A FOLLOW-UP: the guard ships with 052 or 052
--    does not ship, because 052 is the thing that removes the block currently
--    masking it. Applying this file as a standalone tidy-up is the one way to
--    turn a latent hazard into a reachable one.
--    team_members.user_id is `on delete cascade`, so deleting an
--    owner's account removes their membership row — which is precisely what
--    leave_team refuses to do:
--
--        if public.team_role(p_team) = 'owner' then
--          raise exception 'the owner cannot leave their own team';
--
--    Because authorization is team_members.role, the result is a team with NO
--    OWNER: no invites, no removals, no access changes, no audit reads, for
--    anyone, permanently. Today teams.created_by masks this by blocking the
--    delete. §1 REMOVES THAT MASK. So the deletion path MUST refuse an account
--    that is the sole owner of any team, until ownership is transferred.
--    That is an RPC check, not a constraint — the FK that would enforce it is
--    the cascade, and the cascade is correct for every other purpose.
--
-- 3. THERE IS NO DELETION PATH AT ALL. No auth-admin call, no CLI subcommand,
--    no UI control exists anywhere in the product; the Supabase dashboard is
--    the only way to attempt it. docs/ACCOUNT-DELETION.md §4.2 specifies the
--    RPC shape, including that the audit row must be written BEFORE the
--    account goes — team_audit_insert requires `actor_id = auth.uid()`, so
--    afterwards there is no caller who can write it.
--
-- 4. DO NOT IMPLEMENT ANY OF THIS AS A TRIGGER ON memory_entries. 040's header
--    documents why: memory_entries -> projects -> teams all cascade, so a
--    trigger inserting into team_audit (whose team_id references the team
--    being deleted) fails its own foreign key and aborts team deletion, with
--    an error pointing at the audit table rather than at the trigger.
--
-- 5. NOTHING HERE REACHES TEAMMATES' MACHINES. Shared entries are copied to
--    every teammate's state.json (teamEntries) and to
--    <project>/.membridge/teammate-notes.json, both read with NO NETWORK CALL
--    by search_memory, why, the SessionStart injection and the recall hook.
--    markTeamDataDeleted writes its watermark ONLY on the deleting user's own
--    machine. There is no tombstone on the wire. Backend deletion is not
--    erasure from the team, and no migration can make it so.
-- ===========================================================================
--
-- OPERATIONAL WARNING, for whoever holds the Supabase dashboard in the
-- meantime: DO NOT USE "SOFT DELETE" ON A USER. It sets auth.users.deleted_at
-- and leaves the row, so it dodges all seven constraints and always succeeds —
-- and NOTHING in supabase/, lib/ or ui/src/ reads deleted_at (grepped: zero
-- hits). The person stays a visible teammate, keeps their name on every entry,
-- and merely loses the ability to sign in. It is a suspension presented as a
-- deletion, and it is the one button here that produces a wrong state today.
-- Worse than cosmetic: the re-seal loop in lib/teamsync.js derives recipients
-- from team_members_list, whose row survives a soft delete, so EVERY NEW TEAM
-- KEY EPOCH KEEPS BEING SEALED TO THE DELETED ACCOUNT'S PUBLIC KEY. Use
-- remove_member ("Remove from team") instead — it is the operation that
-- actually does the offboarding. Full write-up and the backend fix:
-- docs/ACCOUNT-DELETION.md §8.
--
-- Re-runnable. Drop-then-add is the only way to change a foreign key's
-- referential action — Postgres has no `alter constraint ... on delete` — and
-- `drop constraint if exists` plus `alter column ... drop not null` are both
-- no-ops on a second run. Constraint names are Postgres' defaults for inline
-- column references (<table>_<column>_fkey), verified against pg_constraint on
-- the live database rather than assumed. Paste into the Supabase SQL editor,
-- which runs the whole file in one transaction.
--
-- Rollback: supabase/rollback/pre-052-account-deletion-fk-actions.sql.


-- ---------------------------------------------------------------------------
-- 1. teams.created_by -> set null.
--
-- The team outlives its founder. Cascade here destroys the team, its projects
-- and every member's entries; see the cascade-chain note above. NOT NULL is
-- dropped first because set null is illegal without it, and it is safe because
-- nothing reads this column for authorization or display.
-- ---------------------------------------------------------------------------
alter table public.teams
  alter column created_by drop not null;

alter table public.teams
  drop constraint if exists teams_created_by_fkey;

alter table public.teams
  add constraint teams_created_by_fkey
  foreign key (created_by) references auth.users (id)
  on delete set null;


-- ---------------------------------------------------------------------------
-- 2. projects.created_by -> set null.
--
-- Same shape one level down: cascade would take every author's entries in the
-- project, not just the departing member's. The project is team property; who
-- first linked it is a footnote.
-- ---------------------------------------------------------------------------
alter table public.projects
  alter column created_by drop not null;

alter table public.projects
  drop constraint if exists projects_created_by_fkey;

alter table public.projects
  add constraint projects_created_by_fkey
  foreign key (created_by) references auth.users (id)
  on delete set null;


-- ---------------------------------------------------------------------------
-- 3. projects.archived_by -> set null.
--
-- Already nullable (schema.sql:41 declares it without NOT NULL), so this needs
-- no data migration and no existing row changes. archived_at is the fact that
-- matters and it is a separate column; the attribution may go. 050's header
-- identifies this as the same one-line change and defers it only to avoid
-- editing a table another lane was working in.
-- ---------------------------------------------------------------------------
alter table public.projects
  drop constraint if exists projects_archived_by_fkey;

alter table public.projects
  add constraint projects_archived_by_fkey
  foreign key (archived_by) references auth.users (id)
  on delete set null;


-- ---------------------------------------------------------------------------
-- 4. project_access.updated_by -> set null.
--
-- The clearest case of the rule: these rows are ABOUT OTHER PEOPLE'S ACCESS.
-- The grant or revoke must survive the person who set it; only the attribution
-- goes. Already nullable (024:36).
--
-- Note the neighbouring column needs nothing: project_access.member_id has no
-- FK to auth.users and looks like an orphan risk, but the table carries
-- `(team_id, member_id) references team_members (team_id, user_id) on delete
-- cascade` (024:38-39), and team_members.user_id cascades from auth.users. So
-- a departing member's own access rows are already removed transitively.
-- Verified on the live database: zero project_access rows name a member_id
-- with no auth.users row.
-- ---------------------------------------------------------------------------
alter table public.project_access
  drop constraint if exists project_access_updated_by_fkey;

alter table public.project_access
  add constraint project_access_updated_by_fkey
  foreign key (updated_by) references auth.users (id)
  on delete set null;


-- ---------------------------------------------------------------------------
-- 5. invites.created_by -> set null.
--
-- Cascade is wrong: an invite row carries use_count, so it records real joins,
-- and deleting it erases who invited whom. Set null keeps the record.
--
-- BUT SET NULL ALONE IS NOT THE WHOLE ANSWER HERE, and this is the one place
-- in this file where the constraint change needs a companion in code. A LIVE,
-- UNREDEEMED invite whose creator is gone is a standing credential nobody
-- owns — the same hazard 044 and 045 close for removal and for leaving, by
-- rotating the team's invite code when someone goes. The deletion RPC (see
-- docs/ACCOUNT-DELETION.md §4.2) must stamp invites.revoked_at on the
-- departing account's unredeemed invites BEFORE the delete, and only then let
-- this constraint null the attribution on the rest. revoked_at already exists
-- on the table, so nothing new is needed to express it.
--
-- Deliberately NOT done by cascade or by trigger: revoking is a decision about
-- live credentials and belongs in the audited deletion path where it can be
-- recorded, not in a referential action that fires silently.
-- ---------------------------------------------------------------------------
alter table public.invites
  alter column created_by drop not null;

alter table public.invites
  drop constraint if exists invites_created_by_fkey;

alter table public.invites
  add constraint invites_created_by_fkey
  foreign key (created_by) references auth.users (id)
  on delete set null;


-- ---------------------------------------------------------------------------
-- VERIFY, after applying. Every row should read SET NULL except
-- memory_entries.author_id, which must still read NO ACTION until the decision
-- in docs/ACCOUNT-DELETION.md §6 is made. If memory_entries shows anything
-- else, someone applied that change out of band and §6 needs re-reading.
--
--   select c.conname,
--          case c.confdeltype when 'a' then 'NO ACTION' when 'c' then 'CASCADE'
--                             when 'n' then 'SET NULL'  else c.confdeltype::text
--          end as on_delete
--     from pg_constraint c
--     join pg_class t on t.oid = c.conrelid
--    where c.contype = 'f'
--      and c.confrelid = 'auth.users'::regclass
--      and t.relnamespace = 'public'::regnamespace
--    order by 1;
-- ---------------------------------------------------------------------------
