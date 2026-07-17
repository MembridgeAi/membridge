'use strict';
// End-to-end crypto primitives for team sync (E2E spec build-sequence step 1).
//
// Model: content is secretbox-encrypted ONCE with a random symmetric "team key";
// the team key is crypto_box_seal-ed to each member's public key, so a member
// unseals it with their private key and then decrypts the content. Private keys
// live in the OS keychain (lib/keychain.js), never here beyond the call that
// uses them. Everything crosses this module's boundary as base64 strings.
//
// Guarded on purpose: if libsodium-wrappers isn't installed, available() is
// false and every primitive throws a clear error — callers catch it and fall
// back to plaintext sync rather than crashing. Crypto is core, but a missing
// dep must degrade, not brick the daemon.
let sodium = null;
let loadErr = null;
try {
  sodium = require('libsodium-wrappers');
} catch (e) {
  loadErr = e;
}

// Resolve once libsodium's wasm is initialized. Callers await this before use.
async function ready() {
  if (!sodium) throw new Error('encryption unavailable: ' + (loadErr && loadErr.message));
  await sodium.ready;
}
function available() { return !!sodium; }

function need() {
  if (!sodium || !sodium.crypto_box_keypair) {
    throw new Error('encryption unavailable (libsodium not loaded/ready)');
  }
}
const b64 = u8 => sodium.to_base64(u8, sodium.base64_variants.ORIGINAL);
const un64 = s => sodium.from_base64(s, sodium.base64_variants.ORIGINAL);

// A member's crypto_box keypair. Private key goes to the keychain; public key is
// uploaded to member_pubkeys.
function genKeypair() {
  need();
  const kp = sodium.crypto_box_keypair();
  return { publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) };
}

// A fresh random symmetric team key (secretbox key).
function genTeamKey() {
  need();
  return b64(sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES));
}

// Seal the team key to a recipient's public key (anonymous sealed box). Only the
// holder of the matching private key can open it.
function sealTeamKey(teamKey, recipientPublicKey) {
  need();
  return b64(sodium.crypto_box_seal(un64(teamKey), un64(recipientPublicKey)));
}

// Open a sealed team key with my keypair. Returns null on any failure (wrong
// keypair, corrupt blob) rather than throwing — the caller treats null as
// "can't decrypt, fall back to plaintext".
function unsealTeamKey(sealed, myPublicKey, myPrivateKey) {
  need();
  try {
    const opened = sodium.crypto_box_seal_open(un64(sealed), un64(myPublicKey), un64(myPrivateKey));
    return opened ? b64(opened) : null;
  } catch (e) {
    return null;
  }
}

// Encrypt a content payload object with the team key. Fresh random nonce every
// call, so two encryptions of the same payload differ.
function encrypt(payloadObj, teamKey) {
  need();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const msg = sodium.from_string(JSON.stringify(payloadObj));
  const ct = sodium.crypto_secretbox_easy(msg, nonce, un64(teamKey));
  return { ciphertext: b64(ct), nonce: b64(nonce) };
}

// Decrypt back to the payload object. Returns null on any failure (wrong key,
// tampered ciphertext) — never throws to the caller, never returns garbage.
function decrypt(ciphertext, nonce, teamKey) {
  need();
  try {
    const pt = sodium.crypto_secretbox_open_easy(un64(ciphertext), un64(nonce), un64(teamKey));
    return pt ? JSON.parse(sodium.to_string(pt)) : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  ready, available, genKeypair, genTeamKey,
  sealTeamKey, unsealTeamKey, encrypt, decrypt,
};
