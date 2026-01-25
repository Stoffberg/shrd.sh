import type { ReactNode } from "react";
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
  Link,
} from "@tanstack/react-router";
import appCss from "~/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "shrd.sh - Share anything, instantly" },
      {
        name: "description",
        content: "CLI-first content sharing. Fast, private, ephemeral.",
      },
      { name: "theme-color", content: "#09090b" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen bg-zinc-950 text-zinc-100">
        <Header />
        <main>{children}</main>
        <Scripts />
      </body>
    </html>
  );
}

function Header() {
  return (
    <header className="border-b border-zinc-800/50">
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <Link to="/" className="font-mono text-lg font-semibold text-zinc-100">
          shrd.sh
        </Link>
        <div className="flex items-center gap-6">
          <Link
            to="/dashboard"
            className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
            activeProps={{ className: "text-zinc-100" }}
          >
            Dashboard
          </Link>
          <a
            href="https://github.com/shrdsh/cli"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
          >
            GitHub
          </a>
        </div>
      </nav>
    </header>
  );
}
