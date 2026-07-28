export function readDraggedUrl(dataTransfer) {
  const uriList = dataTransfer.getData("text/uri-list");
  const candidate = uriList
    .split(/\r?\n/)
    .find((line) => line.trim() && !line.trim().startsWith("#"))
    || dataTransfer.getData("text/plain").trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function readClipboardFiles(clipboardData) {
  return Array.from(clipboardData?.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

const extensionByMimeType = {
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "text/plain": "txt"
};

export async function base64DataUrlToFile(value, sequence = 1) {
  if (typeof value !== "string") {
    throw new Error("Arquivo base64 inválido.");
  }
  const match = /^data:([a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*);base64,/i.exec(
    value
  );
  if (!match) {
    throw new Error("O arquivo base64 usa um formato inválido.");
  }
  const mimeType = match[1].toLowerCase();
  const response = await fetch(value);
  const blob = await response.blob();
  if (blob.size < 1 || blob.size > 50 * 1024 * 1024) {
    throw new Error("O arquivo base64 precisa ter no máximo 50 MiB.");
  }
  const extension = extensionByMimeType[mimeType] || "bin";
  return new File(
    [blob],
    `arquivo-colado-${Date.now()}-${sequence}.${extension}`,
    { type: mimeType }
  );
}
