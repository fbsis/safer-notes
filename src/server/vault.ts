import crypto from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  CRYPTO_VERSION,
  SCRYPT_PARAMS,
  decryptAttachmentData,
  decryptAttachmentMetadata,
  decryptNote,
  derivePasswordKey,
  encryptAttachment,
  encryptNote,
  hashToken,
  unwrapDataKey,
  wrapDataKey,
  type ScryptParameters
} from "./crypto";
import { openDatabase, transaction } from "./db";
import { HttpError } from "./errors";
import type {
  AttachmentMetadata,
  AttachmentRow,
  DecryptedAttachment,
  DecryptedNote,
  NotePayload,
  NoteRow,
  UserRole,
  UserRow
} from "./types";

const MAX_ATTACHMENTS_PER_NOTE_BYTES = 100 * 1024 * 1024;

interface InviteRow {
  id: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export class Vault {
  readonly database: DatabaseSync;
  private readonly statements: Record<string, StatementSync>;

  constructor(
    databasePath: string,
    private readonly kdfParameters: ScryptParameters = SCRYPT_PARAMS
  ) {
    this.database = openDatabase(databasePath);
    this.statements = {
      countUsers: this.database.prepare("SELECT COUNT(*) AS count FROM users"),
      findUser: this.database.prepare("SELECT * FROM users WHERE username = ?"),
      insertUser: this.database.prepare(`
        INSERT INTO users (
          id, username, role, kdf_salt, kdf_n, kdf_r, kdf_p,
          wrapped_dek, wrap_iv, wrap_tag, crypto_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updatePassword: this.database.prepare(`
        UPDATE users SET
          kdf_salt = ?, kdf_n = ?, kdf_r = ?, kdf_p = ?,
          wrapped_dek = ?, wrap_iv = ?, wrap_tag = ?, updated_at = ?
        WHERE id = ?
      `),
      listNotes: this.database.prepare(
        "SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC"
      ),
      findNote: this.database.prepare("SELECT * FROM notes WHERE id = ? AND user_id = ?"),
      insertNote: this.database.prepare(`
        INSERT INTO notes (
          id, user_id, parent_id, ciphertext, iv, auth_tag, crypto_version,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateNote: this.database.prepare(`
        UPDATE notes SET
          parent_id = ?, ciphertext = ?, iv = ?, auth_tag = ?, crypto_version = ?,
          revision = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND revision = ?
      `),
      deleteNote: this.database.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?"),
      insertAttachment: this.database.prepare(`
        INSERT INTO attachments (
          id, note_id, user_id,
          metadata_ciphertext, metadata_iv, metadata_auth_tag,
          data_ciphertext, data_iv, data_auth_tag,
          crypto_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      listAttachments: this.database.prepare(`
        SELECT * FROM attachments
        WHERE note_id = ? AND user_id = ? ORDER BY created_at
      `),
      findAttachment: this.database.prepare(
        "SELECT * FROM attachments WHERE id = ? AND user_id = ?"
      ),
      attachmentBytes: this.database.prepare(`
        SELECT COALESCE(SUM(length(data_ciphertext)), 0) AS bytes
        FROM attachments WHERE note_id = ? AND user_id = ?
      `),
      deleteAttachment: this.database.prepare(
        "DELETE FROM attachments WHERE id = ? AND user_id = ?"
      ),
      insertInvite: this.database.prepare(`
        INSERT INTO invites (
          id, token_hash, created_by, expires_at, consumed_at, consumed_by, created_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?)
      `),
      findInvite: this.database.prepare(`
        SELECT * FROM invites
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      `),
      consumeInvite: this.database.prepare(`
        UPDATE invites SET consumed_at = ?, consumed_by = ?
        WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
      `),
      listInvites: this.database.prepare(`
        SELECT id, expires_at, consumed_at, consumed_by, created_at
        FROM invites WHERE created_by = ? ORDER BY created_at DESC LIMIT 50
      `)
    };
  }

  userCount() {
    const row = this.statements.countUsers.get() as { count: number | bigint };
    return Number(row.count);
  }

  findUser(username: string) {
    return this.statements.findUser.get(username) as unknown as UserRow | undefined;
  }

  private async buildUser(username: string, password: string, role: UserRole) {
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(32);
    const passwordKey = await derivePasswordKey(password, salt, this.kdfParameters);
    const dataKey = crypto.randomBytes(32);
    const wrapped = wrapDataKey(id, dataKey, passwordKey);
    passwordKey.fill(0);
    const now = new Date().toISOString();
    const user: UserRow = {
      id,
      username,
      role,
      kdf_salt: salt,
      kdf_n: this.kdfParameters.N,
      kdf_r: this.kdfParameters.r,
      kdf_p: this.kdfParameters.p,
      wrapped_dek: wrapped.ciphertext,
      wrap_iv: wrapped.iv,
      wrap_tag: wrapped.tag,
      crypto_version: CRYPTO_VERSION,
      created_at: now,
      updated_at: now
    };
    return { user, dataKey };
  }

  private insertUser(user: UserRow) {
    this.statements.insertUser.run(
      user.id,
      user.username,
      user.role,
      user.kdf_salt,
      user.kdf_n,
      user.kdf_r,
      user.kdf_p,
      user.wrapped_dek,
      user.wrap_iv,
      user.wrap_tag,
      user.crypto_version,
      user.created_at,
      user.updated_at
    );
  }

  async bootstrap(username: string, password: string) {
    const created = await this.buildUser(username, password, "admin");
    try {
      transaction(this.database, () => {
        if (this.userCount() !== 0) throw new HttpError(409, "Sistema já configurado.");
        this.insertUser(created.user);
      });
      return created;
    } catch (error) {
      created.dataKey.fill(0);
      throw error;
    }
  }

  async register(inviteToken: string, username: string, password: string) {
    const now = new Date().toISOString();
    const invite = this.statements.findInvite.get(hashToken(inviteToken), now) as
      | { id: string }
      | undefined;
    if (!invite) throw new HttpError(403, "Convite inválido ou expirado.");
    const created = await this.buildUser(username, password, "user");
    try {
      transaction(this.database, () => {
        this.insertUser(created.user);
        const consumed = this.statements.consumeInvite.run(
          now,
          created.user.id,
          invite.id,
          now
        );
        if (Number(consumed.changes) !== 1) {
          throw new HttpError(409, "O convite já foi utilizado.");
        }
      });
      return created;
    } catch (error) {
      created.dataKey.fill(0);
      if (String((error as Error).message).includes("UNIQUE constraint failed: users.username")) {
        throw new HttpError(409, "Esse usuário já existe.");
      }
      throw error;
    }
  }

  async authenticate(username: string, password: string) {
    const user = this.findUser(username);
    let passwordKey: Buffer | undefined;
    try {
      const salt = user ? user.kdf_salt : crypto.randomBytes(32);
      const parameters = user
        ? { N: user.kdf_n, r: user.kdf_r, p: user.kdf_p }
        : SCRYPT_PARAMS;
      passwordKey = await derivePasswordKey(password, salt, parameters);
      if (!user) throw new Error("invalid credentials");
      return { user, dataKey: unwrapDataKey(user, passwordKey) };
    } finally {
      passwordKey?.fill(0);
    }
  }

  async changePassword(username: string, currentPassword: string, newPassword: string) {
    const user = this.findUser(username);
    if (!user) throw new HttpError(401, "Senha atual inválida.");
    let oldKey: Buffer | undefined;
    let dataKey: Buffer | undefined;
    try {
      oldKey = await derivePasswordKey(currentPassword, user.kdf_salt, {
        N: user.kdf_n,
        r: user.kdf_r,
        p: user.kdf_p
      });
      dataKey = unwrapDataKey(user, oldKey);
    } catch {
      throw new HttpError(401, "Senha atual inválida.");
    } finally {
      oldKey?.fill(0);
    }

    let newKey: Buffer | undefined;
    try {
      const newSalt = crypto.randomBytes(32);
      newKey = await derivePasswordKey(newPassword, newSalt, this.kdfParameters);
      const wrapped = wrapDataKey(user.id, dataKey, newKey);
      this.statements.updatePassword.run(
        newSalt,
        this.kdfParameters.N,
        this.kdfParameters.r,
        this.kdfParameters.p,
        wrapped.ciphertext,
        wrapped.iv,
        wrapped.tag,
        new Date().toISOString(),
        user.id
      );
    } finally {
      newKey?.fill(0);
      dataKey?.fill(0);
    }
  }

  listNotes(userId: string, dataKey: Uint8Array): DecryptedNote[] {
    const rows = this.statements.listNotes.all(userId) as unknown as NoteRow[];
    return rows.map((row) => {
      try {
        return {
          id: row.id,
          parentId: row.parent_id,
          ...decryptNote(dataKey, row),
          revision: row.revision,
          createdAt: row.created_at,
          updatedAt: row.updated_at
        };
      } catch {
        throw new HttpError(
          500,
          "Falha ao verificar a integridade dos dados criptografados.",
          "data_integrity_error"
        );
      }
    });
  }

  createNote(
    userId: string,
    dataKey: Uint8Array,
    parentId: string | null,
    payload: NotePayload
  ): DecryptedNote {
    const id = crypto.randomUUID();
    this.assertValidParent(userId, id, parentId);
    const revision = 1;
    const encrypted = encryptNote(dataKey, userId, id, revision, payload);
    const now = new Date().toISOString();
    this.statements.insertNote.run(
      id,
      userId,
      parentId,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      CRYPTO_VERSION,
      revision,
      now,
      now
    );
    return { id, parentId, ...payload, revision, createdAt: now, updatedAt: now };
  }

  updateNote(
    userId: string,
    dataKey: Uint8Array,
    id: string,
    expectedRevision: number,
    parentId: string | null,
    payload: NotePayload
  ): DecryptedNote {
    this.assertValidParent(userId, id, parentId);
    const revision = expectedRevision + 1;
    const encrypted = encryptNote(dataKey, userId, id, revision, payload);
    const now = new Date().toISOString();
    const result = this.statements.updateNote.run(
      parentId,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      CRYPTO_VERSION,
      revision,
      now,
      id,
      userId,
      expectedRevision
    );
    if (Number(result.changes) !== 1) {
      const exists = this.statements.findNote.get(id, userId);
      throw new HttpError(
        exists ? 409 : 404,
        exists ? "A nota foi modificada em outra sessão." : "Nota não encontrada.",
        exists ? "revision_conflict" : "not_found"
      );
    }
    return { id, parentId, ...payload, revision, updatedAt: now };
  }

  private assertValidParent(userId: string, noteId: string, parentId: string | null) {
    if (!parentId) return;
    const visited = new Set<string>();
    let currentId: string | null = parentId;
    while (currentId) {
      if (currentId === noteId) {
        throw new HttpError(
          400,
          "Uma página não pode ficar dentro dela mesma ou de uma descendente.",
          "invalid_parent"
        );
      }
      if (visited.has(currentId)) {
        throw new HttpError(500, "A árvore de páginas está inconsistente.");
      }
      visited.add(currentId);
      const parent = this.statements.findNote.get(
        currentId,
        userId
      ) as unknown as NoteRow | undefined;
      if (!parent) throw new HttpError(404, "Página pai não encontrada.");
      currentId = parent.parent_id;
    }
  }

  deleteNote(userId: string, id: string) {
    const result = this.statements.deleteNote.run(id, userId);
    if (Number(result.changes) !== 1) throw new HttpError(404, "Nota não encontrada.");
  }

  createAttachment(
    userId: string,
    dataKey: Uint8Array,
    noteId: string,
    metadata: AttachmentMetadata,
    data: Uint8Array
  ) {
    if (!this.statements.findNote.get(noteId, userId)) {
      throw new HttpError(404, "Nota não encontrada.");
    }
    const current = this.statements.attachmentBytes.get(noteId, userId) as {
      bytes: number | bigint;
    };
    if (Number(current.bytes) + data.byteLength > MAX_ATTACHMENTS_PER_NOTE_BYTES) {
      throw new HttpError(413, "Os anexos desta nota excedem o limite de 100 MiB.");
    }

    const id = crypto.randomUUID();
    const encrypted = encryptAttachment(dataKey, userId, noteId, id, metadata, data);
    const createdAt = new Date().toISOString();
    this.statements.insertAttachment.run(
      id,
      noteId,
      userId,
      encrypted.metadata.ciphertext,
      encrypted.metadata.iv,
      encrypted.metadata.tag,
      encrypted.data.ciphertext,
      encrypted.data.iv,
      encrypted.data.tag,
      CRYPTO_VERSION,
      createdAt
    );
    return { id, noteId, ...metadata, createdAt };
  }

  listAttachments(userId: string, dataKey: Uint8Array, noteId: string) {
    if (!this.statements.findNote.get(noteId, userId)) {
      throw new HttpError(404, "Nota não encontrada.");
    }
    const rows = this.statements.listAttachments.all(
      noteId,
      userId
    ) as unknown as AttachmentRow[];
    return rows.map((row) => {
      try {
        return {
          id: row.id,
          noteId: row.note_id,
          ...decryptAttachmentMetadata(dataKey, row),
          createdAt: row.created_at
        };
      } catch {
        throw new HttpError(
          500,
          "Falha ao verificar a integridade de um anexo.",
          "data_integrity_error"
        );
      }
    });
  }

  getAttachment(
    userId: string,
    dataKey: Uint8Array,
    id: string
  ): DecryptedAttachment {
    const row = this.statements.findAttachment.get(
      id,
      userId
    ) as unknown as AttachmentRow | undefined;
    if (!row) throw new HttpError(404, "Anexo não encontrado.");
    try {
      return {
        id: row.id,
        noteId: row.note_id,
        ...decryptAttachmentMetadata(dataKey, row),
        data: decryptAttachmentData(dataKey, row),
        createdAt: row.created_at
      };
    } catch {
      throw new HttpError(
        500,
        "Falha ao verificar a integridade do anexo.",
        "data_integrity_error"
      );
    }
  }

  deleteAttachment(userId: string, id: string) {
    const result = this.statements.deleteAttachment.run(id, userId);
    if (Number(result.changes) !== 1) throw new HttpError(404, "Anexo não encontrado.");
  }

  createInvite(userId: string) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    this.statements.insertInvite.run(
      crypto.randomUUID(),
      hashToken(token),
      userId,
      expires.toISOString(),
      now.toISOString()
    );
    return { token, expiresAt: expires.toISOString() };
  }

  listInvites(userId: string) {
    const rows = this.statements.listInvites.all(userId) as unknown as InviteRow[];
    return rows.map((invite) => ({
      id: invite.id,
      expiresAt: invite.expires_at,
      consumedAt: invite.consumed_at,
      createdAt: invite.created_at
    }));
  }
}
