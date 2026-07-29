"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

function createClient(baseUrl) {
  return { baseUrl, cookie: "" };
}

async function request(client, pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  if (client.cookie) headers.set("Cookie", client.cookie);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${client.baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const cookie = response.headers.get("set-cookie");
  if (cookie) client.cookie = cookie.split(";")[0];
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function startNext(databasePath) {
  const port = await availablePort();
  const output = [];
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)],
    {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        NOTES_DB: databasePath,
        NOTES_ATTACHMENTS_DIR: path.join(path.dirname(databasePath), "attachments"),
        NOTES_IDLE_MINUTES: "0.05",
        NOTES_MAX_NOTE_MB: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Next encerrou antes de iniciar:\n${output.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/status`);
      if (response.ok) return { child, baseUrl, output };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  throw new Error(`Timeout ao iniciar Next:\n${output.join("")}`);
}

async function stopNext(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function insertLegacyUser(databasePath, username, password) {
  const id = crypto.randomUUID();
  const salt = crypto.randomBytes(32);
  const kdf = { N: 1024, r: 8, p: 1 };
  const passwordKey = crypto.scryptSync(
    password.normalize("NFKC"),
    salt,
    32,
    { ...kdf, maxmem: 16 * 1024 * 1024 }
  );
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", passwordKey, iv);
  cipher.setAAD(Buffer.from(`notes:user-dek:v1:${id}`, "utf8"));
  const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  passwordKey.fill(0);
  dataKey.fill(0);
  const now = new Date().toISOString();
  const database = new DatabaseSync(databasePath, { timeout: 5000 });
  database.prepare(`
    INSERT INTO users (
      id, username, role, kdf_salt, kdf_n, kdf_r, kdf_p,
      wrapped_dek, wrap_iv, wrap_tag, crypto_version, created_at, updated_at
    ) VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    username,
    salt,
    kdf.N,
    kdf.r,
    kdf.p,
    wrapped,
    iv,
    tag,
    now,
    now
  );
  database.close();
  return id;
}

test("migra anexos criptografados do SQLite para arquivos sem descriptografar", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "next-notes-migration-"));
  const databasePath = path.join(directory, "notes.sqlite");
  const userId = "4fc65717-3975-454f-9578-42a50f06380d";
  const noteId = "f22edb80-5301-4f94-81c6-9091a8862357";
  const attachmentId = "b291f930-8720-4e0a-bf6d-fea88df71165";
  const ciphertext = Buffer.from("bytes-ja-criptografados");
  const iv = Buffer.from("123456789012");
  const tag = Buffer.from("1234567890abcdef");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE users (
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
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ciphertext BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      crypto_version INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE attachments (
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
  `);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO users VALUES (?, ?, 'user', ?, 2, 1, 1, ?, ?, ?, 1, ?, ?)
  `).run(
    userId,
    "migration-user",
    Buffer.alloc(32, 1),
    Buffer.alloc(32, 2),
    Buffer.alloc(12, 3),
    Buffer.alloc(16, 4),
    now,
    now
  );
  database.prepare(`
    INSERT INTO notes VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
  `).run(
    noteId,
    userId,
    Buffer.alloc(32, 5),
    Buffer.alloc(12, 6),
    Buffer.alloc(16, 7),
    now,
    now
  );
  database.prepare(`
    INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    attachmentId,
    noteId,
    userId,
    Buffer.alloc(32, 8),
    Buffer.alloc(12, 9),
    Buffer.alloc(16, 10),
    ciphertext,
    iv,
    tag,
    now
  );
  database.close();

  const server = await startNext(databasePath);
  t.after(async () => {
    await stopNext(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const envelope = fs.readFileSync(
    path.join(directory, "attachments", `${attachmentId}.bin`)
  );
  assert.equal(envelope.subarray(0, 8).toString("ascii"), "SNATT001");
  assert.deepEqual(envelope.subarray(8, 20), iv);
  assert.deepEqual(envelope.subarray(20, 36), tag);
  assert.deepEqual(envelope.subarray(36), ciphertext);

  const migrated = new DatabaseSync(databasePath);
  const columns = migrated
    .prepare("PRAGMA table_info(attachments)")
    .all()
    .map((column) => column.name);
  assert.equal(columns.includes("data_ciphertext"), false);
  assert.equal(columns.includes("data_iv"), false);
  assert.equal(columns.includes("data_auth_tag"), false);
  assert.equal(
    migrated.prepare("SELECT COUNT(*) AS total FROM attachments").get().total,
    1
  );
  migrated.close();
});

test("cofre legado preserva notas e abre apenas com a senha após reiniciar", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "next-notes-legacy-login-"));
  const databasePath = path.join(directory, "notes.sqlite");
  let server = await startNext(databasePath);
  t.after(async () => {
    await stopNext(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const initial = createClient(server.baseUrl);
  let result = await request(initial, "/api/register", {
    method: "POST",
    body: { password: "legacy-vault-password" }
  });
  assert.equal(result.response.status, 201);
  result = await request(initial, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": result.data.csrfToken },
    body: {
      title: "Nota anterior à atualização",
      markdown: "Conteúdo que não pode ser perdido",
      parentId: null
    }
  });
  assert.equal(result.response.status, 201);
  const createdNoteId = result.data.note.id;
  const beforeRestart = new DatabaseSync(databasePath);
  const ciphertextBefore = Buffer.from(
    beforeRestart.prepare("SELECT ciphertext FROM notes WHERE id = ?")
      .get(createdNoteId).ciphertext
  );
  const wrappedKeyBefore = Buffer.from(
    beforeRestart.prepare("SELECT wrapped_dek FROM users").get().wrapped_dek
  );
  beforeRestart.close();
  await stopNext(server.child);

  const database = new DatabaseSync(databasePath);
  database.exec("UPDATE users SET username = 'identificacao-antiga'");
  database.close();

  server = await startNext(databasePath);
  const migrated = createClient(server.baseUrl);
  result = await request(migrated, "/api/unlock", {
    method: "POST",
    body: { password: "legacy-vault-password" }
  });
  assert.equal(result.response.status, 200);
  assert.equal("user" in result.data, false);
  result = await request(migrated, "/api/notes");
  assert.equal(result.response.status, 200);
  assert.equal(result.data.notes[0].title, "Nota anterior à atualização");
  assert.equal(result.data.notes[0].markdown, "Conteúdo que não pode ser perdido");
  const afterRestart = new DatabaseSync(databasePath);
  assert.deepEqual(
    Buffer.from(
      afterRestart.prepare("SELECT ciphertext FROM notes WHERE id = ?")
        .get(createdNoteId).ciphertext
    ),
    ciphertextBefore
  );
  assert.deepEqual(
    Buffer.from(afterRestart.prepare("SELECT wrapped_dek FROM users").get().wrapped_dek),
    wrappedKeyBefore
  );
  afterRestart.close();
});

test("Next.js preserva criptografia e isolamento entre cofres", async (t) => {
  const { base64DataUrlToFile, readClipboardFiles, readDraggedUrl } = await import(
    "../src/components/drop-utils.mjs"
  );
  const transfer = (uri, plain = "") => ({
    getData(type) {
      return type === "text/uri-list" ? uri : plain;
    }
  });
  assert.equal(
    readDraggedUrl(transfer("# comentário\nhttps://example.test/private")),
    "https://example.test/private"
  );
  assert.equal(readDraggedUrl(transfer("javascript:alert(1)")), null);
  assert.equal(readDraggedUrl(transfer("", "data:text/html,danger")), null);
  const pastedFile = { name: "clipboard.png" };
  assert.deepEqual(
    readClipboardFiles({
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => pastedFile }
      ]
    }),
    [pastedFile]
  );
  const convertedImage = await base64DataUrlToFile(
    "data:image/png;base64,iVBORw0KGgo=",
    2
  );
  assert.equal(convertedImage.type, "image/png");
  assert.match(convertedImage.name, /-2\.png$/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "next-notes-"));
  const databasePath = path.join(directory, "notes.sqlite");
  const attachmentsDirectory = path.join(directory, "attachments");
  const legacyDatabase = new DatabaseSync(databasePath);
  legacyDatabase.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ciphertext BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      crypto_version INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE attachments (
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
  `);
  legacyDatabase.close();
  const server = await startNext(databasePath);

  t.after(async () => {
    await stopNext(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const primary = createClient(server.baseUrl);
  let result = await request(primary, "/api/status");
  assert.equal(result.data.idleTimeoutMs, 3000);
  assert.equal("bootstrapRequired" in result.data, false);
  const page = await fetch(server.baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /strict-dynamic/);
  assert.match(await page.text(), /Cofre de notas/);

  result = await request(primary, "/api/register", {
    method: "POST",
    body: {
      password: "primary-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 201);
  assert.equal("user" in result.data, false);
  const primaryCsrf = result.data.csrfToken;
  const accountDatabase = new DatabaseSync(databasePath);
  const primaryAccount = accountDatabase
    .prepare("SELECT id, username, role FROM users")
    .get();
  assert.equal(primaryAccount.role, "user");
  assert.equal(primaryAccount.username, primaryAccount.id);
  accountDatabase
    .prepare("UPDATE users SET username = ? WHERE id = ?")
    .run("primary", primaryAccount.id);
  accountDatabase.close();

  const duplicate = createClient(server.baseUrl);
  result = await request(duplicate, "/api/register", {
    method: "POST",
    body: {
      password: "primary-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error, "password_in_use");

  result = await request(primary, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": primaryCsrf },
    body: {
      title: "SEGREDO-TITULO-NAO-DEVE-APARECER",
      markdown: "# SEGREDO-CONTEUDO-NAO-DEVE-APARECER\n\nTexto com **negrito**."
    }
  });
  assert.equal(result.response.status, 201);
  const primaryNote = result.data.note;
  assert.equal(primaryNote.parentId, null);
  assert.equal(
    primaryNote.markdown,
    "# SEGREDO-CONTEUDO-NAO-DEVE-APARECER\n\nTexto com **negrito**."
  );

  result = await request(primary, `/api/notes/${primaryNote.id}`, {
    method: "PATCH",
    headers: { "X-CSRF-Token": primaryCsrf },
    body: {
      title: primaryNote.title,
      markdown: "![base64](data:image/png;base64,iVBORw0KGgo=)",
      parentId: null,
      revision: primaryNote.revision
    }
  });
  assert.equal(result.response.status, 400);
  assert.match(result.data.message, /base64 não é permitido/);

  result = await request(primary, `/api/notes/${primaryNote.id}`, {
    method: "PATCH",
    headers: { "X-CSRF-Token": primaryCsrf },
    body: {
      title: primaryNote.title,
      markdown: "x".repeat(1024 * 1024),
      parentId: null,
      revision: primaryNote.revision
    }
  });
  assert.equal(result.response.status, 413);
  assert.match(result.data.message, /limite de 1 MiB/);

  result = await request(primary, `/api/notes/${primaryNote.id}`, {
    method: "PATCH",
    headers: { "X-CSRF-Token": primaryCsrf },
    body: {
      title: primaryNote.title,
      markdown: `${primaryNote.markdown}\n\n- item em Markdown\n\n[link privado](https://example.test/SEGREDO-LINK-CRIPTOGRAFADO)`,
      revision: primaryNote.revision
    }
  });
  assert.equal(result.response.status, 200);
  assert.match(result.data.note.markdown, /SEGREDO-LINK-CRIPTOGRAFADO/);
  primaryNote.revision = result.data.note.revision;

  result = await request(primary, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": primaryCsrf },
    body: {
      title: "Página filha",
      markdown: "Conteúdo filho",
      parentId: primaryNote.id
    }
  });
  assert.equal(result.response.status, 201);
  const childNote = result.data.note;
  assert.equal(childNote.parentId, primaryNote.id);

  result = await request(primary, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": primaryCsrf },
    body: {
      title: "Página neta",
      markdown: "Conteúdo neto",
      parentId: childNote.id
    }
  });
  assert.equal(result.response.status, 201);
  const grandchildNote = result.data.note;
  assert.equal(grandchildNote.parentId, childNote.id);

  const hierarchyDatabase = new DatabaseSync(databasePath);
  hierarchyDatabase
    .prepare("UPDATE notes SET parent_id = ? WHERE id = ?")
    .run(primaryNote.id, grandchildNote.id);
  result = await request(primary, "/api/notes");
  assert.equal(result.response.status, 500);
  assert.equal(result.data.error, "data_integrity_error");
  hierarchyDatabase
    .prepare("UPDATE notes SET parent_id = ? WHERE id = ?")
    .run(childNote.id, grandchildNote.id);
  hierarchyDatabase.close();

  result = await request(primary, `/api/notes/${primaryNote.id}`, {
    method: "PATCH",
    headers: { "X-CSRF-Token": primaryCsrf },
    body: {
      title: primaryNote.title,
      markdown: primaryNote.markdown,
      parentId: childNote.id,
      revision: primaryNote.revision
    }
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error, "invalid_parent");

  result = await request(primary, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": primaryCsrf },
    body: { title: "Subárvore descartável", markdown: "", parentId: null }
  });
  assert.equal(result.response.status, 201);
  const disposableRoot = result.data.note;
  result = await request(primary, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": primaryCsrf },
    body: {
      title: "Filha descartável",
      markdown: "",
      parentId: disposableRoot.id
    }
  });
  const disposableChild = result.data.note;
  const disposableAttachmentForm = new FormData();
  disposableAttachmentForm.set(
    "file",
    new File(["anexo descartável"], "descartavel.txt", { type: "text/plain" })
  );
  const disposableAttachmentResponse = await fetch(
    `${primary.baseUrl}/api/notes/${disposableChild.id}/attachments`,
    {
      method: "POST",
      headers: {
        Cookie: primary.cookie,
        "X-CSRF-Token": primaryCsrf
      },
      body: disposableAttachmentForm
    }
  );
  assert.equal(disposableAttachmentResponse.status, 201);
  const disposableAttachment = (await disposableAttachmentResponse.json()).attachment;
  const disposableAttachmentPath = path.join(
    attachmentsDirectory,
    `${disposableAttachment.id}.bin`
  );
  assert.equal(fs.existsSync(disposableAttachmentPath), true);
  result = await request(primary, `/api/notes/${disposableRoot.id}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": primaryCsrf }
  });
  assert.equal(result.response.status, 204);
  assert.equal(fs.existsSync(disposableAttachmentPath), false);
  result = await request(primary, "/api/notes");
  assert.equal(
    result.data.notes.some((note) =>
      note.id === disposableRoot.id || note.id === disposableChild.id
    ),
    false
  );

  const attachmentSecret = "SEGREDO-ARQUIVO-NAO-DEVE-APARECER";
  const attachmentForm = new FormData();
  attachmentForm.set(
    "file",
    new File(
      [attachmentSecret],
      "SEGREDO-NOME-DO-ARQUIVO.txt",
      { type: "text/plain" }
    )
  );
  let attachmentResponse = await fetch(
    `${primary.baseUrl}/api/notes/${primaryNote.id}/attachments`,
    {
      method: "POST",
      headers: {
        Cookie: primary.cookie,
        "X-CSRF-Token": primaryCsrf
      },
      body: attachmentForm
    }
  );
  assert.equal(attachmentResponse.status, 201);
  const attachmentResult = await attachmentResponse.json();
  const attachment = attachmentResult.attachment;
  assert.equal(attachment.name, "SEGREDO-NOME-DO-ARQUIVO.txt");
  assert.equal(attachment.isImage, false);
  const attachmentPath = path.join(attachmentsDirectory, `${attachment.id}.bin`);
  assert.equal(fs.existsSync(attachmentPath), true);
  const attachmentEnvelope = fs.readFileSync(attachmentPath);
  assert.equal(attachmentEnvelope.subarray(0, 8).toString("ascii"), "SNATT001");
  assert.equal(attachmentEnvelope.includes(Buffer.from(attachmentSecret)), false);
  assert.equal(
    attachmentEnvelope.includes(Buffer.from("SEGREDO-NOME-DO-ARQUIVO")),
    false
  );

  const attachmentDatabase = new DatabaseSync(databasePath);
  const attachmentColumns = attachmentDatabase
    .prepare("PRAGMA table_info(attachments)")
    .all()
    .map((column) => column.name);
  assert.equal(attachmentColumns.includes("data_ciphertext"), false);
  assert.equal(attachmentColumns.includes("data_iv"), false);
  assert.equal(attachmentColumns.includes("data_auth_tag"), false);
  assert.equal(
    attachmentDatabase
      .prepare("SELECT COUNT(*) AS total FROM attachments WHERE id = ?")
      .get(attachment.id).total,
    1
  );
  attachmentDatabase.close();

  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const imageForm = new FormData();
  imageForm.set("file", new File([imageBytes], "pixel.png", { type: "image/png" }));
  attachmentResponse = await fetch(
    `${primary.baseUrl}/api/notes/${primaryNote.id}/attachments`,
    {
      method: "POST",
      headers: {
        Cookie: primary.cookie,
        "X-CSRF-Token": primaryCsrf
      },
      body: imageForm
    }
  );
  assert.equal(attachmentResponse.status, 201);
  const imageAttachment = (await attachmentResponse.json()).attachment;
  assert.equal(imageAttachment.isImage, true);

  result = await request(primary, `/api/notes/${primaryNote.id}/attachments`);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.attachments.length, 2);

  attachmentResponse = await fetch(`${primary.baseUrl}${attachment.url}`, {
    headers: { Cookie: primary.cookie }
  });
  assert.equal(attachmentResponse.status, 200);
  assert.equal(attachmentResponse.headers.get("content-type"), "application/octet-stream");
  assert.match(attachmentResponse.headers.get("content-disposition"), /^attachment;/);
  assert.equal(await attachmentResponse.text(), attachmentSecret);

  attachmentResponse = await fetch(`${primary.baseUrl}${imageAttachment.url}`, {
    headers: { Cookie: primary.cookie }
  });
  assert.equal(attachmentResponse.status, 200);
  assert.equal(attachmentResponse.headers.get("content-type"), "image/png");
  assert.match(attachmentResponse.headers.get("content-disposition"), /^inline;/);
  assert.deepEqual(Buffer.from(await attachmentResponse.arrayBuffer()), imageBytes);

  const databaseBytes = fs.readFileSync(databasePath);
  assert.equal(databaseBytes.includes(Buffer.from("SEGREDO-TITULO")), false);
  assert.equal(databaseBytes.includes(Buffer.from("SEGREDO-CONTEUDO")), false);
  assert.equal(databaseBytes.includes(Buffer.from("SEGREDO-LINK-CRIPTOGRAFADO")), false);
  assert.equal(databaseBytes.includes(Buffer.from("SEGREDO-NOME-DO-ARQUIVO")), false);
  assert.equal(databaseBytes.includes(Buffer.from(attachmentSecret)), false);
  if (fs.existsSync(`${databasePath}-wal`)) {
    const walBytes = fs.readFileSync(`${databasePath}-wal`);
    assert.equal(walBytes.includes(Buffer.from("SEGREDO-TITULO")), false);
    assert.equal(walBytes.includes(Buffer.from("SEGREDO-CONTEUDO")), false);
    assert.equal(walBytes.includes(Buffer.from("SEGREDO-LINK-CRIPTOGRAFADO")), false);
    assert.equal(walBytes.includes(Buffer.from("SEGREDO-NOME-DO-ARQUIVO")), false);
    assert.equal(walBytes.includes(Buffer.from(attachmentSecret)), false);
  }

  const user = createClient(server.baseUrl);
  result = await request(user, "/api/register", {
    method: "POST",
    body: {
      password: "user-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 201);
  const userCsrf = result.data.csrfToken;

  insertLegacyUser(databasePath, "legacy-one", "shared-legacy-password");
  insertLegacyUser(databasePath, "legacy-two", "shared-legacy-password");
  const ambiguousLegacy = createClient(server.baseUrl);
  result = await request(ambiguousLegacy, "/api/unlock", {
    method: "POST",
    body: { password: "shared-legacy-password" }
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error, "ambiguous_password");

  result = await request(ambiguousLegacy, "/api/unlock", {
    method: "POST",
    body: {
      username: "legacy-one",
      password: "shared-legacy-password"
    }
  });
  assert.equal(result.response.status, 200);
  const legacyCsrf = result.data.csrfToken;
  result = await request(ambiguousLegacy, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": legacyCsrf },
    body: {
      title: "Cofre legado preservado",
      markdown: "Conteúdo legado acessível",
      parentId: null
    }
  });
  assert.equal(result.response.status, 201);
  result = await request(ambiguousLegacy, "/api/notes");
  assert.equal(result.data.notes[0].title, "Cofre legado preservado");
  result = await request(ambiguousLegacy, "/api/password", {
    method: "POST",
    headers: { "X-CSRF-Token": legacyCsrf },
    body: {
      currentPassword: "shared-legacy-password",
      newPassword: "unique-legacy-password"
    }
  });
  assert.equal(result.response.status, 200);
  result = await request(ambiguousLegacy, "/api/lock", {
    method: "POST",
    headers: { "X-CSRF-Token": legacyCsrf },
    body: {}
  });
  assert.equal(result.response.status, 200);
  result = await request(ambiguousLegacy, "/api/unlock", {
    method: "POST",
    body: { password: "unique-legacy-password" }
  });
  assert.equal(result.response.status, 200);
  result = await request(ambiguousLegacy, "/api/notes");
  assert.equal(result.data.notes[0].title, "Cofre legado preservado");

  result = await request(user, "/api/notes");
  assert.deepEqual(result.data.notes, []);

  result = await request(user, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": userCsrf },
    body: {
      title: "Tentativa entre cofres",
      markdown: "",
      parentId: primaryNote.id
    }
  });
  assert.equal(result.response.status, 404);

  result = await request(user, `/api/notes/${primaryNote.id}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": userCsrf }
  });
  assert.equal(result.response.status, 404);

  attachmentResponse = await fetch(`${user.baseUrl}${attachment.url}`, {
    headers: { Cookie: user.cookie }
  });
  assert.equal(attachmentResponse.status, 404);

  result = await request(primary, `/api/attachments/${attachment.id}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": primaryCsrf }
  });
  assert.equal(result.response.status, 204);
  assert.equal(fs.existsSync(attachmentPath), false);
  attachmentResponse = await fetch(`${primary.baseUrl}${attachment.url}`, {
    headers: { Cookie: primary.cookie }
  });
  assert.equal(attachmentResponse.status, 404);

  result = await request(primary, "/api/password", {
    method: "POST",
    headers: { "X-CSRF-Token": primaryCsrf },
    body: {
      currentPassword: "primary-password-that-is-long",
      newPassword: "user-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error, "password_in_use");

  result = await request(primary, "/api/password", {
    method: "POST",
    headers: { "X-CSRF-Token": primaryCsrf },
    body: {
      currentPassword: "primary-password-that-is-long",
      newPassword: "new-primary-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 200);

  result = await request(primary, "/api/lock", {
    method: "POST",
    headers: { "X-CSRF-Token": primaryCsrf },
    body: {}
  });
  assert.equal(result.response.status, 200);

  result = await request(primary, "/api/unlock", {
    method: "POST",
    body: { password: "new-primary-password-that-is-long" }
  });
  assert.equal(result.response.status, 200);
  result = await request(primary, "/api/notes");
  assert.equal(result.response.status, 200);
  assert.equal(
    result.data.notes.some((note) => note.id === primaryNote.id),
    true
  );

  await new Promise((resolve) => setTimeout(resolve, 3200));
  result = await request(primary, "/api/notes");
  assert.equal(result.response.status, 401);
  result = await request(primary, "/api/unlock", {
    method: "POST",
    body: { password: "new-primary-password-that-is-long" }
  });
  assert.equal(result.response.status, 200);

  const database = new DatabaseSync(databasePath);
  const row = database
    .prepare("SELECT ciphertext FROM notes WHERE id = ?")
    .get(primaryNote.id);
  const tampered = Buffer.from(row.ciphertext);
  tampered[0] ^= 0xff;
  database
    .prepare("UPDATE notes SET ciphertext = ? WHERE id = ?")
    .run(tampered, primaryNote.id);
  database.close();

  result = await request(primary, "/api/notes");
  assert.equal(result.response.status, 500);
  assert.equal(result.data.error, "data_integrity_error");
  assert.equal(JSON.stringify(result.data).includes("SEGREDO"), false);
});
