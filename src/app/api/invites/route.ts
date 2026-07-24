import { api, json } from "@/server/api";
import { HttpError } from "@/server/errors";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return api(async () => {
    const { vault, sessions } = getRuntime();
    const session = sessions.require(request);
    if (session.role !== "admin") throw new HttpError(403, "Acesso negado.");
    return json({ invites: vault.listInvites(session.userId) });
  });
}

export function POST(request: Request) {
  return api(async () => {
    const { vault, sessions } = getRuntime();
    const session = sessions.require(request);
    sessions.requireCsrf(request, session);
    if (session.role !== "admin") throw new HttpError(403, "Acesso negado.");
    return json(vault.createInvite(session.userId), 201);
  });
}
