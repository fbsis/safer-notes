import { api, json, readJson, setSessionCookie } from "@/server/api";
import { HttpError } from "@/server/errors";
import { getRuntime } from "@/server/runtime";
import { normalizeUsername, validatePassword } from "@/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return api(async () => {
    const runtime = getRuntime();
    if (runtime.vault.userCount() === 0) {
      throw new HttpError(409, "Configure o administrador.");
    }
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    validatePassword(body.password);
    if (typeof body.inviteToken !== "string" || body.inviteToken.length < 32) {
      throw new HttpError(400, "Convite inválido.");
    }
    const created = await runtime.vault.register(
      body.inviteToken,
      username,
      body.password
    );
    const session = runtime.sessions.create(created.user, created.dataKey);
    const response = json(
      { csrfToken: session.csrfToken, user: session.user },
      201
    );
    setSessionCookie(response, session.token, runtime.secureCookies);
    return response;
  });
}
