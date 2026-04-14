import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, useEffect, useCallback } from "react";

type Share = {
  id: string;
  content: string;
  url: string;
  rawUrl: string;
  name?: string;
  filename?: string;
  contentType: string;
  language?: string;
  expiresAt?: string;
  createdAt: string;
  burn: boolean;
  encrypted: boolean;
  views: number;
  highlighted?: string;
};

const fetchShare = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const apiUrl = process.env.API_URL ?? "https://shrd.stoff.dev";
    const publicUrl = process.env.PUBLIC_BASE_URL ?? "https://shrd.stoff.dev";

    const metaResponse = await fetch(`${apiUrl}/${id}/meta`);

    if (!metaResponse.ok) {
      if (metaResponse.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch share: ${metaResponse.status}`);
    }

    const meta = await metaResponse.json();

    const rawResponse = await fetch(`${apiUrl}/${id}/raw`);
    if (!rawResponse.ok) {
      throw new Error(`Failed to fetch content: ${rawResponse.status}`);
    }
    const content = await rawResponse.text();

    const share: Share = {
      id: meta.id,
      content,
      url: `${publicUrl}/${meta.id}`,
      rawUrl: `${publicUrl}/${meta.id}/raw`,
      name: meta.name ?? undefined,
      filename: meta.filename,
      contentType: meta.contentType,
      language:
        meta.contentType === "application/json"
          ? "json"
          : meta.contentType === "text/markdown"
            ? "markdown"
            : "text",
      expiresAt: meta.expiresAt,
      createdAt: meta.createdAt,
      burn: meta.burn === true,
      encrypted: meta.encrypted === true,
      views: typeof meta.views === "number" ? meta.views : 0,
    };

    try {
      const { codeToHtml } = await import("shiki");
      const highlighted = await codeToHtml(share.content, {
        lang: share.language ?? "text",
        theme: "github-dark-default",
      });
      return { ...share, highlighted };
    } catch {
      return share;
    }
  });

export const Route = createFileRoute("/$id")({
  head: ({ loaderData }) => {
    const label = loaderData?.name ?? loaderData?.filename ?? loaderData?.id;
    return {
      meta: [
        { title: label ? `${label} - shrd.sh` : "shrd.sh" },
      ],
    };
  },
  loader: async ({ params }) => {
    const share = await fetchShare({ data: params.id });
    if (!share) {
      throw notFound();
    }
    return share;
  },
  notFoundComponent: NotFoundShare,
  component: SharePage,
});

function SharePage() {
  const share = Route.useLoaderData();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(share.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [share.content]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([share.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = share.filename ?? `${share.id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [share.content, share.filename, share.id]);

  const handleRaw = useCallback(() => {
    window.open(share.rawUrl, "_blank");
  }, [share.rawUrl]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case "c":
          handleCopy();
          break;
        case "d":
          handleDownload();
          break;
        case "r":
          handleRaw();
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCopy, handleDownload, handleRaw]);

  const shareLabel = share.name ?? share.filename ?? share.id;
  const lineCount = share.content.split("\n").length;
  const byteSize = new TextEncoder().encode(share.content).length;

  return (
    <div className="mx-auto max-w-6xl px-5 py-6">
      <Toolbar
        label={shareLabel}
        language={share.language}
        contentType={share.contentType}
        lineCount={lineCount}
        byteSize={byteSize}
        copied={copied}
        onCopy={handleCopy}
        onDownload={handleDownload}
        onRaw={handleRaw}
      />

      <MetaBar share={share} />

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="overflow-x-auto">
          {share.highlighted ? (
            <div
              className="p-5 font-mono text-[13px] leading-relaxed"
              dangerouslySetInnerHTML={{ __html: share.highlighted }}
            />
          ) : (
            <pre className="p-5 font-mono text-[13px] leading-relaxed text-zinc-300">
              {share.content}
            </pre>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-center gap-4 text-[11px] text-zinc-600">
        <Kbd letter="c" label="copy" />
        <Kbd letter="d" label="download" />
        <Kbd letter="r" label="raw" />
      </div>
    </div>
  );
}

function Toolbar({
  label,
  language,
  contentType,
  lineCount,
  byteSize,
  copied,
  onCopy,
  onDownload,
  onRaw,
}: {
  label: string;
  language?: string;
  contentType: string;
  lineCount: number;
  byteSize: number;
  copied: boolean;
  onCopy: () => void;
  onDownload: () => void;
  onRaw: () => void;
}) {
  return (
    <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <h1 className="font-mono text-sm font-medium text-zinc-100 truncate max-w-[300px] sm:max-w-[500px]">
          {label}
        </h1>
        {language && language !== "text" && (
          <span className="rounded bg-surface-raised px-2 py-0.5 font-mono text-[11px] text-zinc-500 border border-border-subtle">
            {language}
          </span>
        )}
        <span className="hidden sm:inline font-mono text-[11px] text-zinc-600">
          {lineCount} {lineCount === 1 ? "line" : "lines"}
        </span>
        <span className="hidden sm:inline font-mono text-[11px] text-zinc-600">
          {formatBytes(byteSize)}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <ToolbarButton onClick={onCopy} title="Copy (c)">
          {copied ? (
            <CheckIcon />
          ) : (
            <CopyIcon />
          )}
          <span>{copied ? "Copied" : "Copy"}</span>
        </ToolbarButton>
        <ToolbarButton onClick={onRaw} title="Raw (r)">
          <RawIcon />
          <span>Raw</span>
        </ToolbarButton>
        <ToolbarButton onClick={onDownload} title="Download (d)">
          <DownloadIcon />
          <span>Download</span>
        </ToolbarButton>
      </div>
    </div>
  );
}

function MetaBar({ share }: { share: Share }) {
  const expiresAt = share.expiresAt ? new Date(share.expiresAt) : null;
  const isExpiringSoon = expiresAt && expiresAt.getTime() - Date.now() < 3600000;

  const tags: string[] = [];
  if (share.encrypted) tags.push("encrypted");
  if (share.burn) tags.push("view once");
  if (isExpiringSoon) tags.push("expires soon");

  const hasExpiryInfo = expiresAt || tags.length > 0;
  if (!hasExpiryInfo && share.views === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500 font-mono">
      {share.views > 0 && (
        <span>{share.views} {share.views === 1 ? "view" : "views"}</span>
      )}
      <span>{formatRelativeTime(share.createdAt)}</span>
      {expiresAt && (
        <span className={isExpiringSoon ? "text-amber-500" : ""}>
          expires {expiresAt.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </span>
      )}
      {tags.map((tag) => (
        <span
          key={tag}
          className="rounded-full border border-border bg-surface-raised px-2 py-0.5 text-zinc-400"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] text-zinc-400 transition-all hover:border-zinc-600 hover:text-zinc-200 hover:bg-surface-raised active:scale-[0.97]"
    >
      {children}
    </button>
  );
}

function Kbd({ letter, label }: { letter: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="inline-flex h-5 w-5 items-center justify-center rounded border border-border bg-surface font-mono text-[10px] text-zinc-500">
        {letter}
      </kbd>
      <span>{label}</span>
    </span>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(dateStr: string) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function RawIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function NotFoundShare() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-24 text-center">
      <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-surface">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
          <line x1="8" y1="11" x2="14" y2="11" />
        </svg>
      </div>
      <h1 className="font-mono text-lg text-zinc-200">not found</h1>
      <p className="mt-2 text-sm text-zinc-500">
        This share may have expired or never existed.
      </p>
      <a
        href="/"
        className="mt-6 inline-block rounded-md border border-border bg-surface px-5 py-2 font-mono text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
      >
        go home
      </a>
    </div>
  );
}
