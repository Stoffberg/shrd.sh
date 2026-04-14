import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";

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

  const handleCopy = async () => {
    await navigator.clipboard.writeText(share.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([share.content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = share.filename ?? `${share.id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const expiresAt = share.expiresAt ? new Date(share.expiresAt) : null;
  const isExpiringSoon =
    expiresAt && expiresAt.getTime() - Date.now() < 3600000;
  const shareLabel = share.name ?? share.filename ?? share.id;
  const badges = [
    share.name ? "Named share" : "Quick share",
    share.encrypted ? "Encrypted" : null,
    share.burn ? "View once" : null,
    expiresAt ? (isExpiringSoon ? "Expires soon" : "Timed") : "Permanent",
    `${share.views} ${share.views === 1 ? "view" : "views"}`,
  ].filter(Boolean);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">
                Share
              </p>
              <h1 className="font-mono text-lg text-zinc-100">{shareLabel}</h1>
              <p className="text-sm text-zinc-400">
                {share.contentType}
                {share.filename ? ` · ${share.filename}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {badges.map((badge) => (
                <span
                  key={badge}
                  className="rounded-full border border-zinc-700 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-300"
                >
                  {badge}
                </span>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
              title="Copy to clipboard (c)"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <a
              href={share.rawUrl}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
            >
              Raw
            </a>
            <button
              onClick={handleDownload}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
              title="Download (d)"
            >
              Download
            </button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-6 text-sm text-zinc-400">
          <span>Created {new Date(share.createdAt).toLocaleString()}</span>
          <span>{expiresAt ? `Expires ${expiresAt.toLocaleString()}` : "No automatic expiry"}</span>
          <a href={share.url} className="font-mono text-zinc-500 hover:text-zinc-300">
            {share.url}
          </a>
        </div>
      </div>

      {expiresAt && (
        <div
          className={`mb-4 rounded-lg border px-4 py-2 text-sm ${
            isExpiringSoon
              ? "border-amber-800 bg-amber-900/20 text-amber-400"
              : "border-zinc-800 bg-zinc-900/50 text-zinc-400"
          }`}
        >
          {isExpiringSoon ? "Expires soon: " : "Expires: "}
          {expiresAt.toLocaleString()}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
        <div className="overflow-x-auto">
          {share.highlighted ? (
            <div
              className="p-4 font-mono text-sm leading-relaxed [&_pre]:!bg-transparent"
              dangerouslySetInnerHTML={{ __html: share.highlighted }}
            />
          ) : (
            <pre className="p-4 font-mono text-sm leading-relaxed text-zinc-300">
              {share.content}
            </pre>
          )}
        </div>
      </div>

      <div className="mt-4 text-center text-xs text-zinc-500">
        <kbd className="rounded border border-zinc-700 px-1.5 py-0.5">c</kbd>{" "}
        copy
        <span className="mx-2">|</span>
        <kbd className="rounded border border-zinc-700 px-1.5 py-0.5">d</kbd>{" "}
        download
        <span className="mx-2">|</span>
        <kbd className="rounded border border-zinc-700 px-1.5 py-0.5">r</kbd>{" "}
        raw
      </div>
    </div>
  );
}

function NotFoundShare() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16 text-center">
      <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-zinc-800">
        <span className="text-2xl">🔍</span>
      </div>
      <h1 className="text-2xl font-semibold text-zinc-100">Share not found</h1>
      <p className="mt-2 text-zinc-400">
        This share may have expired or never existed.
      </p>
      <a
        href="/"
        className="mt-6 inline-block rounded-lg bg-zinc-800 px-6 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-700"
      >
        Go home
      </a>
    </div>
  );
}
