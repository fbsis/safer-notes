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
