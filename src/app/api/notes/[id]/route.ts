import { api, json, readJson } from "@/server/api";
import { HttpError } from "@/server/errors";
import { getRuntime } from "@/server/runtime";
import { validateNotePayload } from "@/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

export function PATCH(request: Request, context: Context) {
  return api(async () => {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "Nota não encontrada.");
    const { vault, sessions } = getRuntime();
    const session = sessions.require(request);
    sessions.requireCsrf(request, session);
    const body = await readJson(request);
    const payload = validateNotePayload(body);
    if (!Number.isInteger(body.revision) || Number(body.revision) < 1) {
      throw new HttpError(400, "Revisão inválida.");
    }
    return json({
      note: vault.updateNote(
        session.userId,
        session.dataKey,
        id,
        Number(body.revision),
        payload
      )
    });
  });
}

export function DELETE(request: Request, context: Context) {
  return api(async () => {
    const { id } = await context.params;
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "Nota não encontrada.");
    const { vault, sessions } = getRuntime();
    const session = sessions.require(request);
    sessions.requireCsrf(request, session);
    vault.deleteNote(session.userId, id);
    return new Response(null, { status: 204 });
  });
}
