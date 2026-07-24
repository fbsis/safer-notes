import { api, json } from "@/server/api";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return api(async () => {
    const { vault, sessions } = getRuntime();
    const session = sessions.get(request);
    return json({
      bootstrapRequired: vault.userCount() === 0,
      authenticated: Boolean(session),
      ...(session
        ? {
            csrfToken: session.csrfToken,
            user: { username: session.username, role: session.role }
          }
        : {})
    });
  });
}
