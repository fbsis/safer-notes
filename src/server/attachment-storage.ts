import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAGIC = Buffer.from("SNATT001", "ascii");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StoredAttachmentData {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

export class AttachmentStorage {
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }

  write(id: string, encrypted: StoredAttachmentData) {
    const filename = this.filename(id);
    const expected = serialize(encrypted);
    if (fs.existsSync(filename)) {
      const current = fs.readFileSync(filename);
      if (!current.equals(expected)) {
        throw new Error(`attachment storage collision for ${id}`);
      }
      fs.chmodSync(filename, 0o600);
      return;
    }

    const temporary = path.join(
      this.directory,
      `.${id}.${crypto.randomBytes(8).toString("hex")}.tmp`
    );
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, expected);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, filename);
      fs.chmodSync(filename, 0o600);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }

  read(id: string): StoredAttachmentData {
    const envelope = fs.readFileSync(this.filename(id));
    if (envelope.length < HEADER_BYTES || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("invalid encrypted attachment envelope");
    }
    return {
      iv: envelope.subarray(MAGIC.length, MAGIC.length + IV_BYTES),
      tag: envelope.subarray(MAGIC.length + IV_BYTES, HEADER_BYTES),
      ciphertext: envelope.subarray(HEADER_BYTES)
    };
  }

  contentBytes(id: string) {
    const bytes = fs.statSync(this.filename(id)).size - HEADER_BYTES;
    if (bytes < 0) throw new Error("invalid encrypted attachment size");
    return bytes;
  }

  remove(id: string) {
    try {
      fs.unlinkSync(this.filename(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  pathFor(id: string) {
    return this.filename(id);
  }

  private filename(id: string) {
    if (!ID_PATTERN.test(id)) throw new Error("invalid attachment storage id");
    return path.join(this.directory, `${id}.bin`);
  }
}

function serialize(encrypted: StoredAttachmentData) {
  if (encrypted.iv.byteLength !== IV_BYTES || encrypted.tag.byteLength !== TAG_BYTES) {
    throw new Error("invalid encrypted attachment parameters");
  }
  return Buffer.concat([
    MAGIC,
    Buffer.from(encrypted.iv),
    Buffer.from(encrypted.tag),
    Buffer.from(encrypted.ciphertext)
  ]);
}
