export type UserRole = "user";

export interface UserRow {
  id: string;
  username: string;
  role: UserRole;
  kdf_salt: Uint8Array;
  kdf_n: number;
  kdf_r: number;
  kdf_p: number;
  wrapped_dek: Uint8Array;
  wrap_iv: Uint8Array;
  wrap_tag: Uint8Array;
  crypto_version: number;
  created_at: string;
  updated_at: string;
}

export interface NoteRow {
  id: string;
  user_id: string;
  parent_id: string | null;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  auth_tag: Uint8Array;
  crypto_version: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface AttachmentRow {
  id: string;
  note_id: string;
  user_id: string;
  metadata_ciphertext: Uint8Array;
  metadata_iv: Uint8Array;
  metadata_auth_tag: Uint8Array;
  data_ciphertext: Uint8Array;
  data_iv: Uint8Array;
  data_auth_tag: Uint8Array;
  crypto_version: number;
  created_at: string;
}

export interface AttachmentMetadata {
  name: string;
  mimeType: string;
  size: number;
}

export interface DecryptedAttachment extends AttachmentMetadata {
  id: string;
  noteId: string;
  data: Buffer;
  createdAt: string;
}

export interface DeltaOperation {
  insert?: unknown;
  retain?: number;
  delete?: number;
  attributes?: Record<string, unknown>;
}

export interface DeltaDocument {
  ops: DeltaOperation[];
}

export interface NotePayload {
  title: string;
  markdown: string;
}

export interface StoredNotePayload {
  title: string;
  markdown?: string;
  delta?: DeltaDocument;
  parentId?: string | null;
}

export interface DecryptedNote extends StoredNotePayload {
  id: string;
  parentId: string | null;
  revision: number;
  createdAt?: string;
  updatedAt: string;
}
