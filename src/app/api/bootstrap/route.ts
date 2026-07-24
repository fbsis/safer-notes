import { api, json, readJson, setSessionCookie } from "@/server/api";
import { safeEqualText } from "@/server/crypto";
import { HttpError } from "@/server/errors";
import { getRuntime } from "@/server/runtime";
import { normalizeUsername, validatePassword } from "@/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return api(async () => {
    const runtime = getRuntime();
    if (runtime.vault.userCount() !== 0) throw new HttpError(404, "Rota indisponível.");
    if (!runtime.setupToken) {
      throw new HttpError(503, "Token de configuração não definido.");
    }
    const body = await readJson(request);
    if (!safeEqualText(body.setupToken, runtime.setupToken)) {
      throw new HttpError(403, "Token de configuração inválido.");
    }
    const username = normalizeUsername(body.username);
    validatePassword(body.password);
    const created = await runtime.vault.bootstrap(username, body.password);
    const session = runtime.sessions.create(created.user, created.dataKey);
    const response = json(
      { csrfToken: session.csrfToken, user: session.user },
      201
    );
    setSessionCookie(response, session.token, runtime.secureCookies);
    return response;
  });
}
