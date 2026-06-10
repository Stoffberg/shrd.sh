# Contributing

`shrd` is a CLI and API for reliable file upload and download. Browser preview, accounts, dashboards, and hosted web UI work are out of scope.

## Setup

```bash
pnpm install --frozen-lockfile
cargo build --manifest-path cli/Cargo.toml --release
```

## Checks

```bash
pnpm build
pnpm ci:full
pnpm --filter @shrd/api test:integration
```

`pnpm ci:full` runs TypeScript checks, Rust fmt/clippy, API unit/compat/e2e tests, CLI tests, and the Worker dry-run build.

## Layout

```text
apps/api/          Cloudflare Worker API
cli/               Rust CLI
packages/db/       D1 schema and migrations
packages/sdk/      TypeScript SDK
packages/shared/   Shared IDs and types
```

Keep changes inside the frozen product contract: upload a file, share a URL, download it somewhere else.
