# Self-Hosting shrd.sh

This guide explains how to deploy your own instance of shrd.sh.

## Prerequisites

- Cloudflare account (free tier works)
- Node.js 20+
- pnpm 9+
- Rust 1.75+ (for CLI)
- Wrangler CLI (`npm install -g wrangler`)

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/your-org/shrd.sh
cd shrd.sh
pnpm install
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

### 3. Create Cloudflare Resources

```bash
# Create D1 database
wrangler d1 create shrd-db
# Note the database_id from output

# Create KV namespace
wrangler kv:namespace create CONTENT
# Note the id from output

# Create R2 bucket
wrangler r2 bucket create shrd-storage
```

### 4. Configure the API

```bash
cd apps/api
cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml` with your values:

```toml
name = "shrd-api"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

# Add your custom domain (optional)
# routes = [
#   { pattern = "shrd.yourdomain.com/*", zone_name = "yourdomain.com" }
# ]

[vars]
BASE_URL = "https://shrd.yourdomain.com"  # Your deployment URL

[[kv_namespaces]]
binding = "CONTENT"
id = "YOUR_KV_NAMESPACE_ID"  # From step 3

[[r2_buckets]]
binding = "STORAGE"
bucket_name = "shrd-storage"

[[d1_databases]]
binding = "DB"
database_name = "shrd-db"
database_id = "YOUR_D1_DATABASE_ID"  # From step 3
migrations_dir = "../../packages/db/migrations"
```

### 5. Run Database Migrations

```bash
cd packages/db
pnpm generate  # Generate migration files

cd ../apps/api
wrangler d1 migrations apply shrd-db --remote
```

### 6. Deploy the API

```bash
cd apps/api
wrangler deploy
```

Your API will be available at `https://shrd-api.YOUR_SUBDOMAIN.workers.dev`

### 7. Set Up Custom Domain (Optional)

In the Cloudflare dashboard:
1. Go to your domain's DNS settings
2. Add a CNAME record:
   - Name: `shrd` (or your preferred subdomain)
   - Target: `shrd-api.YOUR_SUBDOMAIN.workers.dev`
   - Proxied: Yes (orange cloud)

### 8. Deploy the Web App (Optional)

```bash
cd apps/web
wrangler deploy
```

## CLI Configuration

### Option 1: Environment Variable

```bash
export SHRD_BASE_URL="https://shrd.yourdomain.com"
shrd <<< "Hello, World!"
```

### Option 2: Config File

```bash
shrd config set-url https://shrd.yourdomain.com
shrd config show
```

### Option 3: Build Custom Binary

Edit `cli/src/main.rs` and change:

```rust
const DEFAULT_BASE_URL: &str = "https://shrd.yourdomain.com";
```

Then build:

```bash
cd cli
cargo build --release
```

## SDK Configuration

### TypeScript/JavaScript

```typescript
import { createClient } from '@shrd/sdk';

const shrd = createClient({
  baseUrl: 'https://shrd.yourdomain.com'
});

const { url } = await shrd.push('Hello, World!');
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BASE_URL` | API base URL (in wrangler.toml) | Required |
| `SHRD_BASE_URL` | CLI override | `https://shrd.stoff.dev` |

## Resource Limits (Cloudflare Free Tier)

| Resource | Limit |
|----------|-------|
| Workers requests | 100,000/day |
| KV reads | 100,000/day |
| KV writes | 1,000/day |
| R2 storage | 10 GB |
| R2 operations | 1,000,000/month |
| D1 reads | 5,000,000/day |
| D1 writes | 100,000/day |

For higher limits, upgrade to Cloudflare Workers Paid ($5/month).

## Customization

### Change ID Length

Edit `apps/api/src/index.ts`:

```typescript
const generateId = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 8); // 8 chars instead of 6
```

### Change Default Expiry

Edit the push handler in `apps/api/src/index.ts` to set a default `expiresIn` value.

### Add Rate Limiting

Cloudflare Workers supports rate limiting via the Rate Limiting API. Add to your worker:

```typescript
// In wrangler.toml
# [[rate_limits]]
# binding = "RATE_LIMITER"

// In your code
const { success } = await env.RATE_LIMITER.limit({ key: clientIP });
if (!success) {
  return c.json({ error: "Rate limited" }, 429);
}
```

## Monitoring

View logs in real-time:

```bash
wrangler tail shrd-api
```

## Troubleshooting

### "KV namespace not found"
Make sure the KV namespace ID in `wrangler.toml` matches the one created.

### "D1 database not found"
Ensure the database_id is correct and migrations have been applied.

### CORS errors
The API includes CORS headers by default. Check that your `BASE_URL` is set correctly.

### Custom domain not working
1. Verify DNS is configured correctly (CNAME with orange cloud)
2. Check the routes in `wrangler.toml`
3. Wait up to 5 minutes for DNS propagation
