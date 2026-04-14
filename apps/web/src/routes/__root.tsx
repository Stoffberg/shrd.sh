import type { ReactNode } from "react";
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
  Link,
} from "@tanstack/react-router";
import { GEIST_MONO_WOFF2_URL, GEIST_SANS_WOFF2_URL, getGeistFontFaceCss } from "../../../../packages/shared/src/fonts";
import appCss from "~/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "shrd.sh" },
      {
        name: "description",
        content: "CLI-first content sharing. Fast, private, ephemeral.",
      },
      { name: "theme-color", content: "#09090b" },
    ],
    links: [
      { rel: "preconnect", href: "https://cdn.jsdelivr.net", crossOrigin: "anonymous" },
      {
        rel: "preload",
        href: GEIST_SANS_WOFF2_URL,
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
      {
        rel: "preload",
        href: GEIST_MONO_WOFF2_URL,
        as: "font",
        type: "font/woff2",
        crossOrigin: "anonymous",
      },
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
        <style dangerouslySetInnerHTML={{ __html: getGeistFontFaceCss() }} />
      </head>
      <body className="min-h-screen bg-zinc-950 text-zinc-100">
        <Header />
        <main className="animate-in">{children}</main>
        <Scripts />
      </body>
    </html>
  );
}

function Header() {
  return (
    <header className="border-b border-border">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
        <Link
          to="/"
          className="group flex items-center gap-2 font-mono text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-100"
        >
          <span className="inline-block h-2 w-2 rounded-full bg-accent opacity-80 transition-opacity group-hover:opacity-100" />
          shrd.sh
        </Link>
        <a
          href="https://github.com/Stoffberg/shrd.sh"
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-zinc-600 transition-colors hover:text-zinc-400"
        >
          github
        </a>
      </nav>
    </header>
  );
}
