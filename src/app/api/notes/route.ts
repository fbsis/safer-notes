import { api, json, readJson } from "@/server/api";
import { getRuntime } from "@/server/runtime";
import { validateNotePayload } from "@/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return api(async () => {
    const { vault, sessions } = getRuntime();
    const session = sessions.require(request);
    return json({ notes: vault.listNotes(session.userId, session.dataKey) });
  });
}

export function POST(request: Request) {
  return api(async () => {
    const { vault, sessions } = getRuntime();
    const session = sessions.require(request);
    sessions.requireCsrf(request, session);
    const payload = validateNotePayload(await readJson(request));
    return json(
      { note: vault.createNote(session.userId, session.dataKey, payload) },
      201
    );
  });
}
