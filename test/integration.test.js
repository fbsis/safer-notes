"use strict";

const assert = require("node:assert/strict");
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

async function startNext(databasePath, setupToken) {
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
        NOTES_ADMIN_SETUP_TOKEN: setupToken
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

test("Next.js preserva criptografia e isolamento entre cofres", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "next-notes-"));
  const databasePath = path.join(directory, "notes.sqlite");
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
  `);
  legacyDatabase.close();
  const server = await startNext(databasePath, "setup-token-for-integration-test");

  t.after(async () => {
    await stopNext(server.child);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const admin = createClient(server.baseUrl);
  const page = await fetch(server.baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /strict-dynamic/);
  assert.match(await page.text(), /Cofre de notas/);

  let result = await request(admin, "/api/bootstrap", {
    method: "POST",
    body: {
      setupToken: "setup-token-for-integration-test",
      username: "admin",
      password: "admin-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 201);
  const adminCsrf = result.data.csrfToken;

  result = await request(admin, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": adminCsrf },
    body: {
      title: "SEGREDO-TITULO-NAO-DEVE-APARECER",
      markdown: "# SEGREDO-CONTEUDO-NAO-DEVE-APARECER\n\nTexto com **negrito**."
    }
  });
  assert.equal(result.response.status, 201);
  const adminNote = result.data.note;
  assert.equal(adminNote.parentId, null);
  assert.equal(
    adminNote.markdown,
    "# SEGREDO-CONTEUDO-NAO-DEVE-APARECER\n\nTexto com **negrito**."
  );

  result = await request(admin, `/api/notes/${adminNote.id}`, {
    method: "PATCH",
    headers: { "X-CSRF-Token": adminCsrf },
    body: {
      title: adminNote.title,
      markdown: `${adminNote.markdown}\n\n- item em Markdown`,
      revision: adminNote.revision
    }
  });
  assert.equal(result.response.status, 200);
  assert.match(result.data.note.markdown, /- item em Markdown$/);
  adminNote.revision = result.data.note.revision;

  result = await request(admin, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": adminCsrf },
    body: {
      title: "Página filha",
      markdown: "Conteúdo filho",
      parentId: adminNote.id
    }
  });
  assert.equal(result.response.status, 201);
  const childNote = result.data.note;
  assert.equal(childNote.parentId, adminNote.id);

  result = await request(admin, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": adminCsrf },
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
    .run(adminNote.id, grandchildNote.id);
  result = await request(admin, "/api/notes");
  assert.equal(result.response.status, 500);
  assert.equal(result.data.error, "data_integrity_error");
  hierarchyDatabase
    .prepare("UPDATE notes SET parent_id = ? WHERE id = ?")
    .run(childNote.id, grandchildNote.id);
  hierarchyDatabase.close();

  result = await request(admin, `/api/notes/${adminNote.id}`, {
    method: "PATCH",
    headers: { "X-CSRF-Token": adminCsrf },
    body: {
      title: adminNote.title,
      markdown: adminNote.markdown,
      parentId: childNote.id,
      revision: adminNote.revision
    }
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error, "invalid_parent");

  result = await request(admin, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": adminCsrf },
    body: { title: "Subárvore descartável", markdown: "", parentId: null }
  });
  assert.equal(result.response.status, 201);
  const disposableRoot = result.data.note;
  result = await request(admin, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": adminCsrf },
    body: {
      title: "Filha descartável",
      markdown: "",
      parentId: disposableRoot.id
    }
  });
  const disposableChild = result.data.note;
  result = await request(admin, `/api/notes/${disposableRoot.id}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": adminCsrf }
  });
  assert.equal(result.response.status, 204);
  result = await request(admin, "/api/notes");
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
    `${admin.baseUrl}/api/notes/${adminNote.id}/attachments`,
    {
      method: "POST",
      headers: {
        Cookie: admin.cookie,
        "X-CSRF-Token": adminCsrf
      },
      body: attachmentForm
    }
  );
  assert.equal(attachmentResponse.status, 201);
  const attachmentResult = await attachmentResponse.json();
  const attachment = attachmentResult.attachment;
  assert.equal(attachment.name, "SEGREDO-NOME-DO-ARQUIVO.txt");
  assert.equal(attachment.isImage, false);

  const imageBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const imageForm = new FormData();
  imageForm.set("file", new File([imageBytes], "pixel.png", { type: "image/png" }));
  attachmentResponse = await fetch(
    `${admin.baseUrl}/api/notes/${adminNote.id}/attachments`,
    {
      method: "POST",
      headers: {
        Cookie: admin.cookie,
        "X-CSRF-Token": adminCsrf
      },
      body: imageForm
    }
  );
  assert.equal(attachmentResponse.status, 201);
  const imageAttachment = (await attachmentResponse.json()).attachment;
  assert.equal(imageAttachment.isImage, true);

  result = await request(admin, `/api/notes/${adminNote.id}/attachments`);
  assert.equal(result.response.status, 200);
  assert.equal(result.data.attachments.length, 2);

  attachmentResponse = await fetch(`${admin.baseUrl}${attachment.url}`, {
    headers: { Cookie: admin.cookie }
  });
  assert.equal(attachmentResponse.status, 200);
  assert.equal(attachmentResponse.headers.get("content-type"), "application/octet-stream");
  assert.match(attachmentResponse.headers.get("content-disposition"), /^attachment;/);
  assert.equal(await attachmentResponse.text(), attachmentSecret);

  attachmentResponse = await fetch(`${admin.baseUrl}${imageAttachment.url}`, {
    headers: { Cookie: admin.cookie }
  });
  assert.equal(attachmentResponse.status, 200);
  assert.equal(attachmentResponse.headers.get("content-type"), "image/png");
  assert.match(attachmentResponse.headers.get("content-disposition"), /^inline;/);
  assert.deepEqual(Buffer.from(await attachmentResponse.arrayBuffer()), imageBytes);

  const databaseBytes = fs.readFileSync(databasePath);
  assert.equal(databaseBytes.includes(Buffer.from("SEGREDO-TITULO")), false);
  assert.equal(databaseBytes.includes(Buffer.from("SEGREDO-CONTEUDO")), false);
  assert.equal(databaseBytes.includes(Buffer.from("SEGREDO-NOME-DO-ARQUIVO")), false);
  assert.equal(databaseBytes.includes(Buffer.from(attachmentSecret)), false);
  if (fs.existsSync(`${databasePath}-wal`)) {
    const walBytes = fs.readFileSync(`${databasePath}-wal`);
    assert.equal(walBytes.includes(Buffer.from("SEGREDO-TITULO")), false);
    assert.equal(walBytes.includes(Buffer.from("SEGREDO-CONTEUDO")), false);
    assert.equal(walBytes.includes(Buffer.from("SEGREDO-NOME-DO-ARQUIVO")), false);
    assert.equal(walBytes.includes(Buffer.from(attachmentSecret)), false);
  }

  result = await request(admin, "/api/invites", {
    method: "POST",
    headers: { "X-CSRF-Token": adminCsrf },
    body: {}
  });
  assert.equal(result.response.status, 201);
  const inviteToken = result.data.token;
  assert.equal(fs.readFileSync(databasePath).includes(Buffer.from(inviteToken)), false);

  const user = createClient(server.baseUrl);
  result = await request(user, "/api/register", {
    method: "POST",
    body: {
      inviteToken,
      username: "usuario",
      password: "user-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 201);
  const userCsrf = result.data.csrfToken;

  result = await request(user, "/api/notes");
  assert.deepEqual(result.data.notes, []);

  result = await request(user, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": userCsrf },
    body: {
      title: "Tentativa entre cofres",
      markdown: "",
      parentId: adminNote.id
    }
  });
  assert.equal(result.response.status, 404);

  result = await request(user, `/api/notes/${adminNote.id}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": userCsrf }
  });
  assert.equal(result.response.status, 404);

  attachmentResponse = await fetch(`${user.baseUrl}${attachment.url}`, {
    headers: { Cookie: user.cookie }
  });
  assert.equal(attachmentResponse.status, 404);

  result = await request(admin, `/api/attachments/${attachment.id}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": adminCsrf }
  });
  assert.equal(result.response.status, 204);
  attachmentResponse = await fetch(`${admin.baseUrl}${attachment.url}`, {
    headers: { Cookie: admin.cookie }
  });
  assert.equal(attachmentResponse.status, 404);

  result = await request(admin, "/api/password", {
    method: "POST",
    headers: { "X-CSRF-Token": adminCsrf },
    body: {
      currentPassword: "admin-password-that-is-long",
      newPassword: "new-admin-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 200);

  result = await request(admin, "/api/lock", {
    method: "POST",
    headers: { "X-CSRF-Token": adminCsrf },
    body: {}
  });
  assert.equal(result.response.status, 200);

  result = await request(admin, "/api/unlock", {
    method: "POST",
    body: { username: "admin", password: "new-admin-password-that-is-long" }
  });
  assert.equal(result.response.status, 200);

  const database = new DatabaseSync(databasePath);
  const row = database
    .prepare("SELECT ciphertext FROM notes WHERE id = ?")
    .get(adminNote.id);
  const tampered = Buffer.from(row.ciphertext);
  tampered[0] ^= 0xff;
  database
    .prepare("UPDATE notes SET ciphertext = ? WHERE id = ?")
    .run(tampered, adminNote.id);
  database.close();

  result = await request(admin, "/api/notes");
  assert.equal(result.response.status, 500);
  assert.equal(result.data.error, "data_integrity_error");
  assert.equal(JSON.stringify(result.data).includes("SEGREDO"), false);
});
