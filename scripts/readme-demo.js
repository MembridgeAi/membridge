'use strict';
// Spins up a throwaway MemBridge environment with fake-but-realistic data for
// the README screenshots (docs/screenshots/): two users (you + "Andrew")
// sharing a "shop-app" project, driven through the real client code against
// the offline mock Supabase from the test suite. Nothing touches your real
// ~/.membridge, ~/.claude or ~/.codex.
//
// Run: node scripts/readme-demo.js
// Then open http://127.0.0.1:7541 and screenshot Projects / Activity /
// project page / Team. Ctrl-C to stop; delete ~/.cache/membridge-demo (and
// DEMO_WORK, if you changed it) when done.
//
// Demo paths must stay OUT of temp/scratchpad locations — the capture-hygiene
// filter (util.isTempPath) drops any session whose files live under
// /private/tmp, /tmp/claude-*, or a path with a "scratchpad" segment.
// DEMO_WORK is what shows as the project path in the Projects screenshot;
// point it somewhere prettier (e.g. ~/work) before shooting if you care.
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..');
const DEMO = path.join(os.homedir(), '.cache', 'membridge-demo');
const WORK = process.env.DEMO_WORK || path.join(DEMO, 'work');
const SHOP = path.join(WORK, 'shop-app');
const DOCS = path.join(WORK, 'docs-site');
const ANDREW_SHOP = path.join(DEMO, 'andrew-work', 'shop-app');
const PORT = 7541;
const TEAM_PORT = 17961;

// Timestamps are relative to now so "2h ago" style labels stay believable.
const hoursAgo = h => new Date(Date.now() - h * 3600 * 1000).toISOString();
const T = {
  applePay: [hoursAgo(20), hoursAgo(19.9), hoursAgo(19.8), hoursAgo(19.7)],
  receiptPdf: [hoursAgo(22), hoursAgo(21.9), hoursAgo(21.8)],
  docsSite: [hoursAgo(24), hoursAgo(23.9), hoursAgo(23.8)],
  validate: [hoursAgo(3.3), hoursAgo(3.2)],
  coupons: [hoursAgo(2.7), hoursAgo(2.6)],
  cartTest: [hoursAgo(2), hoursAgo(1.9), hoursAgo(1.8), hoursAgo(1.7)],
  working: [hoursAgo(0.6), hoursAgo(0.5)],
};

const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n';
const write = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };

function buildProjects() {
  write(path.join(SHOP, 'package.json'), JSON.stringify({ name: 'shop-app', version: '1.4.2' }, null, 2) + '\n');
  write(path.join(SHOP, 'CLAUDE.md'), '# shop-app\n\nTeam notes live here.\n');
  write(path.join(SHOP, 'src', 'checkout', 'payment.js'), 'export const pay = () => {};\n');
  write(path.join(SHOP, 'src', 'checkout', 'apple-pay.js'), 'export const applePay = () => {};\n');
  write(path.join(SHOP, 'src', 'checkout', 'validate.js'), 'export const validate = () => {};\n');
  write(path.join(SHOP, 'src', 'receipts', 'pdf.js'), 'export const receiptPdf = () => {};\n');
  write(path.join(SHOP, 'src', 'cart.js'), 'export const cart = [];\n');
  write(path.join(SHOP, 'test', 'cart.test.js'), 'test("totals", () => {});\n');
  fs.mkdirSync(path.join(SHOP, '.membridge'), { recursive: true });

  write(path.join(DOCS, 'package.json'), JSON.stringify({ name: 'docs-site', version: '0.3.0' }, null, 2) + '\n');
  write(path.join(DOCS, 'pages', 'pricing.mdx'), '# Pricing\n');
  write(path.join(DOCS, 'pages', 'index.mdx'), '# Home\n');
  fs.mkdirSync(path.join(DOCS, '.membridge'), { recursive: true });

  // Andrew's clone of the same repo (its path never shows in your UI)
  write(path.join(ANDREW_SHOP, 'package.json'), JSON.stringify({ name: 'shop-app', version: '1.4.2' }, null, 2) + '\n');
  write(path.join(ANDREW_SHOP, 'src', 'checkout', 'validate.js'), 'export const validate = () => {};\n');
  write(path.join(ANDREW_SHOP, 'src', 'receipts', 'pdf.js'), 'export const receiptPdf = () => {};\n');
  fs.mkdirSync(path.join(ANDREW_SHOP, '.membridge'), { recursive: true });
}

function buildMarcoSessions() {
  const c = path.join(DEMO, 'marco-claude');
  const shopDir = path.join(c, 'demo-shop-app');
  const docsDir = path.join(c, 'demo-docs-site');

  // Yesterday: Apple Pay (finished, distilled)
  write(path.join(shopDir, '5f2a9c1e-4b7d-4a2e-9c31-a1e8f0b2d611.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Add Apple Pay to the checkout' }, cwd: SHOP, timestamp: T.applePay[0] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(SHOP, 'src', 'checkout', 'payment.js') } }] }, cwd: SHOP, timestamp: T.applePay[1] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: path.join(SHOP, 'src', 'checkout', 'apple-pay.js') } }] }, cwd: SHOP, timestamp: T.applePay[2] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Apple Pay is wired into checkout behind a capability check.' }] }, cwd: SHOP, timestamp: T.applePay[3] },
  ]));

  // Today: flaky cart test (finished, distilled)
  write(path.join(shopDir, '8d41b6f0-2c9a-4f5e-b8a7-6c0d9e3f1a22.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'The cart total test fails about once in five runs — find out why and fix it' }, cwd: SHOP, timestamp: T.cartTest[0] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(SHOP, 'test', 'cart.test.js') } }] }, cwd: SHOP, timestamp: T.cartTest[1] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(SHOP, 'src', 'cart.js') } }] }, cwd: SHOP, timestamp: T.cartTest[2] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed: the test depended on float addition order.' }] }, cwd: SHOP, timestamp: T.cartTest[3] },
  ]));

  // ~30 min ago: still in flight (no summary yet -> "Working on")
  write(path.join(shopDir, 'b3e7d2c8-9a1f-4e6b-8c4d-2f5a7b9e0c33.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Migrate the product images to WebP with a JPEG fallback' }, cwd: SHOP, timestamp: T.working[0] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(SHOP, 'src', 'cart.js') } }] }, cwd: SHOP, timestamp: T.working[1] },
  ]));

  // Yesterday, docs-site: local-only project, harvested summary (>=80 chars
  // or the adapter drops it as "Done." noise)
  write(path.join(docsDir, 'c9f0a4d2-1b8e-4c7a-9d5f-3e6b8a0c1d44.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Rewrite the pricing page hero — shorter, and lead with the free tier' }, cwd: DOCS, timestamp: T.docsSite[0] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(DOCS, 'pages', 'pricing.mdx') } }] }, cwd: DOCS, timestamp: T.docsSite[1] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The pricing hero now leads with the free tier and is down to two sentences — the plan comparison table moved below the fold.' }] }, cwd: DOCS, timestamp: T.docsSite[2] },
  ]));

  // Today: a Codex session on shop-app
  write(path.join(DEMO, 'marco-codex', '2026', '07', '21', 'rollout-demo-coupons.jsonl'), jsonl([
    { timestamp: T.coupons[0], type: 'session_meta', payload: { id: 'cdx-marco-coupons', cwd: SHOP } },
    { timestamp: T.coupons[1], type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add unit tests for the coupon stacking rules' }] } },
  ]));

  // Distilled summaries, as the Stop hook would have written them. For Codex
  // sessions the session id is the rollout FILENAME stem, not payload.id.
  write(path.join(SHOP, '.membridge', 'summaries.jsonl'), jsonl([
    { session: '5f2a9c1e-4b7d-4a2e-9c31-a1e8f0b2d611', ts: T.applePay[3],
      goal: 'Add Apple Pay to the checkout',
      did: 'Checkout now offers Apple Pay on supported devices and falls back to the card form everywhere else.',
      decisions: 'Gated behind a capability check so unsupported browsers never see a dead button.',
      highlights: [{ file: 'src/checkout/apple-pay.js', note: 'the capability check lives here' }] },
    { session: '8d41b6f0-2c9a-4f5e-b8a7-6c0d9e3f1a22', ts: T.cartTest[3],
      goal: 'Fix the flaky cart total test',
      did: 'The cart total test is deterministic now — totals are summed in cents, so float order no longer changes the result.',
      gotchas: 'The flake only reproduced with 3+ discounted items.' },
    { session: 'rollout-demo-coupons', ts: T.coupons[1],
      goal: 'Add unit tests for the coupon stacking rules',
      did: 'Coupon stacking is covered by twelve new unit tests, including the two-percent-plus-fixed edge case that used to be undefined behavior.' },
  ]));
}

function buildAndrewSessions() {
  const shopDir = path.join(DEMO, 'andrew-claude', 'demo-shop-app');

  // Yesterday: receipt PDFs (finished, distilled)
  write(path.join(shopDir, 'e1d8c5b2-7f4a-4b9e-a6c3-8d0f2e5a7b55.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Wire the receipt PDF into the order confirmation email' }, cwd: ANDREW_SHOP, timestamp: T.receiptPdf[0] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(ANDREW_SHOP, 'src', 'receipts', 'pdf.js') } }] }, cwd: ANDREW_SHOP, timestamp: T.receiptPdf[1] },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Order confirmations now attach the receipt as a PDF.' }] }, cwd: ANDREW_SHOP, timestamp: T.receiptPdf[2] },
  ]));

  // Today: Andrew's Codex refactors checkout validation
  write(path.join(DEMO, 'andrew-codex', '2026', '07', '21', 'rollout-demo-validate.jsonl'), jsonl([
    { timestamp: T.validate[0], type: 'session_meta', payload: { id: 'cdx-andrew-validate', cwd: ANDREW_SHOP } },
    { timestamp: T.validate[1], type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Refactor checkout validation so address and payment checks run in one pass' }] } },
  ]));

  write(path.join(ANDREW_SHOP, '.membridge', 'summaries.jsonl'), jsonl([
    { session: 'e1d8c5b2-7f4a-4b9e-a6c3-8d0f2e5a7b55', ts: T.receiptPdf[2],
      goal: 'Wire the receipt PDF into the order confirmation email',
      did: 'Order confirmation emails now attach the receipt as a PDF, rendered from the same template the web receipt uses.' },
    { session: 'rollout-demo-validate', ts: T.validate[1],
      goal: 'Refactor checkout validation',
      did: 'Checkout validation runs address and payment checks in a single pass, so a bad card no longer hides an address error behind a second round-trip.' },
  ]));
}

function setEnv(user) {
  process.env.MEMBRIDGE_HOME = path.join(DEMO, `${user}-home`);
  process.env.MEMBRIDGE_CLAUDE_DIR = path.join(DEMO, `${user}-claude`);
  process.env.MEMBRIDGE_CODEX_DIR = path.join(DEMO, `${user}-codex`);
}

async function main() {
  buildProjects();
  buildMarcoSessions();
  buildAndrewSessions();

  const { createMockSupabase } = require(path.join(APP, 'test', 'mock-supabase'));
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(TEAM_PORT, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = `http://127.0.0.1:${TEAM_PORT}`;
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-demo';
  process.env.MEMBRIDGE_PORT = String(PORT);

  const util = require(path.join(APP, 'lib', 'util'));
  const teamsync = require(path.join(APP, 'lib', 'teamsync'));
  const { syncOnce } = require(path.join(APP, 'lib', 'scan'));
  const { startServer } = require(path.join(APP, 'lib', 'server'));

  const prepConfig = () => {
    util.ensureConfig();
    const cfg = util.loadUserConfig();
    cfg.team = { ...(cfg.team || {}), sharePrompts: true };
    util.saveUserConfig(cfg);
  };

  // You: ingest, sign up, create the team, link shop-app, push
  setEnv('marco');
  prepConfig();
  syncOnce();
  await teamsync.signup(util.getConfig(), 'marco@demo.dev', 'pw-marco', 'Marco');
  const team = await teamsync.createTeam(util.getConfig(), 'Acme');
  await teamsync.linkProject(util.getConfig(), SHOP, team.team_id, 'Acme');
  await teamsync.syncTeams();

  // Andrew: own home and dirs, join via invite, link his clone, push
  setEnv('andrew');
  prepConfig();
  syncOnce();
  await teamsync.signup(util.getConfig(), 'andrew@demo.dev', 'pw-andrew', 'Andrew');
  await teamsync.joinTeam(util.getConfig(), team.invite_code);
  await teamsync.linkProject(util.getConfig(), ANDREW_SHOP, team.team_id, 'Acme');
  await teamsync.syncTeams();

  // Back to you: pull Andrew's entries, refresh context blocks, serve
  setEnv('marco');
  const r = await teamsync.syncTeams();
  for (const key of r.changed || []) syncOnce({ project: key });
  syncOnce();
  startServer(PORT);
  console.log(`demo dashboard on http://127.0.0.1:${PORT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
