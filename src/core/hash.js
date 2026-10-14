'use strict';

// Non-cryptographic local digests for cache keys. Two independent 32-bit lanes
// keep collisions negligible for the few hundred keys this module stores.

function fmix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function lane(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return fmix32(h ^ str.length);
}

function hex8(n) {
  return ('0000000' + (n >>> 0).toString(16)).slice(-8);
}

function digest(value) {
  const str = String(value);
  return hex8(lane(str, 0x811c9dc5)) + hex8(lane(str, 0x9e3779b9));
}

function randomId(length, rng) {
  const random = rng || Math.random;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  return out;
}

module.exports = { digest, randomId };
