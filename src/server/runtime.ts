import fs from "node:fs";
import path from "node:path";
import { SCRYPT_PARAMS, type ScryptParameters } from "./crypto";
import { SessionManager } from "./sessions";
import { Vault } from "./vault";

const SESSION_IDLE_MS = 15 * 60 * 1000;

interface Runtime {
  vault: Vault;
  sessions: SessionManager;
  setupToken: string;
  secureCookies: boolean;
}

declare global {
  var notesRuntime: Runtime | undefined;
}

export function getRuntime(options?: {
  databasePath?: string;
  setupToken?: string;
  sessionIdleMs?: number;
  kdfParameters?: ScryptParameters;
}) {
  if (options || !globalThis.notesRuntime) {
    const runtime = createRuntime(options);
    if (!options) globalThis.notesRuntime = runtime;
    return runtime;
  }
  return globalThis.notesRuntime;
}

function createRuntime(options?: {
  databasePath?: string;
  setupToken?: string;
  sessionIdleMs?: number;
  kdfParameters?: ScryptParameters;
}): Runtime {
  const databasePath =
    options?.databasePath ??
    process.env.NOTES_DB ??
    path.join(process.cwd(), "data", "notes.sqlite");
  return {
    vault: new Vault(databasePath, options?.kdfParameters ?? SCRYPT_PARAMS),
    sessions: new SessionManager(options?.sessionIdleMs ?? SESSION_IDLE_MS),
    setupToken:
      options?.setupToken ??
      loadSecret("NOTES_ADMIN_SETUP_TOKEN_FILE", "NOTES_ADMIN_SETUP_TOKEN"),
    secureCookies: process.env.NOTES_HTTPS === "1"
  };
}

function loadSecret(fileVariable: string, valueVariable: string) {
  const filename = process.env[fileVariable];
  if (filename) return fs.readFileSync(filename, "utf8").trim();
  return (process.env[valueVariable] ?? "").trim();
}
