import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-24 text-center">
      <h1 className="font-mono text-2xl font-medium text-zinc-200">shrd.sh</h1>
      <p className="mt-3 text-sm text-zinc-500">
        CLI-first content sharing. Fast, private, ephemeral.
      </p>
      <div className="mt-8 mx-auto max-w-md overflow-hidden rounded-lg border border-border bg-surface">
        <pre className="p-5 text-left font-mono text-[13px] leading-relaxed text-zinc-400">
          <span className="text-zinc-600">$</span> brew tap Stoffberg/tap && brew install shrd{"\n"}
          <span className="text-zinc-600">$</span> echo "hello" | shrd{"\n"}
          <span className="text-accent/70">https://shrd.sh/abc123</span>
        </pre>
      </div>
      <a
        href="https://github.com/Stoffberg/shrd.sh"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-8 inline-block font-mono text-xs text-zinc-600 transition-colors hover:text-zinc-400"
      >
        github.com/Stoffberg/shrd.sh
      </a>
    </div>
  );
}
