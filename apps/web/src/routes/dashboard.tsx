import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";

type Share = {
  id: string;
  filename?: string;
  language?: string;
  size: number;
  expiresAt?: string;
  createdAt: string;
};

const fetchUserShares = createServerFn({ method: "GET" }).handler(async () => {
  const apiUrl = process.env.API_URL ?? "http://localhost:8787";

  const response = await fetch(`${apiUrl}/shares`, {
    headers: {
      Cookie: "",
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      return { authenticated: false, shares: [] };
    }
    throw new Error(`Failed to fetch shares: ${response.status}`);
  }

  const shares: Share[] = await response.json();
  return { authenticated: true, shares };
});

const deleteShare = createServerFn({ method: "POST" })
  .inputValidator((id: string) => id)
  .handler(async ({ data: id }) => {
    const apiUrl = process.env.API_URL ?? "http://localhost:8787";

    const response = await fetch(`${apiUrl}/shares/${id}`, {
      method: "DELETE",
      headers: {
        Cookie: "",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to delete share: ${response.status}`);
    }

    return { success: true };
  });

export const Route = createFileRoute("/dashboard")({
  beforeLoad: async () => {
    const result = await fetchUserShares();
    if (!result.authenticated) {
      throw redirect({ to: "/" });
    }
    return result;
  },
  loader: async ({ context }) => {
    return context;
  },
  component: DashboardPage,
});

function DashboardPage() {
  const { shares: initialShares } = Route.useLoaderData();
  const [shares, setShares] = useState(initialShares);
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);

  const filteredShares = shares.filter(
    (share) =>
      share.filename?.toLowerCase().includes(search.toLowerCase()) ||
      share.id.toLowerCase().includes(search.toLowerCase()) ||
      share.language?.toLowerCase().includes(search.toLowerCase())
  );

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this share? This cannot be undone.")) return;

    setDeleting(id);
    try {
      await deleteShare({ data: id });
      setShares(shares.filter((s) => s.id !== id));
    } catch (error) {
      console.error("Failed to delete:", error);
    } finally {
      setDeleting(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filteredShares.length - 1));
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        if (filteredShares[selectedIndex]) {
          window.location.href = `/${filteredShares[selectedIndex].id}`;
        }
        break;
      case "d":
        if (filteredShares[selectedIndex]) {
          handleDelete(filteredShares[selectedIndex].id);
        }
        break;
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div
      className="mx-auto max-w-5xl px-4 py-8"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-zinc-100">Your Shares</h1>
        <span className="text-sm text-zinc-500">
          {shares.length} {shares.length === 1 ? "share" : "shares"}
        </span>
      </div>

      <div className="mb-6">
        <input
          type="text"
          placeholder="Search by filename, id, or language..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSelectedIndex(0);
          }}
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3 text-zinc-100 placeholder-zinc-500 focus:border-zinc-700 focus:outline-none"
        />
      </div>

      {filteredShares.length === 0 ? (
        <div className="py-16 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800">
            <span className="text-xl">📭</span>
          </div>
          <p className="text-zinc-400">
            {search ? "No shares match your search" : "No shares yet"}
          </p>
          {!search && (
            <p className="mt-2 text-sm text-zinc-500">
              Use the CLI to create your first share
            </p>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-zinc-800">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Language
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Size
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Created
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
                  Expires
                </th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {filteredShares.map((share, index) => (
                <tr
                  key={share.id}
                  className={`transition-colors ${
                    index === selectedIndex
                      ? "bg-zinc-800/50"
                      : "hover:bg-zinc-900/50"
                  }`}
                >
                  <td className="px-4 py-3">
                    <Link
                      to="/$id"
                      params={{ id: share.id }}
                      className="font-mono text-sm text-zinc-100 hover:text-emerald-400"
                    >
                      {share.filename ?? share.id}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    {share.language && (
                      <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-400">
                        {share.language}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-sm text-zinc-400">
                    {formatSize(share.size)}
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400">
                    {formatDate(share.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-sm text-zinc-400">
                    {share.expiresAt ? formatDate(share.expiresAt) : "Never"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDelete(share.id)}
                      disabled={deleting === share.id}
                      className="text-sm text-zinc-500 transition-colors hover:text-red-400 disabled:opacity-50"
                    >
                      {deleting === share.id ? "..." : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6 text-center text-xs text-zinc-500">
        <kbd className="rounded border border-zinc-700 px-1.5 py-0.5">j</kbd>/
        <kbd className="rounded border border-zinc-700 px-1.5 py-0.5">k</kbd>{" "}
        navigate
        <span className="mx-2">|</span>
        <kbd className="rounded border border-zinc-700 px-1.5 py-0.5">
          Enter
        </kbd>{" "}
        open
        <span className="mx-2">|</span>
        <kbd className="rounded border border-zinc-700 px-1.5 py-0.5">d</kbd>{" "}
        delete
      </div>
    </div>
  );
}
