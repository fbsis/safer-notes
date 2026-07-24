import type { AttachmentMetadata } from "./types";

const INLINE_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export function isInlineImage(mimeType: string) {
  return INLINE_IMAGE_TYPES.has(mimeType);
}

export function publicAttachment(
  attachment: AttachmentMetadata & {
    id: string;
    noteId: string;
    createdAt: string;
  }
) {
  const image = isInlineImage(attachment.mimeType);
  return {
    id: attachment.id,
    noteId: attachment.noteId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    createdAt: attachment.createdAt,
    isImage: image,
    url: `/api/attachments/${attachment.id}${image ? "" : "?download=1"}`
  };
}

export function contentDisposition(name: string, inline: boolean) {
  const fallback = name
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 150) || "attachment";
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
