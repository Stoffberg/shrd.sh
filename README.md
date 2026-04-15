# shrd

[![CI](https://github.com/Stoffberg/shrd.sh/actions/workflows/ci.yml/badge.svg)](https://github.com/Stoffberg/shrd.sh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Share anything from your terminal. Instantly.**

```bash
echo "Hello, World!" | shrd
# => https://shrd.stoff.dev/x7k2m

shrd x7k2m
# => Hello, World!
```

No accounts. No config. Just pipe and go.

## Install

```bash
brew tap Stoffberg/tap && brew install shrd
```

<details>
<summary>Other installation methods</summary>

**From source (Rust)**
```bash
cargo install shrd
```

**Direct download**

Grab the latest binary from [Releases](https://github.com/Stoffberg/shrd.sh/releases).

</details>

## Usage

```bash
# Pipe anything
cat config.yaml | shrd
git diff | shrd
docker logs api | shrd

# Share a file (auto-detected from path)
shrd ./report.pdf

# Share clipboard
shrd -c

# Set expiry
echo "secret" | shrd -x 1h

# Burn after reading
echo "password123" | shrd -b

# End-to-end encrypt (key in URL fragment)
cat secrets.txt | shrd -e

# Product modes
echo "draft" | shrd --mode temporary    # defaults to 1h expiry
echo "logs" | shrd --mode private       # forces encryption
echo "readme" | shrd --mode permanent   # never expires
```

**Retrieve content**
```bash
shrd x7k2m              # by ID or URL
shrd get x7k2m          # explicit get subcommand
shrd get last            # most recent share from local history
shrd x7k2m --meta       # view metadata
```

### Subcommands

The CLI is positional first: `shrd <input>` auto-detects whether you're sharing or retrieving. Explicit subcommands are also available.

**`upload`** shares content (same as positional upload).
```bash
shrd upload "inline text"
shrd upload ./image.png --name screenshot --expire 7d
shrd upload --clipboard --burn
shrd upload --resume ./manifest.json    # resume interrupted multipart
```

**`get`** retrieves a share.
```bash
shrd get x7k2m                  # print to stdout
shrd get x7k2m --raw            # exact bytes, no decoration
shrd get x7k2m -o ./output.txt  # save to file
shrd get x7k2m -o ./downloads/  # save to directory (uses original filename)
shrd get x7k2m --open           # open in default app
shrd get x7k2m --copy           # copy text to clipboard
shrd get x7k2m --meta           # JSON metadata only
```

**`list`** (alias: `recent`) shows local upload history.
```bash
shrd list                       # last 10 shares
shrd recent -l 20               # last 20 shares
shrd list --json                # full history as JSON
shrd list --copy                # copy newest share URL to clipboard
shrd list --name my-config      # filter by custom name
shrd list --mode encrypted      # filter by mode
shrd list --type image          # filter by content kind
shrd list --source clipboard    # filter by upload source
shrd list --age 2d              # shares from the last 2 days
```

**`search`** fuzzy-searches local history.
```bash
shrd search "docker"            # matches id, name, filename, url, source
```

**`config`** manages CLI settings.
```bash
shrd config show                # print base URL, config dir, recent count
shrd config show --json         # same as JSON
shrd config set-url https://your-instance.com
shrd config reset               # remove config.json

# AI skill management (Cursor, Codex, Claude Code, OpenCode)
shrd config ai status
shrd config ai install          # install shrd skill for all tools
shrd config ai install cursor   # install for a specific tool
shrd config ai remove
shrd config ai presets
```

### Upload flags

| Flag | Description |
|------|-------------|
| `-x, --expire` | Expiry: `1h`, `24h`, `7d`, `30d`, `never` |
| `-b, --burn` | Delete after first view |
| `-e, --encrypt` | End-to-end encrypt (zero-knowledge) |
| `-n, --name` | Custom slug (alphanumeric, 4-64 chars) |
| `--mode` | Product preset: `temporary`, `private`, `permanent` |
| `-c, --clipboard` | Share clipboard contents |
| `-j, --json` | JSON output |
| `-q, --quiet` | Suppress output except errors |
| `--no-copy` | Don't copy URL to clipboard after upload |
| `--resume` | Resume a multipart upload from manifest path |

### Get flags

| Flag | Description |
|------|-------------|
| `--meta` | Fetch JSON metadata only |
| `--raw` | Write exact bytes to stdout |
| `-o, --output` | Save to file, directory, or `-` for stdout |
| `--open` | Save to temp file and open with default app |
| `--copy` | Copy text content to clipboard |
| `-q, --quiet` | Suppress non-error output |

### List flags

| Flag | Description |
|------|-------------|
| `-l, --limit` | Max rows (default 10) |
| `--copy` | Copy newest matching share URL to clipboard |
| `-j, --json` | JSON output |
| `--name` | Filter by exact share name |
| `--mode` | Filter by mode: `temporary`, `private`, `permanent`, `default`, `encrypted` |
| `--type` | Filter by kind: `text`, `json`, `markdown`, `image`, `audio`, `video`, `binary` |
| `--source` | Filter by source: `inline`, `stdin`, `clipboard`, `path` |
| `--age` | Max age: `Nm`, `Nh`, `Nd` |
| `--query` | Fuzzy search (used internally by `search`) |

### Environment

| Variable | Description |
|----------|-------------|
| `SHRD_BASE_URL` | Override API base URL (takes precedence over config) |

## Security

With the `-e` flag, content is **end-to-end encrypted** using AES-256-GCM before leaving your machine.

- Encryption key is generated locally and never sent to the server
- Key is embedded in the URL fragment (`#key=...`) which browsers don't send to servers
- The server stores only encrypted blobs; it cannot read your content
- Even the operator cannot access your data

This is a zero-knowledge architecture: your secrets stay secret.

## API

```bash
# Push text
curl -X POST https://shrd.stoff.dev/api/v1/push \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello!", "expire": "24h"}'

# Direct file upload
curl -X POST https://shrd.stoff.dev/api/v1/upload \
  -H "X-Filename: report.pdf" \
  -H "X-Content-Type: application/pdf" \
  -H "X-Expire: 7d" \
  --data-binary @report.pdf

# Retrieve raw content
curl https://shrd.stoff.dev/x7k2m/raw

# Retrieve metadata
curl https://shrd.stoff.dev/x7k2m/meta

# Delete
curl -X DELETE https://shrd.stoff.dev/api/v1/x7k2m \
  -H "Authorization: Bearer <delete-token>"
```

<details>
<summary>Full API reference</summary>

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/v1/push` | Create share from JSON body |
| POST | `/api/v1/upload` | Create share from raw binary body |
| GET | `/:id` | Retrieve content (HTML or raw based on `Accept` header) |
| GET | `/:id/raw` | Retrieve raw content |
| GET | `/:id/meta` | Retrieve share metadata |
| DELETE | `/api/v1/:id` | Delete share (requires `Authorization: Bearer <token>`) |

### Multipart upload (files > 95 MB)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/multipart/init` | Initialize multipart session |
| GET | `/api/v1/multipart/:id/status` | Check upload progress |
| PUT | `/api/v1/multipart/:id/part/:partNumber` | Upload a part (50 MB each) |
| POST | `/api/v1/multipart/:id/complete` | Finalize upload |
| DELETE | `/api/v1/multipart/:id` | Abort upload |

### Stats

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/stats/summary?window=24h` | Upload/read/error counts |
| GET | `/api/v1/stats/content-types?window=24h&limit=10` | Top content types |
| GET | `/api/v1/stats/storage` | Storage usage snapshots |

### Push request body

```json
{
  "content": "string (required)",
  "contentType": "text/plain",
  "filename": "notes.txt",
  "expire": "24h",
  "burn": false,
  "name": "my-slug",
  "encrypted": false
}
```

`expire` accepts `Nh`, `Nd`, or `never`. Invalid values return `400`.

### Push response (201)

```json
{
  "id": "x7k2m",
  "url": "https://shrd.stoff.dev/x7k2m",
  "rawUrl": "https://shrd.stoff.dev/x7k2m/raw",
  "deleteUrl": "https://shrd.stoff.dev/api/v1/x7k2m",
  "deleteToken": "tok_...",
  "expiresAt": "2025-01-02T00:00:00Z",
  "name": null
}

```

### Upload headers

| Header | Description |
|--------|-------------|
| `X-Content-Type` | MIME type (default `application/octet-stream`) |
| `X-Filename` | Original filename |
| `X-Expire` | Expiry string |
| `X-Burn` | `true` or `false` |
| `X-Name` | Custom slug |
| `X-Encrypted` | `true` or `false` |
| `X-Idempotency-Key` | Idempotency key (supported on push, upload, multipart init/complete) |

### Metadata response

```json
{
  "id": "x7k2m",
  "contentType": "text/plain",
  "size": 1234,
  "createdAt": "2025-01-01T00:00:00Z",
  "expiresAt": "2025-01-02T00:00:00Z",
  "views": 3,
  "burn": false,
  "name": null,
  "filename": null,
  "storageType": "kv",
  "encrypted": false
}
```

### Custom names

Names must match `^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$`. Reserved: `api`, `health`. Duplicates return `409`.

</details>

## SDK

```bash
npm install @shrd/sdk
```

```typescript
import { shrd } from '@shrd/sdk'

const { url } = await shrd.push('Hello!')
const content = await shrd.pull('x7k2m')
const info = await shrd.meta('x7k2m')
await shrd.delete('x7k2m', deleteToken)
```

<details>
<summary>Full SDK reference</summary>

### Custom instance

```typescript
import { createClient } from '@shrd/sdk'

const client = createClient({ baseUrl: 'https://your-instance.com' })
```

The base URL can also be set via the `SHRD_BASE_URL` environment variable.

### Methods

**`push(content, options?)`** creates a share and returns `PushResult`.

```typescript
const result = await shrd.push('secret config', {
  expire: '1h',
  burn: true,
  name: 'my-config',
  encrypt: true,
  contentType: 'text/yaml',
  filename: 'config.yaml',
})
// result: { id, url, rawUrl, raw, deleteUrl, deleteToken, expiresAt, name }
```

**`pull(id)`** retrieves raw content as a string.

```typescript
const content = await shrd.pull('x7k2m')
```

**`meta(id)`** returns share metadata.

```typescript
const info = await shrd.meta('x7k2m')
// info: { id, contentType, size, views, createdAt, expiresAt, filename, encrypted, name, storageType }
```

**`delete(id, deleteToken)`** deletes a share.

```typescript
await shrd.delete('x7k2m', 'tok_...')
```

All methods accept a bare ID or a full URL.

### Types

```typescript
type ExpireDuration = `${number}h` | `${number}d` | 'never'

interface PushOptions {
  contentType?: string
  filename?: string
  expire?: ExpireDuration
  name?: string
  burn?: boolean
  encrypt?: boolean
}

interface PushResult {
  id: string
  url: string
  rawUrl: string
  raw: string
  deleteUrl: string
  deleteToken: string
  expiresAt: string | null
  name: string | null
}

interface ShareMetadata {
  id: string
  contentType: string
  size: number
  views: number
  createdAt: string
  expiresAt: string | null
  filename: string | null
  encrypted: boolean
  name: string | null
  storageType: 'kv' | 'r2'
}
```

</details>

<details>
<summary>Self-hosting</summary>

Deploy your own instance on Cloudflare Workers (free tier works fine).

```bash
git clone https://github.com/Stoffberg/shrd.sh && cd shrd.sh
pnpm install

# Create resources
wrangler d1 create shrd-db
wrangler kv:namespace create CONTENT
wrangler r2 bucket create shrd-storage

# Update wrangler.toml with your resource IDs, then:
cd apps/api
wrangler d1 migrations apply shrd-db --remote
wrangler deploy
```

Point your CLI to your instance:
```bash
shrd config set-url https://your-domain.com
```

</details>

<details>
<summary>Architecture</summary>

- **API**: Cloudflare Workers + Hono
- **Storage**: KV for small content (<25 KB), R2 for larger files and multipart uploads
- **Database**: D1 (SQLite at edge)
- **CLI**: Rust
- **SDK**: TypeScript

Content is cached at the edge with `immutable` cache headers. Reads are ~50ms globally. Files over 95 MB use R2 multipart upload with 50 MB parts and resumable manifests.

</details>

<details>
<summary>Development</summary>

```bash
pnpm install
pnpm dev          # Start API locally
pnpm test         # Run tests

cd cli
cargo build       # Build CLI
cargo test        # Test CLI
```

</details>

## License

MIT
