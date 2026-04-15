import type { ContentMetadata } from "./types"
import { GEIST_MONO_WOFF2_URL, GEIST_SANS_WOFF2_URL, getGeistFontFaceCss } from "../../../packages/shared/src/fonts"

type PreviewKind = "text" | "image" | "video" | "audio" | "pdf" | "download"

const textContentTypes = new Set([
  "application/ecmascript",
  "application/graphql",
  "application/graphql-response+json",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/manifest+json",
  "application/ndjson",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-csh",
  "application/x-httpd-php",
  "application/x-java-source",
  "application/x-lua",
  "application/x-ndjson",
  "application/x-perl",
  "application/x-python",
  "application/x-ruby",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-typescript",
  "application/x-www-form-urlencoded",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
])

const archiveContentTypes = new Set([
  "application/gzip",
  "application/java-archive",
  "application/vnd.android.package-archive",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-apple-diskimage",
  "application/x-binary",
  "application/x-bzip",
  "application/x-bzip2",
  "application/x-gzip",
  "application/x-rar-compressed",
  "application/x-tar",
  "application/zip",
  "binary/octet-stream",
])

const genericBinaryContentTypes = new Set([
  "",
  "application/binary",
  "application/octet-stream",
])

const textContentTypeSuffixes = ["+json", "+xml", "+yaml", "+toml"]

const textExtensions = new Set([
  "c",
  "cc",
  "cfg",
  "clj",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "cxx",
  "env",
  "gitignore",
  "go",
  "graphql",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "json5",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "log",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mts",
  "php",
  "pl",
  "properties",
  "py",
  "r",
  "rb",
  "rs",
  "sass",
  "scala",
  "scss",
  "sh",
  "sql",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
  "zsh",
])

const textFilenames = new Set([
  ".editorconfig",
  ".env",
  ".gitignore",
  ".npmrc",
  "brewfile",
  "dockerfile",
  "gemfile",
  "justfile",
  "makefile",
  "procfile",
  "rakefile",
])

const imageExtensions = new Set([
  "avif",
  "bmp",
  "cur",
  "gif",
  "heic",
  "heif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
])

const videoExtensions = new Set([
  "m4v",
  "mov",
  "mp4",
  "ogv",
  "webm",
])

const audioExtensions = new Set([
  "aac",
  "flac",
  "m4a",
  "mp3",
  "oga",
  "ogg",
  "opus",
  "wav",
  "weba",
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function getDecryptionScript(): string {
  return `
    async function decryptContent(ciphertext, keyB64) {
      const keyBytes = Uint8Array.from(atob(keyB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
      const nonce = ciphertext.slice(0, 12);
      const encrypted = ciphertext.slice(12);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, encrypted);
      return decrypted;
    }

    function base64ToBytes(base64) {
      const text = new TextDecoder().decode(base64);
      const binary = atob(text);
      return Uint8Array.from(binary, c => c.charCodeAt(0));
    }

    function getKeyFromHash() {
      const hash = window.location.hash.slice(1);
      if (!hash) return null;
      if (hash.startsWith('key=')) return hash.slice(4);
      return hash;
    }

    function showError(message) {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('error').style.display = 'block';
      document.getElementById('error-message').textContent = message;
    }
  `;
}

function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? ""
}

function normalizeFilename(filename?: string): string | null {
  if (!filename) {
    return null
  }

  const normalized = filename.split(/[\\/]/).pop()?.trim().toLowerCase() ?? ""
  return normalized || null
}

function getFilenameExtension(filename?: string): string | null {
  const normalized = normalizeFilename(filename)
  if (!normalized) {
    return null
  }

  const dotIndex = normalized.lastIndexOf(".")
  if (dotIndex <= 0 || dotIndex === normalized.length - 1) {
    return null
  }

  return normalized.slice(dotIndex + 1)
}

function isTextLikeContentType(contentType: string): boolean {
  if (contentType.startsWith("text/")) {
    return true
  }

  if (textContentTypes.has(contentType)) {
    return true
  }

  return textContentTypeSuffixes.some((suffix) => contentType.endsWith(suffix))
}

function getFilenamePreviewKind(filename?: string): PreviewKind | null {
  const normalized = normalizeFilename(filename)
  if (!normalized) {
    return null
  }

  if (textFilenames.has(normalized)) {
    return "text"
  }

  const extension = getFilenameExtension(normalized)
  if (!extension) {
    return null
  }

  if (imageExtensions.has(extension)) {
    return "image"
  }

  if (videoExtensions.has(extension)) {
    return "video"
  }

  if (audioExtensions.has(extension)) {
    return "audio"
  }

  if (extension === "pdf") {
    return "pdf"
  }

  if (textExtensions.has(extension)) {
    return "text"
  }

  return null
}

function inferContentTypeFromFilename(filename?: string): string | null {
  const extension = getFilenameExtension(filename)
  if (!extension) {
    return null
  }

  return extensionContentTypes.get(extension) ?? null
}

function getPreviewKind(contentType: string, filename?: string): PreviewKind {
  const normalizedContentType = normalizeContentType(contentType)

  if (normalizedContentType.startsWith("image/")) {
    return "image"
  }

  if (normalizedContentType.startsWith("video/")) {
    return "video"
  }

  if (normalizedContentType.startsWith("audio/")) {
    return "audio"
  }

  if (normalizedContentType === "application/pdf") {
    return "pdf"
  }

  if (archiveContentTypes.has(normalizedContentType)) {
    return "download"
  }

  if (isTextLikeContentType(normalizedContentType)) {
    return "text"
  }

  const filenamePreviewKind = getFilenamePreviewKind(filename)
  if (filenamePreviewKind) {
    return filenamePreviewKind
  }

  if (genericBinaryContentTypes.has(normalizedContentType)) {
    return "download"
  }

  return "download"
}

export function getServedContentType(contentType: string, filename?: string): string {
  const normalizedContentType = normalizeContentType(contentType)
  if (!genericBinaryContentTypes.has(normalizedContentType)) {
    return contentType
  }

  return inferContentTypeFromFilename(filename) ?? contentType
}

function renderDownloadBox(action: string, details: string): string {
  return `<div class="download-box">${action}<p class="file-info">${details}</p></div>`
}

function renderBinaryPreview(metadata: ContentMetadata, rawUrl: string): string {
  const previewKind = getPreviewKind(metadata.contentType, metadata.filename)
  const filename = escapeHtml(metadata.filename || metadata.id)
  const servedContentType = getServedContentType(metadata.contentType, metadata.filename)

  if (previewKind === "image") {
    return `<img src="${rawUrl}" class="media" alt="${filename}">`
  }

  if (previewKind === "video") {
    return `<video controls autoplay class="media"><source src="${rawUrl}" type="${servedContentType}">Your browser does not support video.</video>`
  }

  if (previewKind === "audio") {
    return `<audio controls class="media"><source src="${rawUrl}" type="${servedContentType}">Your browser does not support audio.</audio>`
  }

  if (previewKind === "pdf") {
    return `<iframe src="${rawUrl}" class="media pdf"></iframe>`
  }

  return renderDownloadBox(
    `<a href="${rawUrl}" download="${filename}" class="download-btn">${iconDownload()} Download File</a>`,
    `${filename} &middot; ${formatSize(metadata.size)}`
  )
}

function renderEncryptedBinaryPreview(previewKind: PreviewKind, size: number): string {
  if (previewKind === "image") {
    return `document.getElementById('content').innerHTML = '<img src="' + blobUrl + '" class="media" alt="' + escapedFilename + '">';`
  }

  if (previewKind === "video") {
    return `document.getElementById('content').innerHTML = '<video controls autoplay class="media"><source src="' + blobUrl + '" type="' + contentType + '"></video>';`
  }

  if (previewKind === "audio") {
    return `document.getElementById('content').innerHTML = '<audio controls class="media"><source src="' + blobUrl + '" type="' + contentType + '"></audio>';`
  }

  if (previewKind === "pdf") {
    return `document.getElementById('content').innerHTML = '<iframe src="' + blobUrl + '" class="media pdf"></iframe>';`
  }

  return `document.getElementById('content').innerHTML = '<div class="download-box"><button onclick="downloadFile()" class="download-btn">${iconDownload()} Download File</button><p class="file-info">' + escapedFilename + ' &middot; ${formatSize(size)}</p></div>';`
}

export function isBinaryContent(contentType: string, filename?: string): boolean {
  return getPreviewKind(contentType, filename) !== "text"
}

function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

function generateFavicon(id: string): string {
  const h1 = hashStr(id) % 360
  const h2 = hashStr(id.split("").reverse().join("")) % 360
  const s1 = 50 + (hashStr(id + "a") % 25)
  const s2 = 50 + (hashStr(id + "b") % 25)
  const l1 = 40 + (hashStr(id + "c") % 18)
  const l2 = 40 + (hashStr(id + "d") % 18)
  const c1 = `hsl(${h1},${s1}%,${l1}%)`
  const c2 = `hsl(${h2},${s2}%,${l2}%)`
  const r = 6

  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><linearGradient id='g' x1='0' y1='0' x2='32' y2='32' gradientUnits='userSpaceOnUse'><stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs><rect width='32' height='32' rx='${r}' ry='${r}' fill='url(%23g)'/></svg>`

  return `data:image/svg+xml,${svg.replace(/</g, "%3C").replace(/>/g, "%3E")}`
}

function faviconLink(id: string): string {
  return `<link rel="icon" type="image/svg+xml" href="${generateFavicon(id)}">`
}

function fonts(): string {
  return `<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
  <link rel="preload" href="${GEIST_SANS_WOFF2_URL}" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="${GEIST_MONO_WOFF2_URL}" as="font" type="font/woff2" crossorigin>
  <style>${getGeistFontFaceCss()}</style>`
}

function baseStyles(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { color-scheme: dark; }
    body {
      font-family: 'Geist', system-ui, -apple-system, sans-serif;
      background: #09090b;
      color: #e4e4e7;
      min-height: 100vh;
      padding: 0;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      position: relative;
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      opacity: 0.03;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
      background-repeat: repeat;
      background-size: 256px 256px;
    }
    body > * { position: relative; z-index: 1; }
    ::selection { background: rgba(34,211,238,0.2); }
    .wrap {
      max-width: 72rem;
      margin: 0 auto;
      padding: 1.5rem 1.25rem;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }
    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      min-width: 0;
    }
    .toolbar-right {
      display: flex;
      align-items: center;
      gap: 0.375rem;
    }
    .toolbar h1 {
      font-family: 'Geist Mono', ui-monospace, monospace;
      font-size: 0.875rem;
      font-weight: 500;
      color: #e4e4e7;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 500px;
    }
    .toolbar-tag {
      font-family: 'Geist Mono', ui-monospace, monospace;
      font-size: 0.6875rem;
      color: #71717a;
      background: #16161a;
      border: 1px solid #161619;
      border-radius: 4px;
      padding: 0.125rem 0.5rem;
    }
    .toolbar-stat {
      font-family: 'Geist Mono', ui-monospace, monospace;
      font-size: 0.6875rem;
      color: #52525b;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      font-family: 'Geist Mono', ui-monospace, monospace;
      font-size: 0.6875rem;
      color: #a1a1aa;
      background: #0f0f12;
      border: 1px solid #1e1e24;
      border-radius: 6px;
      padding: 0.375rem 0.625rem;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .btn:hover { border-color: #52525b; color: #e4e4e7; background: #16161a; }
    .btn:active { transform: scale(0.97); }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn svg { width: 12px; height: 12px; }
    .btn.confirmed {
      border-color: rgba(34,197,94,0.4);
      color: #22c55e;
      background: rgba(34,197,94,0.08);
      pointer-events: none;
    }
    .meta-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 1rem;
      font-family: 'Geist Mono', ui-monospace, monospace;
      font-size: 0.6875rem;
      color: #52525b;
      margin-bottom: 0.75rem;
    }
    .meta-bar .tag {
      border: 1px solid #1e1e24;
      background: #16161a;
      border-radius: 999px;
      padding: 0.125rem 0.5rem;
      color: #a1a1aa;
    }
    .meta-bar .amber { color: #f59e0b; }
    .warning {
      background: rgba(245,158,11,0.08);
      border: 1px solid rgba(245,158,11,0.2);
      color: #f59e0b;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      margin-bottom: 0.75rem;
      font-family: 'Geist Mono', ui-monospace, monospace;
      font-size: 0.6875rem;
    }
    .warning.last {
      background: rgba(239,68,68,0.08);
      border-color: rgba(239,68,68,0.2);
      color: #ef4444;
    }
    .content-box {
      background: #0f0f12;
      border: 1px solid #1e1e24;
      border-radius: 8px;
      overflow: hidden;
    }
    .content-box pre {
      font-family: 'Geist Mono', ui-monospace, monospace;
      font-size: 13px;
      line-height: 1.7;
      white-space: pre-wrap;
      word-break: break-word;
      padding: 1.25rem;
      color: #d4d4d8;
    }
    .content-box.markdown {
      padding: 1.25rem;
      line-height: 1.7;
      color: #d4d4d8;
    }
    .content-box.markdown h1, .content-box.markdown h2, .content-box.markdown h3 {
      margin-top: 1.5rem;
      margin-bottom: 0.75rem;
      color: #e4e4e7;
    }
    .content-box.markdown h1:first-child, .content-box.markdown h2:first-child {
      margin-top: 0;
    }
    .content-box.markdown p { margin-bottom: 1rem; }
    .content-box.markdown code {
      font-family: 'Geist Mono', ui-monospace, monospace;
      background: #16161a;
      padding: 0.15rem 0.35rem;
      border-radius: 4px;
      font-size: 0.875em;
    }
    .content-box.markdown pre {
      background: #09090b;
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1rem 0;
    }
    .content-box.markdown pre code {
      background: none;
      padding: 0;
    }
    .content-box.markdown ul, .content-box.markdown ol {
      margin-left: 1.5rem;
      margin-bottom: 1rem;
    }
    .content-box.markdown a { color: #22d3ee; }
    .media {
      max-width: 100%;
      max-height: 80vh;
      border-radius: 8px;
      background: #0f0f12;
    }
    .media.pdf {
      width: 100%;
      height: 80vh;
      border: 1px solid #1e1e24;
    }
    video, audio { width: 100%; }
    .download-box {
      background: #0f0f12;
      border: 1px solid #1e1e24;
      border-radius: 8px;
      padding: 3rem;
      text-align: center;
    }
    .download-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-family: 'Geist Mono', ui-monospace, monospace;
      background: #22d3ee;
      color: #09090b;
      padding: 0.75rem 1.5rem;
      border-radius: 6px;
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      margin-bottom: 0.75rem;
      cursor: pointer;
      border: none;
      transition: background 0.15s;
    }
    .download-btn:hover { background: #67e8f9; }
    .download-btn:disabled { background: #16161a; color: #52525b; cursor: not-allowed; }
    .file-info {
      font-family: 'Geist Mono', ui-monospace, monospace;
      font-size: 0.75rem;
      color: #52525b;
    }
    .kbd-bar {
      margin-top: 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      font-family: 'Geist Mono', ui-monospace, monospace;
      font-size: 0.6875rem;
      color: #3f3f46;
    }
    .kbd-bar kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.25rem;
      height: 1.25rem;
      border: 1px solid #1e1e24;
      border-radius: 4px;
      background: #0f0f12;
      font-size: 0.625rem;
      color: #52525b;
      margin-right: 0.25rem;
    }
    .error-box {
      background: rgba(239,68,68,0.06);
      border: 1px solid rgba(239,68,68,0.15);
      border-radius: 8px;
      padding: 3rem;
      text-align: center;
    }
    .error-box h2 {
      font-family: 'Geist Mono', ui-monospace, monospace;
      color: #ef4444;
      font-size: 1rem;
      margin-bottom: 0.75rem;
    }
    .error-box p {
      font-size: 0.875rem;
      color: #71717a;
    }
    .loading-box {
      background: #0f0f12;
      border: 1px solid #1e1e24;
      border-radius: 8px;
      padding: 3rem;
      text-align: center;
    }
    .loading-box p {
      font-family: 'Geist Mono', ui-monospace, monospace;
      font-size: 0.75rem;
      color: #52525b;
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid #1e1e24;
      border-top-color: #22d3ee;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 0 auto 0.75rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { border-radius: 999px; background: rgba(113,113,122,0.3); }
    ::-webkit-scrollbar-thumb:hover { background: rgba(113,113,122,0.5); }
  `
}

function iconCopy(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`
}

function iconDownload(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`
}

function iconRaw(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`
}

function iconCheck(): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
}

function renderMetaBar(metadata: ContentMetadata): string {
  const parts: string[] = []
  if (metadata.views > 0) {
    parts.push(`<span>${metadata.views} ${metadata.views === 1 ? "view" : "views"}</span>`)
  }
  parts.push(`<span>${formatSize(metadata.size)}</span>`)
  if (metadata.expiresAt) {
    const isExpiringSoon = new Date(metadata.expiresAt).getTime() - Date.now() < 3600000
    parts.push(`<span${isExpiringSoon ? ' class="amber"' : ''}>expires ${formatDate(metadata.expiresAt)}</span>`)
  }
  if (metadata.encrypted) parts.push(`<span class="tag">encrypted</span>`)
  if (metadata.maxViews !== undefined) parts.push(`<span class="tag">view once</span>`)
  return `<div class="meta-bar">${parts.join("")}</div>`
}

function renderBurnWarning(isBurn: boolean, viewsLeft: number | null, isLastView: boolean): string {
  if (!isBurn) return ""
  return `<div class="warning${isLastView ? ' last' : ''}">
    ${isLastView
      ? 'This content will be deleted after you leave this page.'
      : `This content will be deleted after ${viewsLeft} more view${viewsLeft === 1 ? '' : 's'}.`}
  </div>`
}

function renderKbdBar(keys: { key: string; label: string }[]): string {
  return `<div class="kbd-bar">${keys.map(k => `<span><kbd>${k.key}</kbd>${k.label}</span>`).join("")}</div>`
}

function confirmBtnScript(): string {
  return `
    var _checkSvg = '${iconCheck()}';
    function confirmBtn(btn, originalHtml) {
      btn.classList.add('confirmed');
      btn.innerHTML = _checkSvg + ' Copied';
      setTimeout(function() {
        btn.classList.remove('confirmed');
        btn.innerHTML = originalHtml;
      }, 1500);
    }
  `
}

function copyUrlScript(): string {
  return `
    function copyUrl(e) {
      var btn = e && e.currentTarget ? e.currentTarget : null;
      navigator.clipboard.writeText(window.location.href);
      if (btn) confirmBtn(btn, btn.dataset.original);
    }
  `
}

function kbdScript(hasContent: boolean): string {
  return `
    document.addEventListener('keydown', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'c') {
        ${hasContent
          ? "var btn = document.getElementById('copy-btn') || document.getElementById('copy-content-btn'); if (typeof copyContent === 'function') copyContent({ currentTarget: btn });"
          : "var btns = document.querySelectorAll('.btn[data-original]'); if (btns[0]) copyUrl({ currentTarget: btns[0] });"}
      }
      if (e.key === 'r' && typeof openRaw === 'function') { openRaw(); }
      if (e.key === 'd' && typeof downloadFile === 'function') { downloadFile(); }
    });
  `
}

export function renderBinaryPage(metadata: ContentMetadata, baseUrl: string): string {
  const isBurn = metadata.maxViews !== undefined
  const viewsLeft = isBurn ? metadata.maxViews! - metadata.views - 1 : null
  const isLastView = viewsLeft === 0
  const rawUrl = `${baseUrl}/${metadata.id}/raw`
  const isEncrypted = metadata.encrypted === true
  const label = metadata.filename ?? metadata.name ?? metadata.id

  if (isEncrypted) {
    return renderEncryptedBinaryPage(metadata, baseUrl, rawUrl, isBurn, viewsLeft, isLastView)
  }

  const copyLinkHtml = `${iconCopy()} Copy Link`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#09090b">
  <title>${escapeHtml(label)} - shrd.sh</title>
  ${faviconLink(metadata.id)}
  ${fonts()}
  <style>${baseStyles()}</style>
</head>
<body>
  <div class="wrap">
    <div class="toolbar">
      <div class="toolbar-left">
        <h1>${escapeHtml(label)}</h1>
        <span class="toolbar-stat">${formatSize(metadata.size)}</span>
      </div>
      <div class="toolbar-right">
        <button class="btn" data-original="${escapeHtml(copyLinkHtml)}" onclick="copyUrl(event)">${copyLinkHtml}</button>
        <a href="${rawUrl}" download class="btn">${iconDownload()} Download</a>
      </div>
    </div>
    ${renderMetaBar(metadata)}
    ${renderBurnWarning(isBurn, viewsLeft, isLastView)}
    ${renderBinaryPreview(metadata, rawUrl)}
  </div>
  <script>
    ${confirmBtnScript()}
    ${copyUrlScript()}
    function downloadFile() { window.location.href = '${rawUrl}'; }
    ${kbdScript(false)}
  </script>
</body>
</html>`
}

function renderEncryptedBinaryPage(
  metadata: ContentMetadata,
  baseUrl: string,
  rawUrl: string,
  isBurn: boolean,
  viewsLeft: number | null,
  isLastView: boolean
): string {
  const contentType = getServedContentType(metadata.contentType, metadata.filename)
  const filename = metadata.filename || metadata.id
  const escapedFilename = escapeHtml(filename)
  const label = metadata.filename ?? metadata.name ?? metadata.id
  const previewKind = getPreviewKind(metadata.contentType, metadata.filename)

  const copyLinkHtml = `${iconCopy()} Copy Link`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#09090b">
  <title>${escapeHtml(label)} - shrd.sh</title>
  ${faviconLink(metadata.id)}
  ${fonts()}
  <style>${baseStyles()}</style>
</head>
<body>
  <div class="wrap">
    <div class="toolbar">
      <div class="toolbar-left">
        <h1>${escapeHtml(label)}</h1>
        <span class="toolbar-tag">encrypted</span>
      </div>
      <div class="toolbar-right">
        <button class="btn" data-original="${escapeHtml(copyLinkHtml)}" onclick="copyUrl(event)">${copyLinkHtml}</button>
        <button class="btn" id="download-header-btn" onclick="downloadFile()" disabled>${iconDownload()} Download</button>
      </div>
    </div>
    ${renderMetaBar(metadata)}
    ${renderBurnWarning(isBurn, viewsLeft, isLastView)}
    <div id="loading" class="loading-box">
      <div class="spinner"></div>
      <p>Decrypting...</p>
    </div>
    <div id="error" class="error-box">
      <h2>Decryption failed</h2>
      <p id="error-message">The decryption key is missing or invalid.</p>
    </div>
    <div id="content"></div>
  </div>
  <script>
    ${getDecryptionScript()}
    ${confirmBtnScript()}
    ${copyUrlScript()}

    var rawUrl = '${rawUrl}';
    var contentType = ${JSON.stringify(contentType)};
    var filename = ${JSON.stringify(filename)};
    var escapedFilename = ${JSON.stringify(escapedFilename)};
    var storageType = '${metadata.storageType}';
    var decryptedBlob = null;

    async function init() {
      var key = getKeyFromHash();
      if (!key) {
        showError('No decryption key found in URL. The key should be in the URL fragment (after #).');
        return;
      }

      try {
        var response = await fetch(rawUrl);
        if (!response.ok) throw new Error('Failed to fetch content');
        var ciphertext = new Uint8Array(await response.arrayBuffer());
        if (storageType === 'kv') {
          ciphertext = base64ToBytes(ciphertext);
        }
        var decrypted = await decryptContent(ciphertext, key);
        decryptedBlob = new Blob([decrypted], { type: contentType });

        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';
        document.getElementById('download-header-btn').disabled = false;

        var blobUrl = URL.createObjectURL(decryptedBlob);
        ${renderEncryptedBinaryPreview(previewKind, metadata.size)}
      } catch (e) {
        showError('Failed to decrypt: ' + (e.message || 'Invalid key or corrupted data'));
      }
    }

    function downloadFile() {
      if (!decryptedBlob) return;
      var url = URL.createObjectURL(decryptedBlob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }

    ${kbdScript(false)}
    init();
  </script>
</body>
</html>`
}

export function renderContentPage(content: string, metadata: ContentMetadata, baseUrl: string): string {
  const isBurn = metadata.maxViews !== undefined
  const viewsLeft = isBurn ? metadata.maxViews! - metadata.views - 1 : null
  const isLastView = viewsLeft === 0
  const rawUrl = `${baseUrl}/${metadata.id}/raw`
  const isEncrypted = metadata.encrypted === true
  const label = metadata.filename ?? metadata.name ?? metadata.id
  const lineCount = content.split("\n").length

  if (isEncrypted) {
    return renderEncryptedContentPage(metadata, baseUrl, rawUrl, isBurn, viewsLeft, isLastView)
  }

  const escaped = escapeHtml(content)

  const copyHtml = `${iconCopy()} Copy`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#09090b">
  <title>${escapeHtml(label)} - shrd.sh</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  ${faviconLink(metadata.id)}
  ${fonts()}
  <style>${baseStyles()}</style>
</head>
<body>
  <div class="wrap">
    <div class="toolbar">
      <div class="toolbar-left">
        <h1>${escapeHtml(label)}</h1>
        <span class="toolbar-stat">${lineCount} ${lineCount === 1 ? "line" : "lines"}</span>
        <span class="toolbar-stat">${formatSize(metadata.size)}</span>
      </div>
      <div class="toolbar-right">
        <button class="btn" id="copy-btn" data-original="${escapeHtml(copyHtml)}" onclick="copyContent(event)">${copyHtml}</button>
        <a href="${rawUrl}" class="btn" onclick="event.preventDefault(); openRaw()">${iconRaw()} Raw</a>
        <button class="btn" onclick="downloadFile()">${iconDownload()} Download</button>
      </div>
    </div>
    ${renderMetaBar(metadata)}
    ${renderBurnWarning(isBurn, viewsLeft, isLastView)}
    <div class="content-box" id="content"><pre>${escaped}</pre></div>
    ${renderKbdBar([{ key: "c", label: "copy" }, { key: "d", label: "download" }, { key: "r", label: "raw" }])}
  </div>
  <script>
    var raw = ${JSON.stringify(content)};
    var contentEl = document.getElementById('content');
    ${confirmBtnScript()}
    ${copyUrlScript()}

    if (looksLikeMarkdown(raw)) {
      contentEl.classList.add('markdown');
      contentEl.innerHTML = marked.parse(raw);
    } else {
      contentEl.innerHTML = '<pre>' + linkify(escapeHtml(raw)) + '</pre>';
    }

    function looksLikeMarkdown(text) {
      return /^#{1,6}\\s|\\*\\*|__|\\[.+\\]\\(|^\\s*[-*+]\\s|^\\s*\\d+\\.\\s|^\`\`\`/m.test(text);
    }

    function escapeHtml(text) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function linkify(text) {
      return text.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:#22d3ee">$1</a>');
    }

    function copyContent(e) {
      navigator.clipboard.writeText(raw);
      var btn = e && e.currentTarget ? e.currentTarget : document.getElementById('copy-btn');
      if (btn) confirmBtn(btn, btn.dataset.original);
    }

    function openRaw() {
      window.open('${rawUrl}', '_blank');
    }

    function downloadFile() {
      var blob = new Blob([raw], { type: 'text/plain' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '${escapeHtml(metadata.filename || metadata.id + ".txt")}';
      a.click();
      URL.revokeObjectURL(url);
    }

    ${kbdScript(true)}
  </script>
</body>
</html>`
}

function renderEncryptedContentPage(
  metadata: ContentMetadata,
  baseUrl: string,
  rawUrl: string,
  isBurn: boolean,
  viewsLeft: number | null,
  isLastView: boolean
): string {
  const label = metadata.filename ?? metadata.name ?? metadata.id

  const copyLinkHtml = `${iconCopy()} Copy Link`
  const copyHtml = `${iconCopy()} Copy`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#09090b">
  <title>${escapeHtml(label)} - shrd.sh</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  ${faviconLink(metadata.id)}
  ${fonts()}
  <style>${baseStyles()}</style>
</head>
<body>
  <div class="wrap">
    <div class="toolbar">
      <div class="toolbar-left">
        <h1>${escapeHtml(label)}</h1>
        <span class="toolbar-tag">encrypted</span>
      </div>
      <div class="toolbar-right">
        <button class="btn" data-original="${escapeHtml(copyLinkHtml)}" onclick="copyUrl(event)">${copyLinkHtml}</button>
        <button class="btn" id="copy-content-btn" data-original="${escapeHtml(copyHtml)}" onclick="copyContent(event)" disabled>${copyHtml}</button>
      </div>
    </div>
    ${renderMetaBar(metadata)}
    ${renderBurnWarning(isBurn, viewsLeft, isLastView)}
    <div id="loading" class="loading-box">
      <div class="spinner"></div>
      <p>Decrypting...</p>
    </div>
    <div id="error" class="error-box">
      <h2>Decryption failed</h2>
      <p id="error-message">The decryption key is missing or invalid.</p>
    </div>
    <div class="content-box" id="content"></div>
    ${renderKbdBar([{ key: "c", label: "copy" }])}
  </div>
  <script>
    ${getDecryptionScript()}
    ${confirmBtnScript()}
    ${copyUrlScript()}

    var rawUrl = '${rawUrl}';
    var storageType = '${metadata.storageType}';
    var decryptedText = null;

    async function init() {
      var key = getKeyFromHash();
      if (!key) {
        showError('No decryption key found in URL. The key should be in the URL fragment (after #).');
        return;
      }

      try {
        var response = await fetch(rawUrl);
        if (!response.ok) throw new Error('Failed to fetch content');
        var ciphertext = new Uint8Array(await response.arrayBuffer());
        if (storageType === 'kv') {
          ciphertext = base64ToBytes(ciphertext);
        }
        var decrypted = await decryptContent(ciphertext, key);
        decryptedText = new TextDecoder().decode(decrypted);

        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';
        document.getElementById('copy-content-btn').disabled = false;

        var contentEl = document.getElementById('content');
        if (looksLikeMarkdown(decryptedText)) {
          contentEl.classList.add('markdown');
          contentEl.innerHTML = marked.parse(decryptedText);
        } else {
          contentEl.innerHTML = '<pre>' + linkify(escapeHtml(decryptedText)) + '</pre>';
        }
      } catch (e) {
        showError('Failed to decrypt: ' + (e.message || 'Invalid key or corrupted data'));
      }
    }

    function looksLikeMarkdown(text) {
      return /^#{1,6}\\s|\\*\\*|__|\\[.+\\]\\(|^\\s*[-*+]\\s|^\\s*\\d+\\.\\s|^\\\`\\\`\\\`/m.test(text);
    }

    function escapeHtml(text) {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function linkify(text) {
      return text.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:#22d3ee">$1</a>');
    }

    function copyContent(e) {
      if (!decryptedText) return;
      navigator.clipboard.writeText(decryptedText);
      var btn = e && e.currentTarget ? e.currentTarget : document.getElementById('copy-content-btn');
      if (btn) confirmBtn(btn, btn.dataset.original);
    }

    ${kbdScript(true)}
    init();
  </script>
</body>
</html>`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = d.getTime() - now.getTime()
  const hours = Math.floor(diff / (1000 * 60 * 60))
  if (hours < 24) return `in ${hours}h`
  const days = Math.floor(hours / 24)
  return `in ${days}d`
}

export function render404(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#09090b">
  <title>Not Found - shrd.sh</title>
  ${faviconLink("shrdsh")}
  ${fonts()}
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { color-scheme: dark; }
    body {
      font-family: 'Geist', system-ui, -apple-system, sans-serif;
      background: #09090b;
      color: #52525b;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      -webkit-font-smoothing: antialiased;
      position: relative;
    }
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
      opacity: 0.03;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
      background-repeat: repeat;
      background-size: 256px 256px;
    }
    body > * { position: relative; z-index: 1; }
    .icon {
      width: 3rem;
      height: 3rem;
      border: 1px solid #1e1e24;
      background: #0f0f12;
      border-radius: 0.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 1.25rem;
      color: #52525b;
    }
    .icon svg { width: 20px; height: 20px; }
    h1 {
      font-family: 'Geist Mono', ui-monospace, monospace;
      font-size: 1.125rem;
      color: #d4d4d8;
      margin-bottom: 0.5rem;
    }
    p { font-size: 0.875rem; }
    a {
      display: inline-block;
      margin-top: 1.5rem;
      font-family: 'Geist Mono', ui-monospace, monospace;
      font-size: 0.75rem;
      color: #a1a1aa;
      background: #0f0f12;
      border: 1px solid #1e1e24;
      border-radius: 6px;
      padding: 0.5rem 1.25rem;
      text-decoration: none;
      transition: all 0.15s;
    }
    a:hover { border-color: #52525b; color: #e4e4e7; }
  </style>
</head>
<body>
  <div class="icon">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      <line x1="8" y1="11" x2="14" y2="11"/>
    </svg>
  </div>
  <h1>not found</h1>
  <p>This share may have expired or never existed.</p>
  <a href="/">go home</a>
</body>
</html>`
}
