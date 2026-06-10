# shrd

[![CI](https://github.com/Stoffberg/shrd.sh/actions/workflows/ci.yml/badge.svg)](https://github.com/Stoffberg/shrd.sh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

`shrd` is a CLI-first file sharing service. Upload bytes from a terminal, get a URL, and download the same bytes somewhere else.

It is intentionally small:

- No accounts.
- No dashboard.
- No browser preview layer.
- One-year expiry by default.
- R2-backed direct and multipart uploads for large files.
- Optional client-side encryption for sensitive payloads.

## Demo

Terminal transcript:

```bash
$ shrd upload ./report.pdf --name quarterly-report
-> https://shrd.stoff.dev/quarterly-report

$ shrd get quarterly-report --output ./downloads/
-> downloads/report.pdf

$ cat secret.env | shrd upload --mode private --expire 1h
-> https://shrd.stoff.dev/7kq4zn#key=...

$ shrd get 7kq4zn#key=... --raw --output -
DATABASE_URL=...
```

The share URL itself serves file bytes as an attachment. `/:id/raw` stays available for scripts and compatibility.

## Why It Exists

Most ad-hoc sharing tools drift into accounts, dashboards, previews, and product surface. `shrd` keeps the useful part: reliable upload and download from the command line.

The implementation is designed to show a few senior engineering choices:

- Keep the hot path small: Workers route to KV or R2 without a UI server.
- Treat large uploads as a first-class path: direct upload first, multipart with resumable manifests past 95 MB.
- Make failure modes recoverable: idempotency keys, retryable CLI requests, delete tokens, and resumable multipart state.
- Avoid pretending text is the only payload: downloads preserve filename and content type where possible.

## Install

Homebrew:

```bash
brew tap Stoffberg/tap
brew install shrd
```

From a fresh clone:

```bash
git clone https://github.com/Stoffberg/shrd.sh
cd shrd.sh
pnpm install --frozen-lockfile
cargo build --manifest-path cli/Cargo.toml --release
```

Run the local binary:

```bash
./cli/target/release/shrd --help
```

## CLI Usage

Upload text, stdin, or a file:

```bash
shrd upload "inline text"
cat deploy.log | shrd upload --expire 1h
shrd upload ./archive.zip --name release-bundle
shrd upload ./large-video.mov
```

Download content:

```bash
shrd get release-bundle --output ./downloads/
shrd get https://shrd.stoff.dev/release-bundle --raw --output -
shrd get last --open
shrd get release-bundle --meta
```

Useful upload flags:

| Flag | Purpose |
| --- | --- |
| `--expire <value>` | Expiry as `Nh`, `Nd`, or `never`; default is `365d`. |
| `--mode temporary` | Preset for short-lived shares; currently `1h`. |
| `--mode private` | Enables client-side encryption. |
| `--mode permanent` | Sets expiry to `never`. |
| `--burn` | Delete after the first successful read. |
| `--encrypt` | Encrypt before upload; key stays in the URL fragment. |
| `--name <slug>` | Stable public slug, 4-64 URL-safe characters. |
| `--json` | Machine-readable upload result. |
| `--resume <manifest>` | Resume an interrupted multipart upload. |

Useful download flags:

| Flag | Purpose |
| --- | --- |
| `--output <path>` | Save to a file, directory, or `-` for stdout. |
| `--raw` | Write exact bytes without decoration. |
| `--open` | Save to a temp file and open with the default app. |
| `--copy` | Copy fetched text to the clipboard. |
| `--meta` | Print metadata JSON instead of downloading content. |

Local history is stored on the client so `shrd get last`, `shrd list`, and `shrd search <term>` work without an account.

## API

The public API is deliberately narrow.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health check. |
| `POST` | `/api/v1/push` | Compatibility path for JSON text uploads. |
| `POST` | `/api/v1/upload` | Direct binary upload. |
| `GET` | `/:id` | Download file bytes as an attachment. |
| `GET` | `/:id/raw` | Download raw file bytes. |
| `GET` | `/:id/meta` | Metadata needed by CLI download/decryption flows. |
| `DELETE` | `/api/v1/:id` | Delete with `Authorization: Bearer <deleteToken>`. |

Direct upload:

```bash
curl -X POST https://shrd.stoff.dev/api/v1/upload \
  -H "X-Filename: report.pdf" \
  -H "X-Content-Type: application/pdf" \
  -H "X-Expire: 365d" \
  --data-binary @report.pdf
```

Response:

```json
{
  "id": "x7k2mz",
  "url": "https://shrd.stoff.dev/x7k2mz",
  "rawUrl": "https://shrd.stoff.dev/x7k2mz/raw",
  "deleteUrl": "https://shrd.stoff.dev/api/v1/x7k2mz",
  "deleteToken": "7hf...",
  "expiresAt": "2027-06-10T12:00:00.000Z",
  "name": null
}
```

Multipart upload is used by the CLI for files over 95 MB:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/multipart/init` | Create resumable upload session. |
| `GET` | `/api/v1/multipart/:id/status` | Check uploaded parts. |
| `PUT` | `/api/v1/multipart/:id/part/:partNumber` | Upload one 50 MB part. |
| `POST` | `/api/v1/multipart/:id/complete` | Complete the R2 multipart upload. |
| `DELETE` | `/api/v1/multipart/:id` | Abort a multipart session. |

Names must match `^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$`. `api` and `health` are reserved. Duplicate names return `409`.

## SDK

```bash
pnpm add @shrd/sdk
```

```ts
import { shrd } from "@shrd/sdk"

const uploaded = await shrd.upload(file, {
  filename: "report.pdf",
  contentType: "application/pdf",
  expire: "365d",
})

const response = await shrd.download(uploaded.id)
const bytes = await response.arrayBuffer()
```

Available methods:

| Method | Purpose |
| --- | --- |
| `push(content, options)` | Text compatibility upload. |
| `upload(body, options)` | Binary upload through `/api/v1/upload`. |
| `download(idOrUrl)` | Returns the `Response` for file bytes. |
| `pull(idOrUrl)` | Text convenience wrapper around `download`. |
| `createClient({ baseUrl })` | Use a self-hosted API. |

## Architecture

```text
CLI / SDK
   |
   |  upload, multipart, download, metadata
   v
Cloudflare Worker API (Hono)
   |
   +-- KV: small inline bodies and compatibility metadata
   +-- R2: direct uploads and multipart objects
   +-- D1: canonical metadata, delete tokens, idempotency, multipart state
```

Read path:

1. Worker resolves metadata from D1 or the KV compatibility record.
2. Small inline content streams from metadata/KV.
3. File content streams from R2.
4. Response includes `Content-Type`, `Content-Disposition`, and cache headers.

Write path:

1. CLI chooses text, direct upload, or multipart based on input size.
2. API validates expiry/name/idempotency.
3. Content lands in KV or R2.
4. Metadata records filename, content type, encryption, expiry, size, and delete token.

## Tech Decisions

| Decision | Rationale |
| --- | --- |
| Rust CLI | Fast startup, single binary distribution, reliable streaming for large files. |
| Cloudflare Workers | Low-latency global API with simple deployment and cheap scale. |
| R2 for files | Large object storage without egress fees. |
| KV for tiny content | Cheap, fast reads for small text compatibility uploads. |
| D1 for metadata | SQL constraints and durable state for idempotency, names, multipart sessions, and deletes. |
| No web app | The product is file transfer. Browser rendering is intentionally out of scope. |

## Development

Fresh clone:

```bash
pnpm install --frozen-lockfile
pnpm ci:full
pnpm --filter @shrd/api test:integration
```

Production smoke check:

```bash
SHRD_API_URL=https://shrd.stoff.dev node scripts/smoke-prod.mjs
```

Useful focused commands:

```bash
pnpm --filter @shrd/api test:unit
pnpm --filter @shrd/api test:compat
pnpm --filter @shrd/api test:e2e
cargo test --manifest-path cli/Cargo.toml --locked
cargo fmt --manifest-path cli/Cargo.toml -- --check
```

Run the API locally:

```bash
pnpm --filter @shrd/api dev
```

Point the CLI at a local or self-hosted API:

```bash
SHRD_BASE_URL=http://127.0.0.1:8787 cargo run --manifest-path cli/Cargo.toml -- upload ./README.md
shrd config set-url https://shrd.example.com
```

## Self-Hosting

Create Cloudflare resources:

```bash
wrangler d1 create shrd-db
wrangler kv:namespace create CONTENT
wrangler r2 bucket create shrd-storage
```

Copy and edit the Worker config:

```bash
cp apps/api/wrangler.toml.example apps/api/wrangler.toml
```

Apply migrations and deploy:

```bash
cd apps/api
wrangler d1 migrations apply shrd-db --remote
wrangler deploy
```

## Security Model

Encrypted uploads use AES-256-GCM locally before bytes leave the client. The key is placed in the URL fragment, so the API never receives it. Without that fragment, the server only has encrypted bytes.

Delete tokens are returned once at upload time. Anyone with the token can delete the share; without it, shares expire naturally.

## License

MIT
