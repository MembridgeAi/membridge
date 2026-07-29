'use strict';
// TOFU pin store for teammate box pubkeys (E2E completion, key authenticity).
//
// The threat this closes: pubkeys are fetched from the server, and a
// malicious or compromised backend could substitute its own key and silently
// man-in-the-middle the sealed team key. So the first key ever seen for a
// member is pinned locally (trust-on-first-use), and any later fetch that
// disagrees with the pin is an ALERT: that member is excluded from sealing
// until the human re-pins via `membridge team trust` after comparing
// fingerprints out-of-band.
//
// check() is pure — new objects out, inputs never mutated — so callers and
// tests reason about it without fs. load/save persist to pins.json in the
// MemBridge home (MEMBRIDGE_HOME-aware via util.homeDir()), one file per OS
// user, atomically written. A corrupt file loads as {} on purpose: worst
// case everything re-pins TOFU, which is exactly first-run behavior.
const fs = require('fs');
const path = require('path');
const util = require('./util');

const pinsPath = () => path.join(util.homeDir(), 'pins.json');

// The pin map: { [user_id]: { publicKey, name, firstSeen } }. {} on any
// read/parse failure — never throws, never returns a non-object.
function load() {
  try {
    const pins = JSON.parse(fs.readFileSync(pinsPath(), 'utf8'));
    return pins && typeof pins === 'object' && !Array.isArray(pins) ? pins : {};
  } catch (e) {
    return {};
  }
}

// Atomic write (tmp + rename) so a crash mid-save can't half-corrupt the one
// file standing between the user and a key-substitution attack.
function save(pins) {
  const file = pinsPath();
  util.ensureHomeDir();
  // 0600: this is the trust store a key-substitution attack has to beat, so it
  // must not be readable — let alone writable — by other users on the machine.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(pins, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {} // repair a pre-existing 0644 pins.json
}

// Evaluate fetched member pubkeys against the pins.
//   fetched: [{ user_id, public_key, display_name? }] (server rows)
// Returns { pins, allowed, alerts }:
//   pins    — new map with first-sight keys pinned (existing pins NEVER
//             silently replaced; `membridge team trust` is the only re-pin)
//   allowed — fetched rows safe to seal to (pin matched or newly pinned)
//   alerts  — [{ user_id, name, pinned, fetched }] for mismatches; these
//             members are excluded from allowed.
function check(pins, fetched, nowIso) {
  const next = { ...pins };
  const allowed = [];
  const alerts = [];
  for (const m of fetched || []) {
    if (!m || !m.user_id || !m.public_key) continue;
    const pin = next[m.user_id];
    if (!pin) {
      next[m.user_id] = { publicKey: m.public_key, name: m.display_name || '', firstSeen: nowIso };
      allowed.push(m);
    } else if (pin.publicKey === m.public_key) {
      // Names are display metadata, not identity — keep them fresh.
      if (m.display_name && m.display_name !== pin.name) {
        next[m.user_id] = { ...pin, name: m.display_name };
      }
      allowed.push(m);
    } else {
      alerts.push({
        user_id: m.user_id,
        name: m.display_name || pin.name || '',
        pinned: pin.publicKey,
        fetched: m.public_key,
      });
    }
  }
  return { pins: next, allowed, alerts };
}

module.exports = { load, save, check, pinsPath };
