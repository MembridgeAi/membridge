'use client';
import { createClient } from '@supabase/supabase-js';

// One browser client for the whole app. Auth session persists in
// localStorage; every query runs under the signed-in user's RLS.
let client = null;

export function supabase() {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    );
  }
  return client;
}

// Display name kept in auth user metadata (the CLI keeps its own copy in
// credentials.json; entries carry the name they were pushed with).
// GitHub OAuth accounts have no display_name — GitHub writes full_name and
// user_name instead, so fall through those before the email fragment.
export function displayNameOf(user) {
  if (!user) return '';
  const m = user.user_metadata || {};
  return m.display_name || m.full_name || m.user_name || user.email?.split('@')[0] || '';
}

const PALETTE = ['#0052ff', '#0e9f6e', '#b43403', '#7c3aed', '#c81e64', '#0694a2', '#8a6a00'];

// Stable avatar color per author.
export function colorFor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function toolColor(source) {
  if (/claude/i.test(source || '')) return '#0052ff';
  if (/codex/i.test(source || '')) return '#4d7cff';
  return '#7c3aed';
}
