"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scryptAsync = promisify(crypto.scrypt);

const CRYPTO_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SCRYPT_PARAMS = Object.freeze({
  N: 131072,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024
});

async function derivePasswordKey(password, salt, params = SCRYPT_PARAMS) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    throw new Error("A senha precisa ter entre 12 e 1024 caracteres.");
  }

  return scryptAsync(password.normalize("NFKC"), salt, KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem || SCRYPT_PARAMS.maxmem
  });
}

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES
  });
  cipher.setAAD(Buffer.from(aad, "utf8"));

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final()
  ]);

  return {
    ciphertext,
    iv,
    tag: cipher.getAuthTag()
  };
}

function decrypt(key, ciphertext, iv, tag, aad) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES
  });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
}

function wrapDataKey(userId, dataKey, passwordKey) {
  return encrypt(passwordKey, dataKey, `notes:user-dek:v${CRYPTO_VERSION}:${userId}`);
}

function unwrapDataKey(user, passwordKey) {
  return decrypt(
    passwordKey,
    Buffer.from(user.wrapped_dek),
    Buffer.from(user.wrap_iv),
    Buffer.from(user.wrap_tag),
    `notes:user-dek:v${user.crypto_version}:${user.id}`
  );
}

function encryptNote(dataKey, userId, noteId, revision, payload) {
  return encrypt(
    dataKey,
    Buffer.from(JSON.stringify(payload), "utf8"),
    `notes:note:v${CRYPTO_VERSION}:${userId}:${noteId}:${revision}`
  );
}

function decryptNote(dataKey, row) {
  const plaintext = decrypt(
    dataKey,
    Buffer.from(row.ciphertext),
    Buffer.from(row.iv),
    Buffer.from(row.auth_tag),
    `notes:note:v${row.crypto_version}:${row.user_id}:${row.id}:${row.revision}`
  );
  return JSON.parse(plaintext.toString("utf8"));
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest();
}

module.exports = {
  CRYPTO_VERSION,
  SCRYPT_PARAMS,
  decryptNote,
  derivePasswordKey,
  encryptNote,
  hashToken,
  unwrapDataKey,
  wrapDataKey
};
