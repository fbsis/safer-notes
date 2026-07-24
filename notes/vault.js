"use strict";

const crypto = require("node:crypto");
const { openDatabase, transaction } = require("./db");
const {
  CRYPTO_VERSION,
  SCRYPT_PARAMS,
  decryptNote,
  derivePasswordKey,
  encryptNote,
  hashToken,
  unwrapDataKey,
  wrapDataKey
} = require("./crypto");
const { HttpError } = require("./http");

class Vault {
  constructor(dbPath, kdfParams = SCRYPT_PARAMS) {
    this.db = openDatabase(dbPath);
    this.kdfParams = kdfParams;
    this.statements = {
      countUsers: this.db.prepare("SELECT COUNT(*) AS count FROM users"),
      findUser: this.db.prepare("SELECT * FROM users WHERE username = ?"),
      insertUser: this.db.prepare(`
        INSERT INTO users (
          id, username, role, kdf_salt, kdf_n, kdf_r, kdf_p,
          wrapped_dek, wrap_iv, wrap_tag, crypto_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updatePassword: this.db.prepare(`
        UPDATE users SET
          kdf_salt = ?, kdf_n = ?, kdf_r = ?, kdf_p = ?,
          wrapped_dek = ?, wrap_iv = ?, wrap_tag = ?, updated_at = ?
        WHERE id = ?
      `),
      listNotes: this.db.prepare(
        "SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC"
      ),
      findNote: this.db.prepare("SELECT * FROM notes WHERE id = ? AND user_id = ?"),
      insertNote: this.db.prepare(`
        INSERT INTO notes (
          id, user_id, ciphertext, iv, auth_tag, crypto_version,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateNote: this.db.prepare(`
        UPDATE notes SET
          ciphertext = ?, iv = ?, auth_tag = ?, crypto_version = ?,
          revision = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND revision = ?
      `),
      deleteNote: this.db.prepare(
        "DELETE FROM notes WHERE id = ? AND user_id = ?"
      ),
      insertInvite: this.db.prepare(`
        INSERT INTO invites (
          id, token_hash, created_by, expires_at, consumed_at, consumed_by, created_at
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?)
      `),
      findInvite: this.db.prepare(`
        SELECT * FROM invites
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
      `),
      consumeInvite: this.db.prepare(`
        UPDATE invites SET consumed_at = ?, consumed_by = ?
        WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
      `),
      listInvites: this.db.prepare(`
        SELECT id, expires_at, consumed_at, consumed_by, created_at
        FROM invites WHERE created_by = ? ORDER BY created_at DESC LIMIT 50
      `)
    };
  }

  userCount() {
    return Number(this.statements.countUsers.get().count);
  }

  findUser(username) {
    return this.statements.findUser.get(username);
  }

  async buildUser(username, password, role) {
    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(32);
    const passwordKey = await derivePasswordKey(password, salt, this.kdfParams);
    const dataKey = crypto.randomBytes(32);
    const wrapped = wrapDataKey(id, dataKey, passwordKey);
    passwordKey.fill(0);
    const now = new Date().toISOString();

    return {
      user: {
        id,
        username,
        role,
        kdf_salt: salt,
        kdf_n: this.kdfParams.N,
        kdf_r: this.kdfParams.r,
        kdf_p: this.kdfParams.p,
        wrapped_dek: wrapped.ciphertext,
        wrap_iv: wrapped.iv,
        wrap_tag: wrapped.tag,
        crypto_version: CRYPTO_VERSION,
        created_at: now,
        updated_at: now
      },
      dataKey
    };
  }

  insertUser(user) {
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

  async bootstrap(username, password) {
    const created = await this.buildUser(username, password, "admin");
    try {
      transaction(this.db, () => {
        if (this.userCount() !== 0) {
          throw new HttpError(409, "Sistema já configurado.");
        }
        this.insertUser(created.user);
      });
      return created;
    } catch (error) {
      created.dataKey.fill(0);
      throw error;
    }
  }

  async register(inviteToken, username, password) {
    const now = new Date().toISOString();
    const invite = this.statements.findInvite.get(hashToken(inviteToken), now);
    if (!invite) throw new HttpError(403, "Convite inválido ou expirado.");
    const created = await this.buildUser(username, password, "user");
    try {
      transaction(this.db, () => {
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
      if (String(error.message).includes("UNIQUE constraint failed: users.username")) {
        throw new HttpError(409, "Esse usuário já existe.");
      }
      throw error;
    }
  }

  async authenticate(username, password) {
    const user = this.findUser(username);
    let passwordKey;
    try {
      const salt = user ? Buffer.from(user.kdf_salt) : crypto.randomBytes(32);
      const params = user
        ? { N: user.kdf_n, r: user.kdf_r, p: user.kdf_p }
        : SCRYPT_PARAMS;
      passwordKey = await derivePasswordKey(password, salt, params);
      if (!user) throw new Error("invalid credentials");
      return { user, dataKey: unwrapDataKey(user, passwordKey) };
    } finally {
      if (passwordKey) passwordKey.fill(0);
    }
  }

  async changePassword(username, currentPassword, newPassword) {
    const user = this.findUser(username);
    let oldKey;
    let dataKey;
    try {
      oldKey = await derivePasswordKey(
        currentPassword,
        Buffer.from(user.kdf_salt),
        { N: user.kdf_n, r: user.kdf_r, p: user.kdf_p }
      );
      dataKey = unwrapDataKey(user, oldKey);
    } catch {
      throw new HttpError(401, "Senha atual inválida.");
    } finally {
      if (oldKey) oldKey.fill(0);
    }

    let newKey;
    try {
      const newSalt = crypto.randomBytes(32);
      newKey = await derivePasswordKey(newPassword, newSalt, this.kdfParams);
      const wrapped = wrapDataKey(user.id, dataKey, newKey);
      this.statements.updatePassword.run(
        newSalt,
        this.kdfParams.N,
        this.kdfParams.r,
        this.kdfParams.p,
        wrapped.ciphertext,
        wrapped.iv,
        wrapped.tag,
        new Date().toISOString(),
        user.id
      );
    } finally {
      if (newKey) newKey.fill(0);
      if (dataKey) dataKey.fill(0);
    }
  }

  listNotes(userId, dataKey) {
    return this.statements.listNotes.all(userId).map((row) => {
      try {
        return {
          id: row.id,
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

  createNote(userId, dataKey, payload) {
    const id = crypto.randomUUID();
    const revision = 1;
    const encrypted = encryptNote(dataKey, userId, id, revision, payload);
    const now = new Date().toISOString();
    this.statements.insertNote.run(
      id,
      userId,
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.tag,
      CRYPTO_VERSION,
      revision,
      now,
      now
    );
    return { id, ...payload, revision, createdAt: now, updatedAt: now };
  }

  updateNote(userId, dataKey, id, expectedRevision, payload) {
    const revision = expectedRevision + 1;
    const encrypted = encryptNote(dataKey, userId, id, revision, payload);
    const now = new Date().toISOString();
    const result = this.statements.updateNote.run(
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
    return { id, ...payload, revision, updatedAt: now };
  }

  deleteNote(userId, id) {
    const result = this.statements.deleteNote.run(id, userId);
    if (Number(result.changes) !== 1) {
      throw new HttpError(404, "Nota não encontrada.");
    }
  }

  createInvite(userId) {
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

  listInvites(userId) {
    return this.statements.listInvites.all(userId).map((invite) => ({
      id: invite.id,
      expiresAt: invite.expires_at,
      consumedAt: invite.consumed_at,
      createdAt: invite.created_at
    }));
  }

  close() {
    this.db.close();
  }
}

module.exports = { Vault };
