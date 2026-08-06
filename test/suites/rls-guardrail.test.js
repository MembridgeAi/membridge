'use strict';
// The RLS guardrail — `031`'s rewrite of public.rls_auto_enable(), checked
// against what production actually runs.
//
// CONTEXT. 031 is the one numbered migration that is genuinely unapplied (see
// supabase/MIGRATION-STATE.md). Production runs an ANCESTOR of this function
// that predates the repo: same job, but its exception branch logs and continues
// instead of refusing the CREATE. So today a table can be created in `public`
// with RLS off and the only trace is a line in the Postgres log.
//
// 031 fixes that. But 031 is a RECONSTRUCTION — nobody had the live body when
// it was written — and reconstructing a function from its behaviour loses
// whatever you did not know about. The live body was dumped read-only on
// 2026-08-05 and diffed against this file. The fail-closed change is exactly as
// intended. One other difference is NOT intended and is pinned below.
//
// WHY A TEST AND NOT A COMMENT. The whole point of 031 is that a table without
// RLS must not be able to come into existence quietly. A version of that
// guardrail with a gap in its own filter is worse than the permissive one it
// replaces, because it reads as protection. This has to fail loudly until the
// line is fixed, and it has to keep failing if anyone re-narrows it later.
//
// Runs offline against the migration text. It cannot check the live function —
// that needs credentials, and supabase/AUDIT-live-state.sql is the tool for it.
// STATUS (2026-08-05): THE 031 GUARDRAIL FINDING IS FIXED ELSEWHERE — not here.
// The fix is on `agent-sec`, commit 8cd3f6f ("fix(security): close the
// guardrail's own filter gap and the blanket table grants (SEC-6, SEC-7)"),
// which rewrites supabase/migrations/031_ensure_rls_event_trigger.sql.
//
// The failing check below is LEFT EXACTLY AS IT IS. It was run against that
// branch's 031 (substituted in, run, reverted) and PASSES: 6/6. It stays red
// here because this branch does not carry the fix, and it goes green when the
// branches merge — that transition is the proof. Do not edit it green.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const M031 = path.join(__dirname, '..', '..', 'supabase', 'migrations',
  '031_ensure_rls_event_trigger.sql');

// The function body only — the file quotes SQL in its header, and a naive
// substring search over the whole file would match prose about the live
// version rather than the definition this migration would install.
function functionBody(src) {
  const start = src.indexOf('create or replace function public.rls_auto_enable()');
  assert.ok(start !== -1, '031 must still define public.rls_auto_enable()');
  const end = src.indexOf('$$;', start);
  assert.ok(end !== -1, "031's rls_auto_enable definition must be terminated");
  return src.slice(start, end);
}

async function main() {
  const src = fs.readFileSync(M031, 'utf8');
  const body = functionBody(src);

  // THE FINDING. Live filters `object_type IN ('table','partitioned table')`.
  // 031 filters `obj.object_type = 'table'`. A partitioned table created in
  // public would therefore be skipped entirely by 031's version: no RLS
  // enabled, and — because the skip happens before the begin/exception block —
  // no raise either. It would be created silently without RLS, which is the
  // precise outcome this migration exists to make impossible.
  //
  // Not hypothetical as a shape: this stack already uses partitioned tables
  // (realtime.messages is one). None is in `public` today, which is why this is
  // a latent defect in an unapplied file rather than a live hole — but applying
  // 031 as written would bake the gap into the guardrail.
  await check("031's guardrail covers partitioned tables, as the live one does", () => {
    assert.match(body, /partitioned table/,
      "031 narrows object_type to 'table' only, dropping the 'partitioned table' " +
      "case the LIVE function covers (live: object_type IN ('table','partitioned " +
      "table')). A partitioned table in public would be skipped silently — no RLS, " +
      'no error. One-line fix in the object_type filter before this is applied.');
  });

  // The change 031 exists to make. Encoded so a later edit cannot quietly
  // restore the permissive branch — which is exactly what 031's own hint text
  // tells the operator not to do.
  await check('031 still refuses the CREATE rather than logging and continuing', () => {
    assert.match(body, /raise\s+exception/i,
      '031 must raise, not just log: the log-and-continue branch is the live ' +
      'behaviour it is meant to replace');
    assert.match(body, /refusing to create .* without row-level security/,
      "031's refusal message is what the operator sees; keep it specific");
  });

  // Both halves of the diagnosis must survive together. The log is written
  // before the raise on purpose: log output is not rolled back with the
  // transaction, so the cause is recorded even for a caller who only sees the
  // abort. Reordering these silently loses the diagnosis.
  await check('031 logs the cause BEFORE raising, so the abort is diagnosable', () => {
    const logAt = body.search(/raise\s+log/i);
    const raiseAt = body.search(/raise\s+exception/i);
    assert.ok(logAt !== -1 && raiseAt !== -1 && logAt < raiseAt,
      'the raise log must come before the raise exception — a rolled-back ' +
      'transaction keeps its log lines but nothing else');
  });

  // 031 must not be applied blind, and the reason has to stay attached to it:
  // create-or-replace would overwrite production's real function with this
  // reconstruction, carrying any difference along with the intended one.
  await check('031 still warns that it is a reconstruction of a live object', () => {
    assert.match(src, /reconstruction|RECONSTRUCTION/,
      '031 must keep saying it is a reconstruction — that warning is what makes ' +
      'a reader diff before applying, which is how the partitioned-table gap ' +
      'above was found at all');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
