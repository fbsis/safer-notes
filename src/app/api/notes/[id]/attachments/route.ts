import { api, json } from "@/server/api";
import { publicAttachment } from "@/server/attachments";
import { HttpError } from "@/server/errors";
import { getRuntime } from "@/server/runtime";
import { MAX_ATTACHMENT_BYTES, validateAttachment } from "@/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

function validateId(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "Nota não encontrada.");
}

export function GET(request: Request, context: Context) {
  return api(async () => {
    const { id } = await context.params;
    validateId(id);
    const { vault, sessions } = getRuntime();
    const session = sessions.require(request);
    return json({
      attachments: vault
        .listAttachments(session.userId, session.dataKey, id)
        .map(publicAttachment)
    });
  });
}

export function POST(request: Request, context: Context) {
  return api(async () => {
    const { id } = await context.params;
    validateId(id);
    const { vault, sessions } = getRuntime();
    const session = sessions.require(request);
    sessions.requireCsrf(request, session);

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_ATTACHMENT_BYTES + 1024 * 1024) {
      throw new HttpError(413, "Requisição de anexo muito grande.");
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
      throw new HttpError(415, "Envie o anexo como multipart/form-data.");
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "Arquivo não informado.");
    const metadata = validateAttachment(file);
    const attachment = vault.createAttachment(
      session.userId,
      session.dataKey,
      id,
      metadata,
      new Uint8Array(await file.arrayBuffer())
    );
    return json({ attachment: publicAttachment(attachment) }, 201);
  });
}
