'use strict';
// /api/project/block is the "prove it actually works" surface: it shows the
// user the memory block exactly as it sits in their CLAUDE.md, which is the
// one thing in the product that makes an agent's accumulated memory legible.
// If it disagrees with the writer about where the block IS, it either hides
// memory that is really there or reports "nothing written" about a file that
// carries a live block — and the user has no way to tell which.
//
// lib/digest.js resolves the span as indexOf(BEGIN) + lastIndexOf(END), and
// says why in a comment: a forged or hand-written end-marker must be
// re-absorbed on the next render rather than splitting the block at the fake
// one. lib/server.js's projectBlockPayload used indexOf(END) — the exact
// convention that comment warns against — so the reader and the writer
// disagreed about the same bytes.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const digest = require('../../lib/digest');
const { projectBlockPayload } = require('../../lib/server');

/** A throwaway project directory containing a CLAUDE.md with `text`. */
function projectWith(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-blockspan-'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), text);
  return dir;
}

const BLOCK_BODY = '## Project memory\nretries cap at 3\n';

async function main() {
  // THE FALSE NEGATIVE. A stray end-marker anywhere above the block makes
  // indexOf(END) land before indexOf(BEGIN); the `end < start` guard then
  // treats that as "no block in this file" and moves on. The user is told
  // nothing has been written while the block is sitting right there, and
  // digest.inject() will happily keep updating it.
  //
  // Reachable without any attacker: a CLAUDE.md that documents MemBridge's own
  // markers, or a file left half-edited by hand, is enough.
  await check('a stray end-marker above the block does not hide a block that is really there', () => {
    const dir = projectWith(
      `# Notes\nWe keep memory between ${digest.BEGIN} and ${digest.END}.\n\n` +
      `${digest.BEGIN}\n${BLOCK_BODY}${digest.END}\ntail\n`);
    const got = projectBlockPayload(dir);
    assert.ok(got.block, 'the block is in the file, so it must not be reported as absent');
    assert.match(got.block, /retries cap at 3/, 'and it must be the real block body');
  });

  // THE TRUNCATION. A marker smuggled inside the block splits it at the fake
  // one, so everything after it is silently dropped from the view while
  // remaining in the file. Worse than the false negative: it looks like a
  // complete answer.
  await check('a forged end-marker inside the block does not silently truncate what is shown', () => {
    const dir = projectWith(
      `${digest.BEGIN}\nfirst line\n${digest.END}\nsmuggled tail\n${digest.END}\n`);
    const got = projectBlockPayload(dir);
    assert.ok(got.block, 'a block is present');
    assert.match(got.block, /smuggled tail/,
      'everything up to the LAST end-marker is inside the block as far as ' +
      'digest.inject is concerned, so hiding it shows the user less than the ' +
      'file contains');
  });

  // THE INVARIANT, stated against the writer rather than against a literal:
  // whatever projectBlockPayload calls "the block" must be the same span
  // digest.inject() would replace. Pinning them to each other is what stops
  // the two conventions drifting apart again.
  await check('the reader and digest.inject agree on the span for the same file', () => {
    const text = `# Notes\nmine\n${digest.BEGIN}\n${BLOCK_BODY}${digest.END}\ntail\n`;
    const dir = projectWith(text);
    const file = path.join(dir, 'CLAUDE.md');

    const got = projectBlockPayload(dir);
    assert.strictEqual(got.file, file, 'must report the file it read');

    // What inject() considers "outside the block" is everything it preserves
    // when it swaps a new block in. Nothing the reader returned may appear there.
    digest.inject(file, [digest.BEGIN, 'REPLACED', digest.END].join('\n'));
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(!after.includes('retries cap at 3'),
      'guard: inject must actually have replaced the span the reader read');
    assert.ok(after.includes('mine') && after.includes('tail'),
      'guard: inject preserves the text outside the block');
    assert.ok(!/mine|tail/.test(got.block),
      'the reader must return ONLY what inject treats as the block');
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
