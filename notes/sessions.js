"use strict";

const crypto = require("node:crypto");
const { HttpError, parseCookies, safeEqualText } = require("./http");

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

class SessionManager {
  constructor({ secureCookies, idleMs }) {
    this.secureCookies = secureCookies;
    this.idleMs = idleMs;
    this.sessions = new Map();
    this.loginFailures = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 1000);
    this.cleanupTimer.unref();
  }

  cookie(token) {
    const parts = [
      `notes_session=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict"
    ];
    if (this.secureCookies) parts.push("Secure");
    return parts.join("; ");
  }

  clearCookie() {
    const parts = [
      "notes_session=",
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=0"
    ];
    if (this.secureCookies) parts.push("Secure");
    return parts.join("; ");
  }

  create(res, user, dataKey) {
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    const sessionKey = Buffer.from(dataKey);
    if (Buffer.isBuffer(dataKey)) dataKey.fill(0);
    this.sessions.set(token, {
      userId: user.id,
      username: user.username,
      role: user.role,
      dataKey: sessionKey,
      csrfToken,
      lastActivity: Date.now()
    });
    res.setHeader("Set-Cookie", this.cookie(token));
    return { csrfToken, user: { username: user.username, role: user.role } };
  }

  get(req, touch = true) {
    const token = parseCookies(req.headers.cookie).notes_session;
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (Date.now() - session.lastActivity > this.idleMs) {
      this.destroy(token);
      return null;
    }
    if (touch) session.lastActivity = Date.now();
    return { token, ...session };
  }

  require(req) {
    const session = this.get(req);
    if (!session) throw new HttpError(401, "Cofre bloqueado.", "locked");
    return session;
  }

  requireCsrf(req, session) {
    const supplied = req.headers["x-csrf-token"];
    if (typeof supplied !== "string" || !safeEqualText(supplied, session.csrfToken)) {
      throw new HttpError(403, "Token CSRF inválido.", "csrf");
    }
  }

  destroy(token) {
    const session = this.sessions.get(token);
    if (session?.dataKey) session.dataKey.fill(0);
    this.sessions.delete(token);
  }

  revokeOthers(userId, currentToken) {
    for (const [token, session] of this.sessions) {
      if (session.userId === userId && token !== currentToken) this.destroy(token);
    }
  }

  loginKey(req, username) {
    return `${req.socket.remoteAddress || "unknown"}:${username}`;
  }

  assertLoginAllowed(req, username) {
    const key = this.loginKey(req, username);
    const record = this.loginFailures.get(key);
    if (!record) return;
    if (Date.now() - record.startedAt >= LOGIN_WINDOW_MS) {
      this.loginFailures.delete(key);
      return;
    }
    if (record.count >= LOGIN_MAX_FAILURES) {
      throw new HttpError(
        429,
        "Muitas tentativas. Aguarde 15 minutos.",
        "rate_limited"
      );
    }
  }

  recordLoginFailure(req, username) {
    const key = this.loginKey(req, username);
    const current = this.loginFailures.get(key);
    if (!current || Date.now() - current.startedAt >= LOGIN_WINDOW_MS) {
      this.loginFailures.set(key, { count: 1, startedAt: Date.now() });
    } else {
      current.count += 1;
    }
  }

  clearLoginFailures(req, username) {
    this.loginFailures.delete(this.loginKey(req, username));
  }

  cleanup() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (now - session.lastActivity > this.idleMs) this.destroy(token);
    }
    for (const [key, record] of this.loginFailures) {
      if (now - record.startedAt >= LOGIN_WINDOW_MS) this.loginFailures.delete(key);
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
    for (const token of this.sessions.keys()) this.destroy(token);
  }
}

module.exports = { SessionManager };
