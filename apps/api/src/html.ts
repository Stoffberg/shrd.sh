import type { ContentMetadata } from "./types"

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

export function isBinaryContent(contentType: string): boolean {
  return (
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("application/pdf") ||
    contentType.startsWith("application/zip") ||
    contentType.startsWith("application/octet-stream") ||
    contentType.startsWith("application/gzip") ||
    contentType.startsWith("application/x-tar")
  )
}

function renderStatusBadges(metadata: ContentMetadata): string {
  const badges = [
    metadata.name ? "named share" : "quick share",
    metadata.encrypted ? "encrypted" : null,
    metadata.maxViews !== undefined ? "view once" : null,
    metadata.expiresAt ? `expires ${formatDate(metadata.expiresAt)}` : "permanent",
  ].filter(Boolean)

  return `<div class="badges">${badges
    .map((badge) => `<span class="badge">${badge}</span>`)
    .join("")}</div>`
}

function renderMetaLine(metadata: ContentMetadata): string {
  const label = metadata.filename ?? metadata.name ?? metadata.id
  const parts = [label, formatSize(metadata.size), metadata.expiresAt ? `expires ${formatDate(metadata.expiresAt)}` : "never expires"]
  if (metadata.encrypted) {
    parts.push("encrypted")
  }
  if (metadata.maxViews !== undefined) {
    parts.push("view once")
  }
  return parts.join(" · ")
}

export function renderBinaryPage(metadata: ContentMetadata, baseUrl: string): string {
  const isBurn = metadata.maxViews !== undefined
  const viewsLeft = isBurn ? metadata.maxViews! - metadata.views - 1 : null
  const isLastView = viewsLeft === 0
  const shareUrl = `${baseUrl}/${metadata.id}`
  const rawUrl = `${baseUrl}/${metadata.id}/raw`
  const contentType = metadata.contentType
  const isEncrypted = metadata.encrypted === true

  if (isEncrypted) {
    return renderEncryptedBinaryPage(metadata, baseUrl, rawUrl, isBurn, viewsLeft, isLastView)
  }

  let mediaElement = ""
  if (contentType.startsWith("video/")) {
    mediaElement = `<video controls autoplay class="media"><source src="${rawUrl}" type="${contentType}">Your browser does not support video.</video>`
  } else if (contentType.startsWith("audio/")) {
    mediaElement = `<audio controls class="media"><source src="${rawUrl}" type="${contentType}">Your browser does not support audio.</audio>`
  } else if (contentType.startsWith("image/")) {
    mediaElement = `<img src="${rawUrl}" class="media" alt="${metadata.filename || 'image'}">`
  } else if (contentType === "application/pdf") {
    mediaElement = `<iframe src="${rawUrl}" class="media pdf"></iframe>`
  } else {
    mediaElement = `<div class="download-box"><a href="${rawUrl}" download="${metadata.filename || metadata.id}" class="download-btn">Download File</a><p class="file-info">${metadata.filename || 'file'} · ${formatSize(metadata.size)}</p></div>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metadata.filename || metadata.id}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #262626;
    }
    .url {
      font-family: monospace;
      font-size: 0.875rem;
      color: #737373;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn {
      background: #262626;
      border: 1px solid #404040;
      color: #e5e5e5;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.875rem;
      text-decoration: none;
      transition: background 0.15s;
      white-space: nowrap;
    }
    .btn:hover { background: #333; }
    .warning {
      background: #451a03;
      border: 1px solid #92400e;
      color: #fbbf24;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      margin-bottom: 1.5rem;
      font-size: 0.875rem;
    }
    .warning.last {
      background: #450a0a;
      border-color: #991b1b;
      color: #f87171;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .badge {
      border: 1px solid #404040;
      border-radius: 999px;
      background: #171717;
      color: #d4d4d4;
      font-size: 0.75rem;
      padding: 0.25rem 0.65rem;
    }
    .media {
      max-width: 100%;
      max-height: 80vh;
      border-radius: 8px;
      background: #171717;
    }
    .media.pdf {
      width: 100%;
      height: 80vh;
      border: 1px solid #262626;
    }
    video, audio { width: 100%; }
    .download-box {
      background: #171717;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 3rem;
      text-align: center;
    }
    .download-btn {
      display: inline-block;
      background: #2563eb;
      color: white;
      padding: 1rem 2rem;
      border-radius: 8px;
      text-decoration: none;
      font-size: 1.1rem;
      margin-bottom: 1rem;
    }
    .download-btn:hover { background: #1d4ed8; }
    .file-info { color: #737373; }
    .meta {
      margin-top: 1rem;
      font-size: 0.75rem;
      color: #525252;
    }
    .copied {
      position: fixed;
      bottom: 2rem;
      left: 50%;
      transform: translateX(-50%);
      background: #166534;
      color: #fff;
      padding: 0.75rem 1.5rem;
      border-radius: 6px;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .copied.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="url">${shareUrl}</span>
      <button class="btn" onclick="copyUrl()">Copy Link</button>
      <a href="${rawUrl}" download class="btn">Download</a>
    </div>
    ${renderStatusBadges(metadata)}
    ${isBurn ? `
    <div class="warning${isLastView ? ' last' : ''}">
      ${isLastView 
        ? 'This content will be deleted after you leave this page.' 
        : `This content will be deleted after ${viewsLeft} more view${viewsLeft === 1 ? '' : 's'}.`}
    </div>
    ` : ''}
    ${mediaElement}
    <div class="meta">
      ${renderMetaLine(metadata)}
    </div>
  </div>
  <div class="copied" id="copied">Copied!</div>
  <script>
    function copyUrl() {
      navigator.clipboard.writeText(window.location.href);
      const el = document.getElementById('copied');
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 1500);
    }
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
  const contentType = metadata.contentType
  const filename = metadata.filename || metadata.id

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metadata.filename || metadata.id} (Encrypted)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #262626;
    }
    .url {
      font-family: monospace;
      font-size: 0.875rem;
      color: #737373;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn {
      background: #262626;
      border: 1px solid #404040;
      color: #e5e5e5;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.875rem;
      text-decoration: none;
      transition: background 0.15s;
      white-space: nowrap;
    }
    .btn:hover { background: #333; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .warning {
      background: #451a03;
      border: 1px solid #92400e;
      color: #fbbf24;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      margin-bottom: 1.5rem;
      font-size: 0.875rem;
    }
    .warning.last {
      background: #450a0a;
      border-color: #991b1b;
      color: #f87171;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .badge {
      border: 1px solid #404040;
      border-radius: 999px;
      background: #171717;
      color: #d4d4d4;
      font-size: 0.75rem;
      padding: 0.25rem 0.65rem;
    }
    .media {
      max-width: 100%;
      max-height: 80vh;
      border-radius: 8px;
      background: #171717;
    }
    .media.pdf {
      width: 100%;
      height: 80vh;
      border: 1px solid #262626;
    }
    video, audio { width: 100%; }
    .download-box {
      background: #171717;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 3rem;
      text-align: center;
    }
    .download-btn {
      display: inline-block;
      background: #2563eb;
      color: white;
      padding: 1rem 2rem;
      border-radius: 8px;
      text-decoration: none;
      font-size: 1.1rem;
      margin-bottom: 1rem;
      cursor: pointer;
      border: none;
    }
    .download-btn:hover { background: #1d4ed8; }
    .download-btn:disabled { background: #374151; cursor: not-allowed; }
    .file-info { color: #737373; }
    .meta {
      margin-top: 1rem;
      font-size: 0.75rem;
      color: #525252;
    }
    .copied {
      position: fixed;
      bottom: 2rem;
      left: 50%;
      transform: translateX(-50%);
      background: #166534;
      color: #fff;
      padding: 0.75rem 1.5rem;
      border-radius: 6px;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .copied.show { opacity: 1; }
    .error-box {
      background: #450a0a;
      border: 1px solid #991b1b;
      border-radius: 8px;
      padding: 3rem;
      text-align: center;
    }
    .error-box h2 { color: #f87171; margin-bottom: 1rem; }
    .error-box p { color: #fca5a5; }
    .loading-box {
      background: #171717;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 3rem;
      text-align: center;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #262626;
      border-top-color: #2563eb;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #content { display: none; }
    #loading { display: block; }
    #error { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="url">${baseUrl}/${metadata.id}#key=...</span>
      <button class="btn" onclick="copyUrl()">Copy Link</button>
      <button class="btn" id="download-header-btn" onclick="downloadFile()" disabled>Download</button>
    </div>
    ${renderStatusBadges(metadata)}
    ${isBurn ? `
    <div class="warning${isLastView ? ' last' : ''}">
      ${isLastView 
        ? 'This content will be deleted after you leave this page.' 
        : `This content will be deleted after ${viewsLeft} more view${viewsLeft === 1 ? '' : 's'}.`}
    </div>
    ` : ''}
    <div id="loading" class="loading-box">
      <div class="spinner"></div>
      <p>Decrypting content...</p>
    </div>
    <div id="error" class="error-box">
      <h2>Decryption Failed</h2>
      <p id="error-message">The decryption key is missing or invalid.</p>
    </div>
    <div id="content"></div>
    <div class="meta">
      ${renderMetaLine(metadata)}
    </div>
  </div>
  <div class="copied" id="copied">Copied!</div>
  <script>
    ${getDecryptionScript()}
    
    const rawUrl = '${rawUrl}';
    const contentType = '${contentType}';
    const filename = '${filename}';
    const storageType = '${metadata.storageType}';
    let decryptedBlob = null;

    async function init() {
      const key = getKeyFromHash();
      if (!key) {
        showError('No decryption key found in URL. The key should be in the URL fragment (after #).');
        return;
      }

      try {
        const response = await fetch(rawUrl);
        if (!response.ok) throw new Error('Failed to fetch content');
        let ciphertext = new Uint8Array(await response.arrayBuffer());
        if (storageType === 'kv') {
          ciphertext = base64ToBytes(ciphertext);
        }
        const decrypted = await decryptContent(ciphertext, key);
        decryptedBlob = new Blob([decrypted], { type: contentType });
        
        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';
        document.getElementById('download-header-btn').disabled = false;
        
        const blobUrl = URL.createObjectURL(decryptedBlob);
        
        if (contentType.startsWith('video/')) {
          document.getElementById('content').innerHTML = '<video controls autoplay class="media"><source src="' + blobUrl + '" type="' + contentType + '">Your browser does not support video.</video>';
        } else if (contentType.startsWith('audio/')) {
          document.getElementById('content').innerHTML = '<audio controls class="media"><source src="' + blobUrl + '" type="' + contentType + '">Your browser does not support audio.</audio>';
        } else if (contentType.startsWith('image/')) {
          document.getElementById('content').innerHTML = '<img src="' + blobUrl + '" class="media" alt="' + filename + '">';
        } else {
          document.getElementById('content').innerHTML = '<div class="download-box"><button onclick="downloadFile()" class="download-btn">Download File</button><p class="file-info">' + filename + '</p></div>';
        }
      } catch (e) {
        showError('Failed to decrypt: ' + (e.message || 'Invalid key or corrupted data'));
      }
    }

    function downloadFile() {
      if (!decryptedBlob) return;
      const url = URL.createObjectURL(decryptedBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }

    function copyUrl() {
      navigator.clipboard.writeText(window.location.href);
      const el = document.getElementById('copied');
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 1500);
    }

    init();
  </script>
</body>
</html>`
}

export function renderContentPage(content: string, metadata: ContentMetadata, baseUrl: string): string {
  const isBurn = metadata.maxViews !== undefined
  const viewsLeft = isBurn ? metadata.maxViews! - metadata.views - 1 : null
  const isLastView = viewsLeft === 0
  const shareUrl = `${baseUrl}/${metadata.id}`
  const rawUrl = `${baseUrl}/${metadata.id}/raw`
  const isEncrypted = metadata.encrypted === true

  if (isEncrypted) {
    return renderEncryptedContentPage(metadata, baseUrl, rawUrl, isBurn, viewsLeft, isLastView)
  }

  const escaped = escapeHtml(content)
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metadata.filename || metadata.id}</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 900px; margin: 0 auto; }
    .header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #262626;
    }
    .url {
      font-family: monospace;
      font-size: 0.875rem;
      color: #737373;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn {
      background: #262626;
      border: 1px solid #404040;
      color: #e5e5e5;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.875rem;
      transition: background 0.15s;
      white-space: nowrap;
    }
    .btn:hover { background: #333; }
    .btn:active { background: #404040; }
    .warning {
      background: #451a03;
      border: 1px solid #92400e;
      color: #fbbf24;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      margin-bottom: 1.5rem;
      font-size: 0.875rem;
    }
    .warning.last {
      background: #450a0a;
      border-color: #991b1b;
      color: #f87171;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .badge {
      border: 1px solid #404040;
      border-radius: 999px;
      background: #171717;
      color: #d4d4d4;
      font-size: 0.75rem;
      padding: 0.25rem 0.65rem;
    }
    .content {
      background: #171717;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 1.5rem;
      overflow-x: auto;
    }
    .content pre {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 0.875rem;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .content.markdown {
      line-height: 1.7;
    }
    .content.markdown h1, .content.markdown h2, .content.markdown h3 {
      margin-top: 1.5rem;
      margin-bottom: 0.75rem;
      color: #fff;
    }
    .content.markdown h1:first-child, .content.markdown h2:first-child {
      margin-top: 0;
    }
    .content.markdown p { margin-bottom: 1rem; }
    .content.markdown code {
      background: #262626;
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      font-size: 0.875em;
    }
    .content.markdown pre {
      background: #0a0a0a;
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1rem 0;
    }
    .content.markdown pre code {
      background: none;
      padding: 0;
    }
    .content.markdown ul, .content.markdown ol {
      margin-left: 1.5rem;
      margin-bottom: 1rem;
    }
    .content.markdown a { color: #60a5fa; }
    .meta {
      margin-top: 1rem;
      font-size: 0.75rem;
      color: #525252;
    }
    .copied {
      position: fixed;
      bottom: 2rem;
      left: 50%;
      transform: translateX(-50%);
      background: #166534;
      color: #fff;
      padding: 0.75rem 1.5rem;
      border-radius: 6px;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .copied.show { opacity: 1; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="url">${shareUrl}</span>
      <button class="btn" onclick="copyUrl()">Copy Link</button>
      <a href="${rawUrl}" class="btn">Raw</a>
      <button class="btn" onclick="copyContent()">Copy Content</button>
    </div>
    ${renderStatusBadges(metadata)}
    ${isBurn ? `
    <div class="warning${isLastView ? ' last' : ''}">
      ${isLastView 
        ? 'This content will be deleted after you leave this page.' 
        : `This content will be deleted after ${viewsLeft} more view${viewsLeft === 1 ? '' : 's'}.`}
    </div>
    ` : ''}
    <div class="content" id="content"><pre>${escaped}</pre></div>
    <div class="meta">
      ${renderMetaLine(metadata)}
    </div>
  </div>
  <div class="copied" id="copied">Copied!</div>
  <script>
    const raw = ${JSON.stringify(content)};
    const contentEl = document.getElementById('content');
    
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
      return text.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    }
    
    function copyUrl() {
      navigator.clipboard.writeText(window.location.href);
      showCopied();
    }
    
    function copyContent() {
      navigator.clipboard.writeText(raw);
      showCopied();
    }
    
    function showCopied() {
      const el = document.getElementById('copied');
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 1500);
    }
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
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${metadata.filename || metadata.id} (Encrypted)</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 900px; margin: 0 auto; }
    .header {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #262626;
    }
    .url {
      font-family: monospace;
      font-size: 0.875rem;
      color: #737373;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .btn {
      background: #262626;
      border: 1px solid #404040;
      color: #e5e5e5;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.875rem;
      transition: background 0.15s;
      white-space: nowrap;
    }
    .btn:hover { background: #333; }
    .btn:active { background: #404040; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .warning {
      background: #451a03;
      border: 1px solid #92400e;
      color: #fbbf24;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      margin-bottom: 1.5rem;
      font-size: 0.875rem;
    }
    .warning.last {
      background: #450a0a;
      border-color: #991b1b;
      color: #f87171;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .badge {
      border: 1px solid #404040;
      border-radius: 999px;
      background: #171717;
      color: #d4d4d4;
      font-size: 0.75rem;
      padding: 0.25rem 0.65rem;
    }
    .content {
      background: #171717;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 1.5rem;
      overflow-x: auto;
    }
    .content pre {
      font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
      font-size: 0.875rem;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .content.markdown {
      line-height: 1.7;
    }
    .content.markdown h1, .content.markdown h2, .content.markdown h3 {
      margin-top: 1.5rem;
      margin-bottom: 0.75rem;
      color: #fff;
    }
    .content.markdown h1:first-child, .content.markdown h2:first-child {
      margin-top: 0;
    }
    .content.markdown p { margin-bottom: 1rem; }
    .content.markdown code {
      background: #262626;
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
      font-size: 0.875em;
    }
    .content.markdown pre {
      background: #0a0a0a;
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      margin: 1rem 0;
    }
    .content.markdown pre code {
      background: none;
      padding: 0;
    }
    .content.markdown ul, .content.markdown ol {
      margin-left: 1.5rem;
      margin-bottom: 1rem;
    }
    .content.markdown a { color: #60a5fa; }
    .meta {
      margin-top: 1rem;
      font-size: 0.75rem;
      color: #525252;
    }
    .copied {
      position: fixed;
      bottom: 2rem;
      left: 50%;
      transform: translateX(-50%);
      background: #166534;
      color: #fff;
      padding: 0.75rem 1.5rem;
      border-radius: 6px;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .copied.show { opacity: 1; }
    .error-box {
      background: #450a0a;
      border: 1px solid #991b1b;
      border-radius: 8px;
      padding: 3rem;
      text-align: center;
    }
    .error-box h2 { color: #f87171; margin-bottom: 1rem; }
    .error-box p { color: #fca5a5; }
    .loading-box {
      background: #171717;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 3rem;
      text-align: center;
    }
    .spinner {
      width: 40px;
      height: 40px;
      border: 3px solid #262626;
      border-top-color: #2563eb;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 1rem;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #content { display: none; }
    #loading { display: block; }
    #error { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="url">${baseUrl}/${metadata.id}#key=...</span>
      <button class="btn" onclick="copyUrl()">Copy Link</button>
      <button class="btn" id="copy-content-btn" onclick="copyContent()" disabled>Copy Content</button>
    </div>
    ${renderStatusBadges(metadata)}
    ${isBurn ? `
    <div class="warning${isLastView ? ' last' : ''}">
      ${isLastView 
        ? 'This content will be deleted after you leave this page.' 
        : `This content will be deleted after ${viewsLeft} more view${viewsLeft === 1 ? '' : 's'}.`}
    </div>
    ` : ''}
    <div id="loading" class="loading-box">
      <div class="spinner"></div>
      <p>Decrypting content...</p>
    </div>
    <div id="error" class="error-box">
      <h2>Decryption Failed</h2>
      <p id="error-message">The decryption key is missing or invalid.</p>
    </div>
    <div class="content" id="content"></div>
    <div class="meta">
      ${renderMetaLine(metadata)}
    </div>
  </div>
  <div class="copied" id="copied">Copied!</div>
  <script>
    ${getDecryptionScript()}
    
    const rawUrl = '${rawUrl}';
    const storageType = '${metadata.storageType}';
    let decryptedText = null;

    async function init() {
      const key = getKeyFromHash();
      if (!key) {
        showError('No decryption key found in URL. The key should be in the URL fragment (after #).');
        return;
      }

      try {
        const response = await fetch(rawUrl);
        if (!response.ok) throw new Error('Failed to fetch content');
        let ciphertext = new Uint8Array(await response.arrayBuffer());
        if (storageType === 'kv') {
          ciphertext = base64ToBytes(ciphertext);
        }
        const decrypted = await decryptContent(ciphertext, key);
        decryptedText = new TextDecoder().decode(decrypted);
        
        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';
        document.getElementById('copy-content-btn').disabled = false;
        
        const contentEl = document.getElementById('content');
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
      return text.replace(/(https?:\\/\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    }

    function copyUrl() {
      navigator.clipboard.writeText(window.location.href);
      showCopied();
    }
    
    function copyContent() {
      if (!decryptedText) return;
      navigator.clipboard.writeText(decryptedText);
      showCopied();
    }
    
    function showCopied() {
      const el = document.getElementById('copied');
      el.classList.add('show');
      setTimeout(() => el.classList.remove('show'), 1500);
    }

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
  <title>Not Found</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0a0a0a;
      color: #737373;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .msg { text-align: center; }
    h1 { color: #e5e5e5; font-size: 1.5rem; margin-bottom: 0.5rem; }
  </style>
</head>
<body>
  <div class="msg">
    <h1>Content not found</h1>
    <p>It may have expired or been deleted.</p>
  </div>
</body>
</html>`
}
