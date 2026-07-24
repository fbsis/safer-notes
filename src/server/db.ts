import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(filename: string) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);

  const database = new DatabaseSync(filename, {
    enableForeignKeyConstraints: true,
    timeout: 5000
  });
  fs.chmodSync(filename, 0o600);

  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      kdf_salt BLOB NOT NULL,
      kdf_n INTEGER NOT NULL,
      kdf_r INTEGER NOT NULL,
      kdf_p INTEGER NOT NULL,
      wrapped_dek BLOB NOT NULL,
      wrap_iv BLOB NOT NULL,
      wrap_tag BLOB NOT NULL,
      crypto_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
      ciphertext BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      crypto_version INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS notes_user_updated
      ON notes(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      metadata_ciphertext BLOB NOT NULL,
      metadata_iv BLOB NOT NULL,
      metadata_auth_tag BLOB NOT NULL,
      data_ciphertext BLOB NOT NULL,
      data_iv BLOB NOT NULL,
      data_auth_tag BLOB NOT NULL,
      crypto_version INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS attachments_note_user
      ON attachments(note_id, user_id, created_at);

  `);

  // A coluna permanece para compatibilidade com bancos antigos, mas não
  // concede privilégios: todas as contas têm exatamente as mesmas operações.
  database.exec("UPDATE users SET role = 'user' WHERE role <> 'user'");

  const noteColumns = database.prepare("PRAGMA table_info(notes)").all() as Array<{
    name: string;
  }>;
  if (!noteColumns.some((column) => column.name === "parent_id")) {
    database.exec(
      "ALTER TABLE notes ADD COLUMN parent_id TEXT REFERENCES notes(id) ON DELETE CASCADE"
    );
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS notes_parent_user
      ON notes(parent_id, user_id, updated_at DESC);
  `);

  return database;
}

export function transaction<T>(database: DatabaseSync, callback: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
