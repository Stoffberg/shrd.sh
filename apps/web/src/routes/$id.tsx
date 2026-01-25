import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";

type Share = {
  id: string;
  content: string;
  filename?: string;
  language?: string;
  expiresAt?: string;
  createdAt: string;
  highlighted?: string;
};

const fetchShare = createServerFn({ method: "GET" })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const apiUrl = "https://shrd-api.plutocrat.workers.dev";

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
      filename: meta.filename,
      language: meta.contentType === "json" ? "json" : meta.contentType === "markdown" ? "markdown" : "text",
      expiresAt: meta.expiresAt,
      createdAt: meta.createdAt,
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

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          {share.filename && (
            <span className="font-mono text-sm text-zinc-400">
              {share.filename}
            </span>
          )}
          {share.language && (
            <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-400">
              {share.language}
            </span>
          )}
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
            href={`/raw/${share.id}`}
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
