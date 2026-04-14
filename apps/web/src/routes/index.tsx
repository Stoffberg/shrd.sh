import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16">
      <section className="py-16 text-center">
        <h1 className="text-5xl font-bold tracking-tight text-zinc-100">
          Share anything, instantly
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400">
          CLI-first content sharing for developers. Paste code, share files,
          collaborate fast. Default to temporary, keep the good stuff around when it matters.
        </p>
        <div className="mt-10 flex justify-center gap-4">
          <a
            href="#install"
            className="rounded-lg bg-emerald-600 px-6 py-3 font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Get Started
          </a>
          <a
            href="https://github.com/shrdsh/cli"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-zinc-700 px-6 py-3 font-medium text-zinc-300 transition-colors hover:border-zinc-600 hover:text-zinc-100"
          >
            View on GitHub
          </a>
        </div>
      </section>

      <section id="install" className="py-16">
        <h2 className="mb-8 text-center text-2xl font-semibold text-zinc-100">
          Quick Start
        </h2>
        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
          <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
            <div className="h-3 w-3 rounded-full bg-zinc-700" />
            <div className="h-3 w-3 rounded-full bg-zinc-700" />
            <div className="h-3 w-3 rounded-full bg-zinc-700" />
            <span className="ml-2 font-mono text-xs text-zinc-500">
              terminal
            </span>
          </div>
          <pre className="overflow-x-auto p-6 font-mono text-sm leading-relaxed">
            <code className="text-zinc-300">
              <span className="text-zinc-500"># Install the CLI</span>
              {"\n"}
              <span className="text-emerald-400">$</span> brew tap Stoffberg/tap && brew install shrd
              {"\n\n"}
              <span className="text-zinc-500"># Share a file</span>
              {"\n"}
              <span className="text-emerald-400">$</span> shrd upload ./secret.txt
              {"\n"}
              <span className="text-zinc-500">→</span> https://shrd.sh/abc123
              {"\n\n"}
              <span className="text-zinc-500"># Keep it forever</span>
              {"\n"}
              <span className="text-emerald-400">$</span> shrd --mode permanent --name runbook ./docs.md
              {"\n"}
              <span className="text-zinc-500">→</span> https://shrd.sh/runbook
              {"\n\n"}
              <span className="text-zinc-500"># Pipe from stdin</span>
              {"\n"}
              <span className="text-emerald-400">$</span> cat logs.txt | shrd
              {"\n"}
              <span className="text-zinc-500">→</span> https://shrd.sh/xyz789
              {"\n\n"}
              <span className="text-zinc-500"># Temporary private drop</span>
              {"\n"}
              <span className="text-emerald-400">$</span> shrd --mode temporary -e ./data.json
              {"\n\n"}
              <span className="text-zinc-500"># Recall the last share</span>
              {"\n"}
              <span className="text-emerald-400">$</span> shrd list
              {"\n"}
              <span className="text-emerald-400">$</span> shrd get last
            </code>
          </pre>
        </div>
      </section>

      <section className="py-16">
        <h2 className="mb-12 text-center text-2xl font-semibold text-zinc-100">
          Built for developers
        </h2>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <FeatureCard
            title="CLI-first"
            description="Designed for the terminal. Pipe, redirect, script. No browser required."
          />
          <FeatureCard
            title="Fast"
            description="Edge-deployed globally. Sub-100ms uploads from anywhere."
          />
          <FeatureCard
            title="Private"
            description="End-to-end encryption optional. Retention is configurable, including never."
          />
          <FeatureCard
            title="Recallable"
            description="Local recent-share history means yesterday's link is still one command away."
          />
          <FeatureCard
            title="Syntax Highlighting"
            description="50+ languages supported. Code looks beautiful."
          />
          <FeatureCard
            title="Keyboard-first"
            description="Navigate with j/k, copy with c, download with d."
          />
          <FeatureCard
            title="API Access"
            description="Full REST API. Integrate with your tools and workflows."
          />
        </div>
      </section>
    </div>
  );
}

function FeatureCard({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
      <h3 className="font-semibold text-zinc-100">{title}</h3>
      <p className="mt-2 text-sm text-zinc-400">{description}</p>
    </div>
  );
}
