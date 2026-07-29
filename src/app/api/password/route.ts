import { api, json, readJson } from "@/server/api";
import { getRuntime } from "@/server/runtime";
import { validatePassword } from "@/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return api(async () => {
    const runtime = getRuntime();
    const session = runtime.sessions.require(request);
    runtime.sessions.requireCsrf(request, session);
    const body = await readJson(request);
    validatePassword(body.currentPassword);
    validatePassword(body.newPassword);
    await runtime.vault.changePassword(
      session.userId,
      body.currentPassword,
      body.newPassword
    );
    runtime.sessions.revokeOthers(session.userId, session.token);
    return json({ ok: true });
  });
}
