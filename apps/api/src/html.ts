import type { ContentMetadata } from "./types"

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

export function renderContentPage(content: string, metadata: ContentMetadata, baseUrl: string): string {
  const escaped = escapeHtml(content)
  const isBurn = metadata.maxViews !== undefined
  const viewsLeft = isBurn ? metadata.maxViews! - metadata.views - 1 : null
  const isLastView = viewsLeft === 0
  const rawUrl = `${baseUrl}/${metadata.id}/raw`
  
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
      <span class="url">${rawUrl}</span>
      <button class="btn" onclick="copyUrl()">Copy Link</button>
      <button class="btn" onclick="copyContent()">Copy Content</button>
    </div>
    ${isBurn ? `
    <div class="warning${isLastView ? ' last' : ''}">
      ${isLastView 
        ? 'This content will be deleted after you leave this page.' 
        : `This content will be deleted after ${viewsLeft} more view${viewsLeft === 1 ? '' : 's'}.`}
    </div>
    ` : ''}
    <div class="content" id="content"><pre>${escaped}</pre></div>
    <div class="meta">
      ${metadata.filename ? `${metadata.filename} · ` : ''}${formatSize(metadata.size)}${metadata.expiresAt ? ` · expires ${formatDate(metadata.expiresAt)}` : ''}
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
      navigator.clipboard.writeText('${rawUrl}');
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
