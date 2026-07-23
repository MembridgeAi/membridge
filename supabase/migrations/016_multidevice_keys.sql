-- ---------------------------------------------------------------------------
-- 016_multidevice_keys.sql — key storage per (user, device), not per user.
--
-- The bug this fixes: member_pubkeys was keyed by user_id and team_keys by
-- (team_id, epoch, member_user_id) — one keypair slot per user. A user's second
-- device mints its own keypair (private keys never leave a device), overwrites
-- the single pubkey slot, and cannot open the team key sealed to the first
-- device. It is "not missing" at the epoch, so the join-seal skips it forever →
-- ENCRYPTION PAUSED on the second device.
--
-- The model becomes per-device: pubkeys keyed by (user_id, device_id), and a
-- sealed team_keys row per (member, device) per epoch. A new device is then
-- join-sealed exactly like a new member.
--
-- Deviation from the original design note: it proposed leaving device_id NULLABLE
-- and the team_keys PK unchanged. That does NOT work — a second device's row for
-- the same (team, epoch, member) collides with the existing PK no matter what
-- device_id holds, so the new device never gets its own row. device_id must join
-- the PK, which requires NOT NULL; legacy rows are backfilled to '' (a sentinel,
-- since a PK column cannot be NULL) and stay readable by the device that already
-- holds the key. The client always writes a real device_id on new rows.
--
-- Re-runnable and guarded (same discipline as 009/013). Apply to the live
-- Supabase backend BEFORE shipping the client. RLS policies are unchanged: they
-- gate on user_id / team membership, which device_id does not affect.
-- ---------------------------------------------------------------------------

-- member_pubkeys: one published pubkey per (user, device).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'member_pubkeys' and column_name = 'device_id'
  ) then
    alter table public.member_pubkeys add column device_id text;
    -- Existing rows carry no device. Clear them — ensureIdentity re-uploads this
    -- device's pubkey on the next sync, so nothing is permanently lost, and it
    -- avoids inventing a device_id for a key whose device we cannot know.
    delete from public.member_pubkeys;
    alter table public.member_pubkeys alter column device_id set not null;
    alter table public.member_pubkeys drop constraint member_pubkeys_pkey;
    alter table public.member_pubkeys add primary key (user_id, device_id);
  end if;
end $$;

-- team_keys: one sealed copy per (member, device) per epoch. device_id joins the
-- primary key so a second device gets its OWN row instead of colliding with the
-- first device's. NOT cleared — clearing would destroy decryptability of every
-- existing entry. Legacy rows backfill to '' and remain openable by the device
-- that already holds the original key.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'team_keys' and column_name = 'device_id'
  ) then
    alter table public.team_keys add column device_id text;
    update public.team_keys set device_id = '' where device_id is null;
    alter table public.team_keys alter column device_id set not null;
    alter table public.team_keys alter column device_id set default '';
    alter table public.team_keys drop constraint team_keys_pkey;
    alter table public.team_keys add primary key (team_id, epoch, member_user_id, device_id);
  end if;
end $$;

-- The client's hot path is still "my sealed rows"; keep it covered per device.
create index if not exists team_keys_member_device_idx
  on public.team_keys (member_user_id, device_id);
