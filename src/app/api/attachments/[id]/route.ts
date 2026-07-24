import { api } from "@/server/api";
import { contentDisposition, isInlineImage } from "@/server/attachments";
import { HttpError } from "@/server/errors";
import { getRuntime } from "@/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

function validateId(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "Anexo não encontrado.");
}

export function GET(request: Request, context: Context) {
  return api(async () => {
    const { id } = await context.params;
    validateId(id);
    const { vault, sessions } = getRuntime();
    const session = sessions.require(request);
    const attachment = vault.getAttachment(session.userId, session.dataKey, id);
    const inline = isInlineImage(attachment.mimeType);
    return new Response(new Uint8Array(attachment.data), {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": contentDisposition(attachment.name, inline),
        "Content-Length": String(attachment.size),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Type": inline ? attachment.mimeType : "application/octet-stream",
        "X-Content-Type-Options": "nosniff"
      }
    });
  });
}

export function DELETE(request: Request, context: Context) {
  return api(async () => {
    const { id } = await context.params;
    validateId(id);
    const { vault, sessions } = getRuntime();
    const session = sessions.require(request);
    sessions.requireCsrf(request, session);
    vault.deleteAttachment(session.userId, id);
    return new Response(null, { status: 204 });
  });
}
