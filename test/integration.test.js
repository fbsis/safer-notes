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
      delta: { ops: [{ insert: "SEGREDO-CONTEUDO-NAO-DEVE-APARECER\n" }] }
    }
  });
  assert.equal(result.response.status, 201);
  const adminNote = result.data.note;

  const databaseBytes = fs.readFileSync(databasePath);
  assert.equal(databaseBytes.includes(Buffer.from("SEGREDO-TITULO")), false);
  assert.equal(databaseBytes.includes(Buffer.from("SEGREDO-CONTEUDO")), false);
  if (fs.existsSync(`${databasePath}-wal`)) {
    const walBytes = fs.readFileSync(`${databasePath}-wal`);
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
