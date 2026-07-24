import { api, json, readJson, setSessionCookie } from "@/server/api";
import { HttpError } from "@/server/errors";
import { getRuntime } from "@/server/runtime";
import { normalizeUsername, validatePassword } from "@/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return api(async () => {
    const runtime = getRuntime();
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    validatePassword(body.password);
    runtime.sessions.assertLoginAllowed(username);

    let authenticated;
    try {
      authenticated = await runtime.vault.authenticate(username, body.password);
    } catch {
      runtime.sessions.recordLoginFailure(username);
      throw new HttpError(401, "Usuário ou senha inválidos.", "invalid_credentials");
    }

    runtime.sessions.clearLoginFailures(username);
    const session = runtime.sessions.create(
      authenticated.user,
      authenticated.dataKey
    );
    const response = json({
      csrfToken: session.csrfToken,
      user: session.user
    });
    setSessionCookie(response, session.token, runtime.secureCookies);
    return response;
  });
}
