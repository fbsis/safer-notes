"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createApplication } = require("../notes/notes");

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

test("cofres são criptografados e isolados por usuário", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "encrypted-notes-"));
  const dbPath = path.join(directory, "notes.sqlite");
  const app = createApplication({
    dbPath,
    setupToken: "setup-token-for-integration-test",
    kdfParams: { N: 1024, r: 8, p: 1, maxmem: 16 * 1024 * 1024 }
  });

  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const admin = createClient(baseUrl);
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await page.text(), /Cofre de notas/);

  const quillAsset = await fetch(`${baseUrl}/vendor/quill.js`);
  assert.equal(quillAsset.status, 200);
  assert.match(quillAsset.headers.get("content-type"), /javascript/);

  let result = await request(admin, "/api/status");
  assert.equal(result.data.bootstrapRequired, true);

  result = await request(admin, "/api/bootstrap", {
    method: "POST",
    body: {
      setupToken: "wrong-token",
      username: "admin",
      password: "admin-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 403);

  result = await request(admin, "/api/bootstrap", {
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
      delta: { ops: [{ insert: "SEGREDO-CONTEUDO-NAO-DEVE-APARECER\n" }] }
    }
  });
  assert.equal(result.response.status, 201);
  const adminNote = result.data.note;

  result = await request(admin, "/api/notes", {
    method: "POST",
    body: {
      title: "Sem CSRF",
      delta: { ops: [{ insert: "não deve salvar\n" }] }
    }
  });
  assert.equal(result.response.status, 403);

  const databaseBytes = fs.readFileSync(dbPath);
  assert.equal(databaseBytes.includes(Buffer.from("SEGREDO-TITULO")), false);
  assert.equal(databaseBytes.includes(Buffer.from("SEGREDO-CONTEUDO")), false);
  if (fs.existsSync(`${dbPath}-wal`)) {
    const walBytes = fs.readFileSync(`${dbPath}-wal`);
    assert.equal(walBytes.includes(Buffer.from("SEGREDO-TITULO")), false);
    assert.equal(walBytes.includes(Buffer.from("SEGREDO-CONTEUDO")), false);
  }

  result = await request(admin, "/api/invites", {
    method: "POST",
    headers: { "X-CSRF-Token": adminCsrf },
    body: {}
  });
  assert.equal(result.response.status, 201);
  const inviteToken = result.data.token;
  assert.equal(fs.readFileSync(dbPath).includes(Buffer.from(inviteToken)), false);

  const user = createClient(baseUrl);
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

  const reusedInvite = createClient(baseUrl);
  result = await request(reusedInvite, "/api/register", {
    method: "POST",
    body: {
      inviteToken,
      username: "outro",
      password: "another-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 403);

  result = await request(user, "/api/notes");
  assert.deepEqual(result.data.notes, []);

  result = await request(user, "/api/notes", {
    method: "POST",
    headers: { "X-CSRF-Token": userCsrf },
    body: {
      title: "Nota do usuário",
      delta: { ops: [{ insert: "conteúdo separado\n" }] }
    }
  });
  assert.equal(result.response.status, 201);

  result = await request(user, `/api/notes/${adminNote.id}`, {
    method: "DELETE",
    headers: { "X-CSRF-Token": userCsrf }
  });
  assert.equal(result.response.status, 404);

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
    body: {
      username: "admin",
      password: "admin-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 401);

  result = await request(admin, "/api/unlock", {
    method: "POST",
    body: {
      username: "admin",
      password: "new-admin-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 200);

  result = await request(admin, "/api/notes");
  assert.equal(result.response.status, 200);
  assert.equal(result.data.notes.length, 1);
  assert.equal(result.data.notes[0].title, "SEGREDO-TITULO-NAO-DEVE-APARECER");

  const row = app.db.prepare("SELECT ciphertext FROM notes WHERE id = ?").get(adminNote.id);
  const tampered = Buffer.from(row.ciphertext);
  tampered[0] ^= 0xff;
  app.db.prepare("UPDATE notes SET ciphertext = ? WHERE id = ?").run(tampered, adminNote.id);

  result = await request(admin, "/api/notes");
  assert.equal(result.response.status, 500);
  assert.equal(result.data.error, "data_integrity_error");
  assert.equal(JSON.stringify(result.data).includes("SEGREDO"), false);
});

test("sessão expira por inatividade", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "encrypted-notes-timeout-"));
  const app = createApplication({
    dbPath: path.join(directory, "notes.sqlite"),
    setupToken: "timeout-test-setup-token",
    sessionIdleMs: 25,
    kdfParams: { N: 1024, r: 8, p: 1, maxmem: 16 * 1024 * 1024 }
  });

  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  const client = createClient(`http://127.0.0.1:${address.port}`);

  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let result = await request(client, "/api/bootstrap", {
    method: "POST",
    body: {
      setupToken: "timeout-test-setup-token",
      username: "admin",
      password: "timeout-password-that-is-long"
    }
  });
  assert.equal(result.response.status, 201);

  await new Promise((resolve) => setTimeout(resolve, 40));
  result = await request(client, "/api/status");
  assert.equal(result.data.authenticated, false);
});
