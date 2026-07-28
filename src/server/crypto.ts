import crypto from "node:crypto";
import type { StoredAttachmentData } from "./attachment-storage";
import type {
  AttachmentMetadata,
  AttachmentRow,
  NotePayload,
  NoteRow,
  StoredNotePayload,
  UserRow
} from "./types";

export const CRYPTO_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface ScryptParameters {
  N: number;
  r: number;
  p: number;
  maxmem?: number;
}

export const SCRYPT_PARAMS: Readonly<ScryptParameters> = Object.freeze({
  N: 131072,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024
});

export async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  parameters: ScryptParameters = SCRYPT_PARAMS
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize("NFKC"), salt, KEY_BYTES, {
      N: parameters.N,
      r: parameters.r,
      p: parameters.p,
      maxmem: parameters.maxmem ?? SCRYPT_PARAMS.maxmem
    }, (error, key) => {
      if (error) reject(error);
      else resolve(Buffer.from(key));
    });
  });
}

function encrypt(key: Uint8Array, plaintext: Uint8Array, aad: string) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES
  });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decrypt(
  key: Uint8Array,
  ciphertext: Uint8Array,
  iv: Uint8Array,
  tag: Uint8Array,
  aad: string
) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: TAG_BYTES
  });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function wrapDataKey(userId: string, dataKey: Uint8Array, passwordKey: Uint8Array) {
  return encrypt(
    passwordKey,
    dataKey,
    `notes:user-dek:v${CRYPTO_VERSION}:${userId}`
  );
}

export function unwrapDataKey(user: UserRow, passwordKey: Uint8Array) {
  return decrypt(
    passwordKey,
    user.wrapped_dek,
    user.wrap_iv,
    user.wrap_tag,
    `notes:user-dek:v${user.crypto_version}:${user.id}`
  );
}

export function encryptNote(
  dataKey: Uint8Array,
  userId: string,
  noteId: string,
  revision: number,
  payload: NotePayload & { parentId?: string | null }
) {
  return encrypt(
    dataKey,
    Buffer.from(JSON.stringify(payload), "utf8"),
    `notes:note:v${CRYPTO_VERSION}:${userId}:${noteId}:${revision}`
  );
}

export function decryptNote(dataKey: Uint8Array, row: NoteRow): StoredNotePayload {
  const plaintext = decrypt(
    dataKey,
    row.ciphertext,
    row.iv,
    row.auth_tag,
    `notes:note:v${row.crypto_version}:${row.user_id}:${row.id}:${row.revision}`
  );
  return JSON.parse(plaintext.toString("utf8")) as StoredNotePayload;
}

export function encryptAttachment(
  dataKey: Uint8Array,
  userId: string,
  noteId: string,
  attachmentId: string,
  metadata: AttachmentMetadata,
  data: Uint8Array
) {
  const prefix = `notes:attachment:v${CRYPTO_VERSION}:${userId}:${noteId}:${attachmentId}`;
  return {
    metadata: encrypt(
      dataKey,
      Buffer.from(JSON.stringify(metadata), "utf8"),
      `${prefix}:metadata`
    ),
    data: encrypt(dataKey, data, `${prefix}:data`)
  };
}

export function decryptAttachmentMetadata(
  dataKey: Uint8Array,
  row: AttachmentRow
): AttachmentMetadata {
  const plaintext = decrypt(
    dataKey,
    row.metadata_ciphertext,
    row.metadata_iv,
    row.metadata_auth_tag,
    `notes:attachment:v${row.crypto_version}:${row.user_id}:${row.note_id}:${row.id}:metadata`
  );
  return JSON.parse(plaintext.toString("utf8")) as AttachmentMetadata;
}

export function decryptAttachmentData(
  dataKey: Uint8Array,
  row: AttachmentRow,
  encrypted: StoredAttachmentData
) {
  return decrypt(
    dataKey,
    encrypted.ciphertext,
    encrypted.iv,
    encrypted.tag,
    `notes:attachment:v${row.crypto_version}:${row.user_id}:${row.note_id}:${row.id}:data`
  );
}

export function hashToken(token: string) {
  return crypto.createHash("sha256").update(token, "utf8").digest();
}

export function safeEqualText(actual: unknown, expected: string) {
  const left = crypto
    .createHash("sha256")
    .update(typeof actual === "string" ? actual : "", "utf8")
    .digest();
  const right = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}
