import { HttpError } from "./errors";
import type { NotePayload } from "./types";

export function normalizeUsername(username: unknown) {
  if (typeof username !== "string") throw new HttpError(400, "Usuário inválido.");
  const normalized = username.trim().normalize("NFKC").toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/.test(normalized)) {
    throw new HttpError(
      400,
      "Use de 3 a 64 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado."
    );
  }
  return normalized;
}

export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    throw new HttpError(400, "A senha precisa ter entre 12 e 1024 caracteres.");
  }
}

export function validateNotePayload(input: unknown): NotePayload {
  if (!input || typeof input !== "object") throw new HttpError(400, "Nota inválida.");
  const candidate = input as Record<string, unknown>;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  if (!title || title.length > 200) {
    throw new HttpError(400, "O título precisa ter entre 1 e 200 caracteres.");
  }
  if (typeof candidate.markdown !== "string") {
    throw new HttpError(400, "Conteúdo Markdown inválido.");
  }
  const payload = { title, markdown: candidate.markdown };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 900 * 1024) {
    throw new HttpError(413, "A nota excede o limite permitido.");
  }
  return payload;
}
