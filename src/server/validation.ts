import { HttpError } from "./errors";
import type { NotePayload } from "./types";

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const NOTE_JSON_OVERHEAD_BYTES = 64 * 1024;
const DEFAULT_MAX_NOTE_MIB = 50;

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
  if (/data:[^;,\s]+;base64,/i.test(candidate.markdown)) {
    throw new HttpError(
      400,
      "Conteúdo base64 não é permitido no Markdown. Envie o arquivo como anexo."
    );
  }
  const payload = { title, markdown: candidate.markdown };
  const maxNoteMiB = configuredMaxNoteMiB();
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maxNoteMiB * 1024 * 1024) {
    throw new HttpError(
      413,
      `A nota excede o limite de ${maxNoteMiB} MiB. Adicione imagens e arquivos como anexos.`
    );
  }
  return payload;
}

export function configuredMaxNoteMiB() {
  const configured = process.env.NOTES_MAX_NOTE_MB;
  if (configured === undefined || configured.trim() === "") {
    return DEFAULT_MAX_NOTE_MIB;
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new Error("NOTES_MAX_NOTE_MB deve ser um inteiro entre 1 e 50.");
  }
  return value;
}

export function configuredMaxNoteRequestBytes() {
  return configuredMaxNoteMiB() * 1024 * 1024 + NOTE_JSON_OVERHEAD_BYTES;
}

export function validateParentId(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value)) {
    throw new HttpError(400, "Página pai inválida.");
  }
  return value;
}

export function validateAttachment(file: File) {
  if (file.size < 1) throw new HttpError(400, "O arquivo está vazio.");
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new HttpError(413, "O arquivo excede o limite de 50 MiB.");
  }

  const sourceName = file.name.normalize("NFKC").split(/[\\/]/).pop()?.trim() ?? "";
  const name = sourceName.replace(/[\u0000-\u001f\u007f]/g, "");
  if (!name || name.length > 255) {
    throw new HttpError(400, "Nome de arquivo inválido.");
  }

  const suppliedType = file.type.trim().toLowerCase();
  const mimeType = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(
    suppliedType
  )
    ? suppliedType
    : "application/octet-stream";
  return { name, mimeType, size: file.size };
}
