# shrd.sh

[![CI](https://github.com/stoffee/shrd.sh/actions/workflows/ci.yml/badge.svg)](https://github.com/stoffee/shrd.sh/actions/workflows/ci.yml)
[![Deploy](https://github.com/stoffee/shrd.sh/actions/workflows/deploy.yml/badge.svg)](https://github.com/stoffee/shrd.sh/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Unix gave us `|` for local pipes. `shrd` makes pipes work across the network.

**shrd** is the simplest way to share content between machines, people, and AI agents. One command to share. One command to retrieve. No accounts, no friction, instant.

```bash
# Share anything
echo "Hello, World!" | shrd
→ https://shrd.sh/x7k2m

# Retrieve it anywhere
shrd x7k2m
→ Hello, World!
```

## Features

- **CLI-first** — Designed for the terminal. Pipe, redirect, script.
- **Fast** — Edge-deployed on Cloudflare's global network. Sub-100ms responses.
- **Private** — Content auto-expires. E2E encryption available.
- **No account required** — Just install and go.
- **AI-ready** — Full REST API, TypeScript SDK, MCP server.

## Installation

### macOS / Linux (Homebrew)

```bash
brew install stoffee/tap/shrd
```

### Cargo (Rust)

```bash
cargo install shrd
```

### Direct Download

Download the latest binary from [Releases](https://github.com/stoffee/shrd.sh/releases).

### npm (wrapper)

```bash
npx @shrd/cli
```

## Usage

### Share Content

```bash
# From stdin
cat file.txt | shrd

# From file
shrd ./config.yaml

# From clipboard
shrd -c

# With options
echo "secret" | shrd --expire 1h --burn
```

### Retrieve Content

```bash
# By ID
shrd x7k2m

# Full URL works too
shrd https://shrd.sh/x7k2m

# Pipe to other commands
shrd x7k2m | jq '.data'

# Get metadata
shrd x7k2m --meta
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--expire` | `-x` | Expiry time (1h, 24h, 7d, 30d) |
| `--burn` | `-b` | Delete after first view |
| `--encrypt` | `-e` | End-to-end encrypt |
| `--name` | `-n` | Custom slug |
| `--json` | `-j` | Output as JSON |
| `--quiet` | `-q` | Suppress output |
| `--meta` | | Get metadata only |

## SDK

### TypeScript / JavaScript

```bash
npm install @shrd/sdk
```

```typescript
import { shrd } from '@shrd/sdk';

// Push
const { url } = await shrd.push('Hello, World!');
console.log(url); // https://shrd.sh/x7k2m

// Pull
const content = await shrd.pull('x7k2m');

// With options
const result = await shrd.push(data, {
  expire: '7d',
  type: 'json'
});
```

### Self-hosted

```typescript
import { createClient } from '@shrd/sdk';

const shrd = createClient({
  baseUrl: 'https://shrd.yourdomain.com'
});
```

## API

### Create Share

```bash
curl -X POST https://shrd.sh/api/v1/push \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello, World!"}'
```

Response:
```json
{
  "id": "x7k2m",
  "url": "https://shrd.sh/x7k2m",
  "rawUrl": "https://shrd.sh/x7k2m/raw",
  "deleteToken": "dt_xxx",
  "expiresAt": "2026-01-26T12:00:00Z"
}
```

### Retrieve Share

```bash
# Raw content
curl https://shrd.sh/x7k2m/raw

# Metadata
curl https://shrd.sh/x7k2m/meta
```

### Delete Share

```bash
curl -X DELETE https://shrd.sh/api/v1/x7k2m \
  -H "Authorization: Bearer dt_xxx"
```

## Self-Hosting

shrd is designed to be easily self-hosted on Cloudflare Workers.

See [SELF_HOSTING.md](SELF_HOSTING.md) for complete instructions.

### Quick Start

```bash
# Clone
git clone https://github.com/stoffee/shrd.sh
cd shrd.sh
pnpm install

# Create Cloudflare resources
wrangler d1 create shrd-db
wrangler kv:namespace create CONTENT
wrangler r2 bucket create shrd-storage

# Configure
cp apps/api/wrangler.toml.example apps/api/wrangler.toml
# Edit wrangler.toml with your IDs

# Deploy
cd apps/api
wrangler d1 migrations apply shrd-db --remote
wrangler deploy
```

### CLI Configuration

```bash
# Set your instance URL
shrd config set-url https://shrd.yourdomain.com

# Verify
shrd config show
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Cloudflare Edge                        │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │ Worker   │  │ Worker   │  │ Worker   │   300+ PoPs  │
│  │ (US)     │  │ (EU)     │  │ (APAC)   │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
│       └─────────────┴─────────────┘                     │
│                     │                                    │
│       ┌─────────────┼─────────────┐                     │
│       ▼             ▼             ▼                     │
│   ┌───────┐    ┌───────┐    ┌───────┐                  │
│   │  KV   │    │  R2   │    │  D1   │                  │
│   │<25KB  │    │ Large │    │ Users │                  │
│   └───────┘    └───────┘    └───────┘                  │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
shrd.sh/
├── apps/
│   ├── api/          # Cloudflare Worker (Hono)
│   └── web/          # Web frontend (TanStack Start)
├── packages/
│   ├── shared/       # Shared types & utils
│   ├── db/           # D1 schema (Drizzle)
│   └── sdk/          # TypeScript SDK
├── cli/              # Rust CLI
└── tests/            # Integration tests
```

## Development

```bash
# Install dependencies
pnpm install

# Start API locally
cd apps/api && pnpm dev

# Start web locally
cd apps/web && pnpm dev

# Build CLI
cd cli && cargo build

# Run tests
./tests/integration.sh
```

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting a PR.

## License

MIT License - see [LICENSE](LICENSE) for details.

---

<p align="center">
  <sub>Built with Cloudflare Workers, Hono, and Rust</sub>
</p>
