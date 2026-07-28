'use strict';
// Per-project store of cached skeletons, keyed by relative path. Backs the
// recall serve policy (lib/recall.js): the hook only ever serves from what is
// already here, it never parses source or loads wasm at serve time.
//
// On disk, under <project>/.membridge/recall/:
//   <sha1(relPath).slice(0,16)>.json  — the full record for one path
//                                        (includes the skeleton text itself)
//   index.json                        — path -> lightweight metadata
//                                        (no skeleton text), so warm() and
//                                        future consumers (dashboard,
//                                        diagnostics) can answer "is this
//                                        path's cache fresh / how big is it"
//                                        without reading every blob.
//
// Every write goes through the same tmp-file + rename pattern lib/util.js's
// saveState and lib/ledger-store.js's writeLedger use: serialize, write to a
// throwaway temp file in the same directory, rename into place. A crash or
// write error can only ever leave a stray temp file behind, never a
// half-written record.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DIR_NAME } = require('./memorydb');
const digest = require('./digest');
const redact = require('./redact');
const { skeletonize, estimateTokens } = require('./skeleton');

// Bounded, constant: warm() is called once per sync pass off the ledger's hot
// set, never on an unbounded list.
const MAX_WARM_PER_CALL = 25;

const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');

const storeDir = projectPath => path.join(projectPath, DIR_NAME, 'recall');
const entryPath = (projectPath, relPath) => path.join(storeDir(projectPath), `${sha1(relPath).slice(0, 16)}.json`);
const indexPath = projectPath => path.join(storeDir(projectPath), 'index.json');

// Monotonic per-process counter so two writes in the same tick never collide
// on the temp path, mirroring util.js's saveStateCounter / ledger-store.js's
// writeLedgerCounter.
let writeCounter = 0;

function atomicWriteJSON(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify(data, null, 2); // throws before anything touches disk
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${writeCounter++}.tmp`);
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {} // best-effort; the write may never have landed
    throw err;
  }
}

function readIndex(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(indexPath(projectPath), 'utf8'));
  } catch {
    return {};
  }
}

function readEntry(projectPath, relPath) {
  try {
    return JSON.parse(fs.readFileSync(entryPath(projectPath, relPath), 'utf8'));
  } catch {
    return null;
  }
}

// get(projectPath, relPath) -> { skeleton, contentHash, skeletonTokens,
// fileTokens, rejections } | null. Fail-open: any read/parse error is a
// cache miss, never a thrown error -- callers (the hook) treat null exactly
// like "nothing cached", and step aside.
function get(projectPath, relPath) {
  const rec = readEntry(projectPath, relPath);
  if (!rec) return null;
  return {
    skeleton: rec.skeleton,
    contentHash: rec.contentHash,
    skeletonTokens: rec.skeletonTokens || 0,
    fileTokens: rec.fileTokens || 0,
    rejections: rec.rejections || 0,
  };
}

// put(projectPath, relPath, entry) -- entry: { contentHash, skeleton,
// skeletonTokens, fileTokens, engine, rejections }. Redacts the skeleton
// AGAIN here (warm() already redacts with the project's full config -- see
// below) as a backstop: this is the one place on the write path every caller
// funnels through, so even a future direct put() call can never land an
// unredacted secret on disk. Atomic temp+rename.
function put(projectPath, relPath, entry) {
  const record = {
    contentHash: entry.contentHash || '',
    skeleton: redact.redactDefault(String(entry.skeleton || '')),
    skeletonTokens: Number.isFinite(entry.skeletonTokens) ? entry.skeletonTokens : 0,
    fileTokens: Number.isFinite(entry.fileTokens) ? entry.fileTokens : 0,
    engine: entry.engine || 'strip',
    rejections: Number.isFinite(entry.rejections) ? entry.rejections : 0,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJSON(entryPath(projectPath, relPath), record);

  const idx = readIndex(projectPath);
  idx[relPath] = {
    contentHash: record.contentHash,
    skeletonTokens: record.skeletonTokens,
    fileTokens: record.fileTokens,
    engine: record.engine,
    rejections: record.rejections,
    updatedAt: record.updatedAt,
  };
  atomicWriteJSON(indexPath(projectPath), idx);
}

// bumpRejection(projectPath, relPath) -- the agent read the file anyway after
// being served its skeleton; count it. Fail-open: a missing/corrupt entry is
// silently a no-op rather than a thrown error, since this is called from the
// ledger-fold path (Task 6) where a crash must never break the fold.
function bumpRejection(projectPath, relPath) {
  const rec = readEntry(projectPath, relPath);
  if (!rec) return;
  rec.rejections = (rec.rejections || 0) + 1;
  rec.updatedAt = new Date().toISOString();
  try {
    atomicWriteJSON(entryPath(projectPath, relPath), rec);
    const idx = readIndex(projectPath);
    if (idx[relPath]) {
      idx[relPath].rejections = rec.rejections;
      idx[relPath].updatedAt = rec.updatedAt;
      atomicWriteJSON(indexPath(projectPath), idx);
    }
  } catch {
    // best-effort counter; never throw out of the fold
  }
}

// warm(projectPath, hotPaths, config) -> Promise<n>. hotPaths mirrors the
// ledger's hotPaths shape ([{ file, readers, reads }]); only `.file` is read
// here. Serial (one skeletonize() at a time) and bounded to
// MAX_WARM_PER_CALL paths, so a sync pass can never spend unbounded time
// warming an unbounded hot set. Returns the count of entries actually
// (re)written -- paths whose content hash is unchanged since the last warm
// are skipped and do not count.
async function warm(projectPath, hotPaths, config) {
  const list = Array.isArray(hotPaths) ? hotPaths.slice(0, MAX_WARM_PER_CALL) : [];
  const index = readIndex(projectPath);
  const compiled = digest.compileRedactions(config);
  let n = 0;

  for (const hp of list) {
    const relPath = hp && hp.file;
    if (!relPath) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(projectPath, relPath), 'utf8');
    } catch {
      continue; // file gone/unreadable -- nothing to warm, fail open
    }
    const contentHash = sha1(content);
    const existing = index[relPath];
    if (existing && existing.contentHash === contentHash) continue; // unchanged, skip

    let skeletonized;
    try {
      skeletonized = await skeletonize(path.join(projectPath, relPath), content);
    } catch {
      continue; // never let one bad file abort the whole warm pass
    }
    const skeletonText = digest.redactText(skeletonized.text, compiled);
    const priorRejections = readEntry(projectPath, relPath);

    put(projectPath, relPath, {
      contentHash,
      skeleton: skeletonText,
      skeletonTokens: estimateTokens(skeletonText),
      fileTokens: estimateTokens(content),
      engine: skeletonized.engine,
      rejections: priorRejections ? priorRejections.rejections : 0,
    });
    index[relPath] = { contentHash }; // keep the in-memory index cheaply current for this pass
    n++;
  }
  return n;
}

module.exports = { get, put, bumpRejection, warm, storeDir, entryPath, indexPath };
