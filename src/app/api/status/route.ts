import { api, json } from "@/server/api";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return api(async () => {
    const { sessions, idleTimeoutMs } = getRuntime();
    const session = sessions.get(request);
    return json({
      authenticated: Boolean(session),
      idleTimeoutMs,
      ...(session
        ? {
            csrfToken: session.csrfToken,
            user: { username: session.username }
          }
        : {})
    });
  });
}
