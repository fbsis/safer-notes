import { api, json, readJson, setSessionCookie } from "@/server/api";
import { getRuntime } from "@/server/runtime";
import { validatePassword } from "@/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return api(async () => {
    const runtime = getRuntime();
    const body = await readJson(request);
    validatePassword(body.password);
    const created = await runtime.vault.register(body.password);
    const session = runtime.sessions.create(created.user, created.dataKey);
    const response = json({ csrfToken: session.csrfToken }, 201);
    setSessionCookie(response, session.token, runtime.secureCookies);
    return response;
  });
}
