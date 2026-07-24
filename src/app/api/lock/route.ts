import { api, clearSessionCookie, json } from "@/server/api";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return api(async () => {
    const runtime = getRuntime();
    const session = runtime.sessions.require(request);
    runtime.sessions.requireCsrf(request, session);
    runtime.sessions.destroy(session.token);
    const response = json({ ok: true });
    clearSessionCookie(response, runtime.secureCookies);
    return response;
  });
}
