"use strict";

const http = require("node:http");
const path = require("node:path");
const { SCRYPT_PARAMS } = require("./crypto");
const {
  HttpError,
  loadSecret,
  readJson,
  safeEqualText,
  securityHeaders,
  sendFile,
  sendJson
} = require("./http");
const { SessionManager } = require("./sessions");
const { normalizeUsername, validateNotePayload, validatePassword } = require("./validation");
const { Vault } = require("./vault");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_IDLE_MS = 15 * 60 * 1000;

function createApplication(options = {}) {
  const dbPath =
    options.dbPath ||
    process.env.NOTES_DB ||
    path.join(ROOT, "data", "notes.sqlite");
  const setupToken =
    options.setupToken ??
    loadSecret("NOTES_ADMIN_SETUP_TOKEN_FILE", "NOTES_ADMIN_SETUP_TOKEN");
  const secureCookies =
    options.secureCookies ?? process.env.NOTES_HTTPS === "1";
  const vault = new Vault(dbPath, options.kdfParams || SCRYPT_PARAMS);
  const sessions = new SessionManager({
    secureCookies,
    idleMs: options.sessionIdleMs || SESSION_IDLE_MS
  });

  async function handleApi(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/status") {
      const session = sessions.get(req);
      return sendJson(res, 200, {
        bootstrapRequired: vault.userCount() === 0,
        authenticated: Boolean(session),
        ...(session
          ? {
              csrfToken: session.csrfToken,
              user: { username: session.username, role: session.role }
            }
          : {})
      });
    }

    if (req.method === "POST" && url.pathname === "/api/bootstrap") {
      if (vault.userCount() !== 0) throw new HttpError(404, "Rota indisponível.");
      if (!setupToken) {
        throw new HttpError(503, "Token de configuração não definido.");
      }
      const body = await readJson(req);
      if (!safeEqualText(body.setupToken, setupToken)) {
        throw new HttpError(403, "Token de configuração inválido.");
      }
      const username = normalizeUsername(body.username);
      validatePassword(body.password);
      const created = await vault.bootstrap(username, body.password);
      return sendJson(
        res,
        201,
        sessions.create(res, created.user, created.dataKey)
      );
    }

    if (req.method === "POST" && url.pathname === "/api/register") {
      if (vault.userCount() === 0) throw new HttpError(409, "Configure o administrador.");
      const body = await readJson(req);
      const username = normalizeUsername(body.username);
      validatePassword(body.password);
      if (typeof body.inviteToken !== "string" || body.inviteToken.length < 32) {
        throw new HttpError(400, "Convite inválido.");
      }
      const created = await vault.register(body.inviteToken, username, body.password);
      return sendJson(
        res,
        201,
        sessions.create(res, created.user, created.dataKey)
      );
    }

    if (req.method === "POST" && url.pathname === "/api/unlock") {
      const body = await readJson(req);
      const username = normalizeUsername(body.username);
      validatePassword(body.password);
      sessions.assertLoginAllowed(req, username);
      let authenticated;
      try {
        authenticated = await vault.authenticate(username, body.password);
      } catch {
        sessions.recordLoginFailure(req, username);
        throw new HttpError(401, "Usuário ou senha inválidos.", "invalid_credentials");
      }
      sessions.clearLoginFailures(req, username);
      return sendJson(
        res,
        200,
        sessions.create(res, authenticated.user, authenticated.dataKey)
      );
    }

    if (req.method === "POST" && url.pathname === "/api/lock") {
      const session = sessions.require(req);
      sessions.requireCsrf(req, session);
      sessions.destroy(session.token);
      res.setHeader("Set-Cookie", sessions.clearCookie());
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/password") {
      const session = sessions.require(req);
      sessions.requireCsrf(req, session);
      const body = await readJson(req);
      validatePassword(body.currentPassword);
      validatePassword(body.newPassword);
      await vault.changePassword(
        session.username,
        body.currentPassword,
        body.newPassword
      );
      sessions.revokeOthers(session.userId, session.token);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/notes") {
      const session = sessions.require(req);
      return sendJson(res, 200, {
        notes: vault.listNotes(session.userId, session.dataKey)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/notes") {
      const session = sessions.require(req);
      sessions.requireCsrf(req, session);
      const payload = validateNotePayload(await readJson(req));
      return sendJson(res, 201, {
        note: vault.createNote(session.userId, session.dataKey, payload)
      });
    }

    const noteMatch = url.pathname.match(/^\/api\/notes\/([0-9a-f-]{36})$/);
    if (noteMatch && req.method === "PATCH") {
      const session = sessions.require(req);
      sessions.requireCsrf(req, session);
      const body = await readJson(req);
      const payload = validateNotePayload(body);
      if (!Number.isInteger(body.revision) || body.revision < 1) {
        throw new HttpError(400, "Revisão inválida.");
      }
      return sendJson(res, 200, {
        note: vault.updateNote(
          session.userId,
          session.dataKey,
          noteMatch[1],
          body.revision,
          payload
        )
      });
    }

    if (noteMatch && req.method === "DELETE") {
      const session = sessions.require(req);
      sessions.requireCsrf(req, session);
      vault.deleteNote(session.userId, noteMatch[1]);
      res.statusCode = 204;
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/api/invites") {
      const session = sessions.require(req);
      sessions.requireCsrf(req, session);
      if (session.role !== "admin") throw new HttpError(403, "Acesso negado.");
      return sendJson(res, 201, vault.createInvite(session.userId));
    }

    if (req.method === "GET" && url.pathname === "/api/invites") {
      const session = sessions.require(req);
      if (session.role !== "admin") throw new HttpError(403, "Acesso negado.");
      return sendJson(res, 200, { invites: vault.listInvites(session.userId) });
    }

    throw new HttpError(404, "Rota não encontrada.");
  }

  const staticFiles = new Map([
    ["/", [path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8"]],
    ["/app.js", [path.join(PUBLIC_DIR, "app.js"), "text/javascript; charset=utf-8"]],
    ["/styles.css", [path.join(PUBLIC_DIR, "styles.css"), "text/css; charset=utf-8"]],
    [
      "/vendor/quill.js",
      [path.join(ROOT, "node_modules", "quill", "dist", "quill.js"), "text/javascript; charset=utf-8"]
    ],
    [
      "/vendor/quill.snow.css",
      [path.join(ROOT, "node_modules", "quill", "dist", "quill.snow.css"), "text/css; charset=utf-8"]
    ]
  ]);

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }

      const staticFile = staticFiles.get(url.pathname);
      if (!staticFile || req.method !== "GET") {
        throw new HttpError(404, "Recurso não encontrado.");
      }
      sendFile(res, staticFile[0], staticFile[1]);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.code, message: error.message });
        return;
      }
      console.error("Erro interno:", error?.stack || error);
      sendJson(res, 500, {
        error: "internal_error",
        message: "Erro interno do servidor."
      });
    }
  });

  function close() {
    sessions.close();
    vault.close();
  }

  return { server, close, db: vault.db };
}

module.exports = { createApplication };
