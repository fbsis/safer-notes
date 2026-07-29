import crypto from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { AttachmentStorage } from "./attachment-storage";
import {
  CRYPTO_VERSION,
  SCRYPT_PARAMS,
  decryptAttachmentData,
  decryptAttachmentMetadata,
  decryptNote,
  derivePasswordKey,
  encryptAttachment,
  encryptNote,
  unwrapDataKey,
  wrapDataKey,
  type ScryptParameters
} from "./crypto";
import { openDatabase } from "./db";
import { HttpError } from "./errors";
import type {
  AttachmentMetadata,
  AttachmentRow,
  DecryptedAttachment,
  DecryptedNote,
  NotePayload,
  NoteRow,
  UserRow
} from "./types";

const MAX_ATTACHMENTS_PER_NOTE_BYTES = 500 * 1024 * 1024;

export class Vault {
  readonly database: DatabaseSync;
  private readonly statements: Record<string, StatementSync>;
  private readonly attachmentStorage: AttachmentStorage;
  private readonly passwordCacheSecret = crypto.randomBytes(32);
  private readonly passwordUserCache = new Map<string, string | null>();
  private passwordScanQueue: Promise<void> = Promise.resolve();

  constructor(
    databasePath: string,
    attachmentsPath: string,
    private readonly kdfParameters: ScryptParameters = SCRYPT_PARAMS
  ) {
    this.attachmentStorage = new AttachmentStorage(attachmentsPath);
    this.database = openDatabase(databasePath, this.attachmentStorage);
    this.statements = {
      findUserById: this.database.prepare("SELECT * FROM users WHERE id = ?"),
      findUserByUsername: this.database.prepare("SELECT * FROM users WHERE username = ?"),
      listUsers: this.database.prepare("SELECT * FROM users ORDER BY created_at, id"),
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
          crypto_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      listAttachments: this.database.prepare(`
        SELECT * FROM attachments
        WHERE note_id = ? AND user_id = ? ORDER BY created_at
      `),
      findAttachment: this.database.prepare(
        "SELECT * FROM attachments WHERE id = ? AND user_id = ?"
      ),
      attachmentIds: this.database.prepare(`
        SELECT id
        FROM attachments WHERE note_id = ? AND user_id = ?
      `),
      subtreeAttachmentIds: this.database.prepare(`
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM notes WHERE id = ? AND user_id = ?
          UNION ALL
          SELECT notes.id
          FROM notes JOIN subtree ON notes.parent_id = subtree.id
          WHERE notes.user_id = ?
        )
        SELECT attachments.id
        FROM attachments JOIN subtree ON attachments.note_id = subtree.id
        WHERE attachments.user_id = ?
      `),
      deleteAttachment: this.database.prepare(
        "DELETE FROM attachments WHERE id = ? AND user_id = ?"
      )
    };
  }

  private findUserById(id: string) {
    return this.statements.findUserById.get(id) as unknown as UserRow | undefined;
  }

  private findUserByUsername(username: string) {
    return this.statements.findUserByUsername.get(username) as unknown as UserRow | undefined;
  }

  private listUsers() {
    return this.statements.listUsers.all() as unknown as UserRow[];
  }

  private async buildUser(password: string) {
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(32);
    const passwordKey = await derivePasswordKey(password, salt, this.kdfParameters);
    const dataKey = crypto.randomBytes(32);
    const wrapped = wrapDataKey(id, dataKey, passwordKey);
    passwordKey.fill(0);
    const now = new Date().toISOString();
    const user: UserRow = {
      id,
      username: id,
      role: "user",
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

  async register(password: string) {
    return this.withPasswordScan(async () => {
      const existing = await this.findPasswordMatches(password, undefined, 1);
      if (existing.length > 0) {
        existing[0].dataKey.fill(0);
        throw new HttpError(
          409,
          "Essa senha já abre um cofre. Use outra senha ou desbloqueie o cofre existente.",
          "password_in_use"
        );
      }

      const created = await this.buildUser(password);
      try {
        this.insertUser(created.user);
        this.passwordUserCache.set(
          this.passwordFingerprint(password),
          created.user.id
        );
        return created;
      } catch (error) {
        created.dataKey.fill(0);
        throw error;
      }
    });
  }

  async authenticate(password: string, legacyUsername?: string) {
    if (legacyUsername) {
      const user = this.findUserByUsername(legacyUsername);
      const unlocked = user
        ? await this.tryUnlockUser(user, password)
        : undefined;
      if (!unlocked) throw new Error("invalid credentials");
      return unlocked;
    }

    const fingerprint = this.passwordFingerprint(password);
    const cachedUserId = this.passwordUserCache.get(fingerprint);
    if (cachedUserId === null) throw this.ambiguousPasswordError();
    if (cachedUserId) {
      const cachedUser = this.findUserById(cachedUserId);
      const unlocked = cachedUser
        ? await this.tryUnlockUser(cachedUser, password)
        : undefined;
      if (unlocked) return unlocked;
      this.passwordUserCache.delete(fingerprint);
    }

    return this.withPasswordScan(async () => {
      const refreshedUserId = this.passwordUserCache.get(fingerprint);
      if (refreshedUserId === null) throw this.ambiguousPasswordError();
      if (refreshedUserId) {
        const refreshedUser = this.findUserById(refreshedUserId);
        const unlocked = refreshedUser
          ? await this.tryUnlockUser(refreshedUser, password)
          : undefined;
        if (unlocked) return unlocked;
        this.passwordUserCache.delete(fingerprint);
      }

      const matches = await this.findPasswordMatches(password, undefined, 2);
      if (matches.length === 0) throw new Error("invalid credentials");
      if (matches.length > 1) {
        for (const match of matches) match.dataKey.fill(0);
        this.passwordUserCache.set(fingerprint, null);
        throw this.ambiguousPasswordError();
      }

      this.passwordUserCache.set(fingerprint, matches[0].user.id);
      return matches[0];
    });
  }

  private async tryUnlockUser(user: UserRow, password: string) {
    let passwordKey: Buffer | undefined;
    try {
      passwordKey = await derivePasswordKey(password, user.kdf_salt, {
        N: user.kdf_n,
        r: user.kdf_r,
        p: user.kdf_p
      });
      return { user, dataKey: unwrapDataKey(user, passwordKey) };
    } catch {
      return undefined;
    } finally {
      passwordKey?.fill(0);
    }
  }

  private async findPasswordMatches(
    password: string,
    excludedUserId?: string,
    limit = Number.POSITIVE_INFINITY
  ) {
    const matches: Array<{ user: UserRow; dataKey: Buffer }> = [];
    for (const user of this.listUsers()) {
      if (user.id === excludedUserId) continue;
      const unlocked = await this.tryUnlockUser(user, password);
      if (!unlocked) continue;
      matches.push(unlocked);
      if (matches.length >= limit) break;
    }
    return matches;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    return this.withPasswordScan(async () => {
      const user = this.findUserById(userId);
      const unlocked = user
        ? await this.tryUnlockUser(user, currentPassword)
        : undefined;
      if (!unlocked) throw new HttpError(401, "Senha atual inválida.");

      let newKey: Buffer | undefined;
      try {
        const existing = await this.findPasswordMatches(newPassword, userId, 1);
        if (existing.length > 0) {
          existing[0].dataKey.fill(0);
          throw new HttpError(
            409,
            "Essa nova senha já abre outro cofre. Escolha uma senha diferente.",
            "password_in_use"
          );
        }

        const newSalt = crypto.randomBytes(32);
        newKey = await derivePasswordKey(newPassword, newSalt, this.kdfParameters);
        const wrapped = wrapDataKey(unlocked.user.id, unlocked.dataKey, newKey);
        this.statements.updatePassword.run(
          newSalt,
          this.kdfParameters.N,
          this.kdfParameters.r,
          this.kdfParameters.p,
          wrapped.ciphertext,
          wrapped.iv,
          wrapped.tag,
          new Date().toISOString(),
          unlocked.user.id
        );
        this.passwordUserCache.delete(this.passwordFingerprint(currentPassword));
        this.passwordUserCache.set(
          this.passwordFingerprint(newPassword),
          unlocked.user.id
        );
      } finally {
        newKey?.fill(0);
        unlocked.dataKey.fill(0);
      }
    });
  }

  private passwordFingerprint(password: string) {
    return crypto
      .createHmac("sha256", this.passwordCacheSecret)
      .update(password.normalize("NFKC"), "utf8")
      .digest("base64url");
  }

  private ambiguousPasswordError() {
    return new HttpError(
      409,
      "Mais de um cofre antigo usa essa senha. Informe a identificação antiga para escolher um deles e depois altere sua senha.",
      "ambiguous_password"
    );
  }

  private async withPasswordScan<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.passwordScanQueue;
    let release!: () => void;
    this.passwordScanQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  listNotes(userId: string, dataKey: Uint8Array): DecryptedNote[] {
    const rows = this.statements.listNotes.all(userId) as unknown as NoteRow[];
    return rows.map((row) => {
      try {
        const payload = decryptNote(dataKey, row);
        if ((payload.parentId ?? null) !== row.parent_id) {
          throw new Error("note hierarchy integrity mismatch");
        }
        return {
          id: row.id,
          parentId: row.parent_id,
          ...payload,
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
    const encrypted = encryptNote(dataKey, userId, id, revision, {
      ...payload,
      parentId
    });
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
    const encrypted = encryptNote(dataKey, userId, id, revision, {
      ...payload,
      parentId
    });
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
    const attachmentIds = this.statements.subtreeAttachmentIds.all(
      id,
      userId,
      userId,
      userId
    ) as Array<{ id: string }>;
    const result = this.statements.deleteNote.run(id, userId);
    if (Number(result.changes) !== 1) throw new HttpError(404, "Nota não encontrada.");
    for (const attachment of attachmentIds) {
      this.removeAttachmentFile(attachment.id);
    }
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
    const currentIds = this.statements.attachmentIds.all(
      noteId,
      userId
    ) as Array<{ id: string }>;
    const currentBytes = currentIds.reduce(
      (total, attachment) => total + this.attachmentStorage.contentBytes(attachment.id),
      0
    );
    if (currentBytes + data.byteLength > MAX_ATTACHMENTS_PER_NOTE_BYTES) {
      throw new HttpError(413, "Os anexos desta nota excedem o limite de 500 MiB.");
    }

    const id = crypto.randomUUID();
    const encrypted = encryptAttachment(dataKey, userId, noteId, id, metadata, data);
    const createdAt = new Date().toISOString();
    this.attachmentStorage.write(id, encrypted.data);
    try {
      this.statements.insertAttachment.run(
        id,
        noteId,
        userId,
        encrypted.metadata.ciphertext,
        encrypted.metadata.iv,
        encrypted.metadata.tag,
        CRYPTO_VERSION,
        createdAt
      );
    } catch (error) {
      this.attachmentStorage.remove(id);
      throw error;
    }
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
        data: decryptAttachmentData(dataKey, row, this.attachmentStorage.read(row.id)),
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
    this.removeAttachmentFile(id);
  }

  private removeAttachmentFile(id: string) {
    try {
      this.attachmentStorage.remove(id);
    } catch (error) {
      console.error(
        `Falha ao remover o arquivo criptografado do anexo ${id}:`,
        error
      );
    }
  }
}
