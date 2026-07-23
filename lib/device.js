'use strict';
// Stable per-device identity (multi-device E2E, section 1).
//
// Why a device id at all: the crypto model seals the team key once per DEVICE,
// not once per user, so two machines under one account each get their own
// sealed copy instead of overwriting a single per-user slot (the bug this
// fixes). Every device therefore needs a stable id that outlives process
// restarts but is unique per machine.
//
// The id lives in device.json in the MemBridge home (MEMBRIDGE_HOME-aware via
// util.homeDir()), one file per OS user. It is created lazily on first read and
// never rotated: a changed id would look like a brand-new device and re-seal
// needlessly. MEMBRIDGE_DEVICE_ID overrides it for tests (mirrors the
// MEMBRIDGE_HOME test-isolation pattern), so suites can simulate N devices
// without N machines.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('./util');

const devicePath = () => path.join(util.homeDir(), 'device.json');

// Read the persisted record, or null on any missing/corrupt/parse failure —
// never throws, so a bad file just triggers a fresh mint (same self-healing
// stance as teampins.load).
function read() {
  try {
    const rec = JSON.parse(fs.readFileSync(devicePath(), 'utf8'));
    return rec && typeof rec === 'object' && typeof rec.deviceId === 'string' && rec.deviceId
      ? rec
      : null;
  } catch (e) {
    return null;
  }
}

let tmpSeq = 0;

// Create-and-persist a fresh record on first boot. Both deviceId() and
// deviceLabel() converge here on one lazily-created device.json.
//
// Concurrency + crash safety: on a fresh machine the daemon and a parallel CLI
// session can reach here at the same instant. We write the minted record to a
// per-process-unique tmp, then linkSync it into place — an atomic exclusive
// create that throws EEXIST if another process already made the file. The loser
// adopts the winner's persisted id instead of keeping its own, so both devices
// seal under ONE identity rather than triggering the re-seal churn this feature
// exists to prevent. The tmp is fully written before the link, so a crash can't
// leave a half-written device.json that would read as a brand-new device next
// boot. A pre-existing corrupt file (read() still null) is self-healed by
// replacing it, and any disk error falls back to the in-memory id, so ensure()
// never throws.
function ensure() {
  const existing = read();
  if (existing) return existing;
  const rec = { deviceId: crypto.randomUUID(), label: os.hostname() || 'device' };
  const file = devicePath();
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    try {
      fs.linkSync(tmp, file);
      return rec;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const raced = read();
      if (raced) return raced;       // adopt a concurrent winner
      fs.renameSync(tmp, file);      // existing file was corrupt: self-heal
      return rec;
    }
  } catch (e) {
    return read() || rec;
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
}

// The stable id for this device. Env override wins (test isolation) and is NOT
// persisted — it is authoritative for the life of the process only.
function deviceId() {
  if (process.env.MEMBRIDGE_DEVICE_ID) return process.env.MEMBRIDGE_DEVICE_ID;
  return ensure().deviceId;
}

// Human label for CLI surfaces (fingerprint/status). Falls back to the hostname
// on a record that predates the label field.
function deviceLabel() {
  const rec = ensure();
  return rec.label || os.hostname() || 'device';
}

module.exports = { deviceId, deviceLabel, devicePath };
