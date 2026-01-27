# shrd

[![CI](https://github.com/Stoffberg/shrd.sh/actions/workflows/ci.yml/badge.svg)](https://github.com/Stoffberg/shrd.sh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Share anything from your terminal. Instantly. End-to-end encrypted.**

```bash
echo "Hello, World!" | shrd
# => https://shrd.stoff.dev/x7k2m#key=...

shrd x7k2m#key=...
# => Hello, World!
```

No accounts. No config. Zero-knowledge encryption. Just pipe and go.

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

# Share clipboard
shrd -c

# Set expiry
echo "secret" | shrd -x 1h

# Burn after reading
echo "password123" | shrd -b
```

**Retrieve content**
```bash
shrd x7k2m#key=...      # by ID (key in URL fragment)
shrd x7k2m#key=... | jq # pipe to tools
shrd x7k2m --meta       # view metadata
```

| Flag | Description |
|------|-------------|
| `-x, --expire` | Expiry: `1h`, `24h`, `7d`, `30d`, `never` |
| `-b, --burn` | Delete after first view |
| `-n, --name` | Custom slug |
| `-c, --clipboard` | Share clipboard contents |
| `-j, --json` | JSON output |
| `-q, --quiet` | Quiet mode |

## Security

All content is **end-to-end encrypted** using AES-256-GCM before leaving your machine.

- Encryption key is generated locally and never sent to the server
- Key is embedded in the URL fragment (`#key=...`) which browsers don't send to servers
- The server stores only encrypted blobs - it cannot read your content
- Even the operator cannot access your data

This is a zero-knowledge architecture: your secrets stay secret.

## API

```bash
# Create
curl -X POST https://shrd.stoff.dev/api/v1/push \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello!"}'

# Retrieve
curl https://shrd.stoff.dev/x7k2m

# Delete
curl -X DELETE https://shrd.stoff.dev/api/v1/x7k2m \
  -H "Authorization: Bearer <delete-token>"
```

## SDK

```bash
npm install @shrd/sdk
```

```typescript
import { shrd } from '@shrd/sdk'

const { url } = await shrd.push('Hello!')
const content = await shrd.pull('x7k2m')
```

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
shrd config set api-url https://your-domain.com
```

</details>

<details>
<summary>Architecture</summary>

- **API**: Cloudflare Workers + Hono
- **Storage**: KV for small content (<25KB), R2 for larger files
- **Database**: D1 (SQLite at edge) for user accounts
- **CLI**: Rust
- **SDK**: TypeScript

Content is cached at the edge with `immutable` cache headers. Reads are ~50ms globally.

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
