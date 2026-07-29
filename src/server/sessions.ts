import crypto from "node:crypto";
import { HttpError } from "./errors";
import { safeEqualText } from "./crypto";
import type { UserRow } from "./types";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

export interface Session {
  token: string;
  userId: string;
  dataKey: Buffer;
  csrfToken: string;
  lastActivity: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, Omit<Session, "token">>();
  private readonly loginFailures = new Map<string, { count: number; startedAt: number }>();
  private readonly attemptKeySecret = crypto.randomBytes(32);
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly idleMs: number) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60 * 1000);
    this.cleanupTimer.unref();
  }

  create(user: UserRow, dataKey: Buffer) {
    const token = crypto.randomBytes(32).toString("base64url");
    const csrfToken = crypto.randomBytes(32).toString("base64url");
    const sessionKey = Buffer.from(dataKey);
    dataKey.fill(0);
    this.sessions.set(token, {
      userId: user.id,
      dataKey: sessionKey,
      csrfToken,
      lastActivity: Date.now()
    });
    return { token, csrfToken };
  }

  get(request: Request, touch = true): Session | null {
    const token = readCookie(request.headers.get("cookie"), "notes_session");
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

  require(request: Request) {
    const session = this.get(request);
    if (!session) throw new HttpError(401, "Cofre bloqueado.", "locked");
    return session;
  }

  requireCsrf(request: Request, session: Session) {
    const supplied = request.headers.get("x-csrf-token");
    if (!safeEqualText(supplied, session.csrfToken)) {
      throw new HttpError(403, "Token CSRF inválido.", "csrf");
    }
  }

  destroy(token: string) {
    const session = this.sessions.get(token);
    session?.dataKey.fill(0);
    this.sessions.delete(token);
  }

  revokeOthers(userId: string, currentToken: string) {
    for (const [token, session] of this.sessions) {
      if (session.userId === userId && token !== currentToken) this.destroy(token);
    }
  }

  passwordAttemptKey(password: string) {
    return crypto
      .createHmac("sha256", this.attemptKeySecret)
      .update(password.normalize("NFKC"), "utf8")
      .digest("base64url");
  }

  assertLoginAllowed(attemptKey: string) {
    const record = this.loginFailures.get(attemptKey);
    if (!record) return;
    if (Date.now() - record.startedAt >= LOGIN_WINDOW_MS) {
      this.loginFailures.delete(attemptKey);
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

  recordLoginFailure(attemptKey: string) {
    const current = this.loginFailures.get(attemptKey);
    if (!current || Date.now() - current.startedAt >= LOGIN_WINDOW_MS) {
      this.loginFailures.set(attemptKey, { count: 1, startedAt: Date.now() });
    } else {
      current.count += 1;
    }
  }

  clearLoginFailures(attemptKey: string) {
    this.loginFailures.delete(attemptKey);
  }

  private cleanup() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (now - session.lastActivity > this.idleMs) this.destroy(token);
    }
    for (const [attemptKey, record] of this.loginFailures) {
      if (now - record.startedAt >= LOGIN_WINDOW_MS) {
        this.loginFailures.delete(attemptKey);
      }
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
    for (const token of this.sessions.keys()) this.destroy(token);
  }
}

function readCookie(header: string | null, name: string) {
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator === -1) continue;
    if (item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return null;
}
