export type UserRole = "admin" | "user";

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
  ciphertext: Uint8Array;
  iv: Uint8Array;
  auth_tag: Uint8Array;
  crypto_version: number;
  revision: number;
  created_at: string;
  updated_at: string;
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
  delta: DeltaDocument;
}

export interface DecryptedNote extends NotePayload {
  id: string;
  revision: number;
  createdAt?: string;
  updatedAt: string;
}
