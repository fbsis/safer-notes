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
    validatePassword(body.password);
    const legacyUsername = body.username === undefined
      ? undefined
      : normalizeUsername(body.username);
    const attemptKey = runtime.sessions.passwordAttemptKey(body.password);
    runtime.sessions.assertLoginAllowed(attemptKey);

    let authenticated;
    try {
      authenticated = await runtime.vault.authenticate(body.password, legacyUsername);
    } catch (error) {
      if (error instanceof HttpError && error.code === "ambiguous_password") {
        throw error;
      }
      runtime.sessions.recordLoginFailure(attemptKey);
      throw new HttpError(401, "Senha inválida.", "invalid_credentials");
    }

    runtime.sessions.clearLoginFailures(attemptKey);
    const session = runtime.sessions.create(
      authenticated.user,
      authenticated.dataKey
    );
    const response = json({
      csrfToken: session.csrfToken
    });
    setSessionCookie(response, session.token, runtime.secureCookies);
    return response;
  });
}
