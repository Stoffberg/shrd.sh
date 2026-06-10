const genericBinaryContentTypes = new Set([
  "",
  "application/binary",
  "application/octet-stream",
])

const extensionContentTypes = new Map([
  ["aac", "audio/aac"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["cur", "image/x-icon"],
  ["flac", "audio/flac"],
  ["gif", "image/gif"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
  ["ico", "image/x-icon"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["m4a", "audio/mp4"],
  ["m4v", "video/mp4"],
  ["mov", "video/quicktime"],
  ["mp3", "audio/mpeg"],
  ["mp4", "video/mp4"],
  ["oga", "audio/ogg"],
  ["ogg", "audio/ogg"],
  ["ogv", "video/ogg"],
  ["opus", "audio/opus"],
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["tif", "image/tiff"],
  ["tiff", "image/tiff"],
  ["wav", "audio/wav"],
  ["weba", "audio/webm"],
  ["webm", "video/webm"],
  ["webp", "image/webp"],
])

function normalizeContentType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

function normalizeFilename(filename?: string): string | null {
  if (!filename) {
    return null
  }

  const normalized = filename.split(/[\\/]/).pop()?.trim() ?? ""
  return normalized || null
}

function getFilenameExtension(filename?: string): string | null {
  const normalized = normalizeFilename(filename)?.toLowerCase()
  if (!normalized) {
    return null
  }

  const lastDot = normalized.lastIndexOf(".")
  if (lastDot === -1 || lastDot === normalized.length - 1) {
    return null
  }

  return normalized.slice(lastDot + 1)
}

function inferContentTypeFromFilename(filename?: string): string | null {
  const extension = getFilenameExtension(filename)
  if (!extension) {
    return null
  }

  return extensionContentTypes.get(extension) ?? null
}

function asciiFilename(filename: string): string {
  const normalized = filename
    .replace(/[\\/\r\n"]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .trim()
  return normalized || "download"
}

export function getServedContentType(contentType: string, filename?: string): string {
  const normalizedContentType = normalizeContentType(contentType)
  if (!genericBinaryContentTypes.has(normalizedContentType)) {
    return contentType
  }

  return inferContentTypeFromFilename(filename) ?? contentType
}

export function getDownloadFilename(id: string, filename?: string | null, name?: string | null): string {
  return normalizeFilename(filename ?? undefined) ?? normalizeFilename(name ?? undefined) ?? id
}

export function getContentDisposition(id: string, filename?: string | null, name?: string | null): string {
  const downloadName = getDownloadFilename(id, filename, name)
  const fallback = asciiFilename(downloadName)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
}
