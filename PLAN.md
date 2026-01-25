# shrd.sh Monorepo - Implementation Plan

> Last updated: 2026-01-25
> Status: API DEPLOYED & WORKING - WEB APP NEEDS DEBUGGING

## Current Deployment Status

| Component | Status | URL |
|-----------|--------|-----|
| API Worker | WORKING | https://shrd-api.plutocrat.workers.dev |
| Custom Domain | CONFIGURED | shrd.stoff.dev (needs DNS setup) |
| Web App | DEPLOYED (500 error) | https://shrd-web.plutocrat.workers.dev |
| D1 Database | CREATED | shrd-db (9122485c-f107-4333-ad96-f3fd9873ae35) |
| KV Namespace | CREATED | CONTENT (3e59e9713df94c83950548e5ccc46faa) |
| R2 Bucket | CREATED | shrd-storage |

### API Test
```bash
# Create a share
curl -X POST https://shrd-api.plutocrat.workers.dev/api/v1/push \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello from shrd!"}'

# Retrieve it
curl https://shrd-api.plutocrat.workers.dev/{id}/raw
```

### DNS Setup Required
Add a CNAME record in Cloudflare for stoff.dev:
- Name: shrd
- Target: shrd-api.plutocrat.workers.dev
- Proxied: Yes (orange cloud)

## Quick Context

shrd.sh is a CLI-first content sharing tool - "a URL shortener for any content". Users pipe content to `shrd` and get a shareable URL. Think pastebin meets Unix philosophy.

**Temporary domain**: `shrd.stoff.dev` (until shrd.sh is purchased)

## Architecture Decisions

### 1. Auth: Better Auth (Decision Made)

**Chosen**: Better Auth over WorkOS

**Reasoning**:
- Open source, no vendor lock-in
- Self-hostable, fits Cloudflare Workers
- Simpler for initial launch
- Free tier friendly
- WorkOS is overkill for MVP (enterprise SSO not needed yet)
- Can migrate to WorkOS later for Team tier SSO

### 2. Monorepo Structure: pnpm + Turborepo

```
shrd.sh/
├── apps/
│   ├── api/           # Cloudflare Worker (Hono)
│   └── web/           # TanStack Start on Cloudflare Pages
├── packages/
│   ├── shared/        # Shared types, utils
│   ├── db/            # D1 schema + Drizzle
│   └── sdk/           # TypeScript SDK (@shrd/sdk)
├── cli/               # Rust CLI (separate build)
├── turbo.json
├── pnpm-workspace.yaml
└── PLAN.md            # This file
```

### 3. Tech Stack

| Component | Technology | Why |
|-----------|------------|-----|
| API | Hono on Cloudflare Workers | Fast, lightweight, edge-native |
| Web | TanStack Start on Cloudflare Pages | Modern, Vinxi-based, native CF support |
| Database | D1 + Drizzle ORM | SQLite at edge, type-safe |
| KV | Cloudflare KV | Fast reads for small content |
| Storage | Cloudflare R2 | Large files, $0 egress |
| Auth | Better Auth | Open source, Cloudflare-compatible |
| CLI | Rust | Single binary, fast startup |

### 4. Performance Strategy (Billions of invocations, <30ms)

**Read Path (most common)**:
1. Request hits nearest Cloudflare edge (300+ PoPs)
2. Worker checks KV cache first (10-50ms globally)
3. If miss, check R2 (slightly slower but still fast)
4. No database hit for content reads

**Write Path**:
1. Generate short ID (nanoid, 6 chars = 56B combinations)
2. Store in KV for small content (<25KB)
3. Store in R2 for large content
4. Async write to D1 for user history (non-blocking)

**Key optimizations**:
- Content stored in KV/R2 with TTL matching expiry
- No D1 queries on hot path (read/write content)
- D1 only for auth, user data, analytics
- Rate limiting via Cloudflare's built-in

### 5. ID Generation

Using nanoid with custom alphabet (URL-safe, no ambiguous chars):
- Alphabet: `23456789abcdefghjkmnpqrstuvwxyz` (32 chars, no 0/1/i/l/o)
- Length: 6 chars = 1 billion combinations
- Collision check on write (retry with new ID)

## Implementation Checkpoints

### Checkpoint 1: Monorepo Setup [DONE]
- [x] Create directory structure
- [x] Initialize pnpm workspace (pnpm-workspace.yaml)
- [x] Configure Turborepo (turbo.json)
- [x] Set up TypeScript configs (tsconfig.base.json)
- [x] Add shared package (@shrd/shared)

### Checkpoint 2: API Worker [DONE]
- [x] Create Hono app (apps/api/src/index.ts)
- [x] Implement POST /api/v1/push
- [x] Implement GET /:id (content retrieval)
- [x] Implement GET /:id/raw
- [x] Implement GET /:id/meta
- [x] Implement DELETE /api/v1/:id
- [x] Storage helpers for KV/R2 (apps/api/src/storage.ts)
- [x] Better Auth setup (apps/api/src/auth.ts)
- [x] Add wrangler.toml with bindings

### Checkpoint 3: Database [DONE]
- [x] Define Drizzle schema (packages/db/src/schema.ts)
  - users, sessions, accounts, verifications (Better Auth)
  - shares, collections, collectionItems, apiKeys (App)
- [x] Configure drizzle-kit (packages/db/drizzle.config.ts)
- [ ] Create D1 database via wrangler (DEPLOYMENT STEP)
- [ ] Generate and apply migrations (DEPLOYMENT STEP)

### Checkpoint 4: Web App [DONE]
- [x] Create TanStack Start app
- [x] Configure for Cloudflare Pages (vite.config.ts, wrangler.jsonc)
- [x] Add Better Auth client (app/lib/auth-client.ts)
- [x] Create share viewer page (app/routes/$id.tsx)
- [x] Add syntax highlighting (shiki)
- [x] Create dashboard layout (app/routes/dashboard.tsx)
- [x] Landing page (app/routes/index.tsx)
- [x] Root layout with dark mode (app/routes/__root.tsx)

### Checkpoint 5: CLI [DONE]
- [x] Create Rust project (cli/Cargo.toml)
- [x] Add clap for CLI parsing
- [x] Implement push command
- [x] Implement pull command
- [x] Add clipboard support (optional feature)
- [x] Login/logout/whoami commands

### Checkpoint 6: SDK [DONE]
- [x] Create TypeScript SDK (@shrd/sdk)
- [x] push(), pull(), meta(), delete() functions
- [x] createClient() for custom config

### Checkpoint 7: Deployment [PENDING]
- [ ] Create Cloudflare resources (see commands below)
- [ ] Update wrangler configs with real IDs
- [ ] Set up shrd.stoff.dev DNS
- [ ] Deploy API worker
- [ ] Deploy web app to Pages
- [ ] Configure OAuth providers (GitHub, Google)
- [ ] Test end-to-end

## Deployment Commands

Run these in order to set up Cloudflare resources:

```bash
# 1. Create D1 database
wrangler d1 create shrd-db
# Copy the database_id to apps/api/wrangler.toml

# 2. Create KV namespace
wrangler kv:namespace create CONTENT
# Copy the id to apps/api/wrangler.toml

# 3. Create R2 bucket
wrangler r2 bucket create shrd-storage
# Already configured in apps/api/wrangler.toml

# 4. Generate and apply D1 migrations
cd packages/db
pnpm generate
wrangler d1 migrations apply shrd-db --local  # Test locally first
wrangler d1 migrations apply shrd-db          # Apply to production

# 5. Deploy API
cd apps/api
pnpm deploy

# 6. Deploy Web
cd apps/web
pnpm deploy

# 7. Set up DNS
# In Cloudflare dashboard, add CNAME for shrd.stoff.dev pointing to workers
```

## Environment Variables Needed

Create `.env` files or set in Cloudflare dashboard:

```
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
GOOGLE_CLIENT_ID=xxx
GOOGLE_CLIENT_SECRET=xxx
BETTER_AUTH_SECRET=xxx (generate with: openssl rand -base64 32)
```

## Current Status

**Phase**: API deployed and working, web app deployed but has runtime error

**What's Working**:
- Full monorepo structure with pnpm workspaces
- Hono API deployed at https://shrd-api.plutocrat.workers.dev
- D1 database created with schema migrated
- KV namespace and R2 bucket created
- Rust CLI structure complete
- TypeScript SDK complete

**Known Issues**:
1. **Web App 500 Error**: TanStack Start app returning HTTPError
   - Likely cause: shiki dynamic import or server function configuration
   - Debug by running `pnpm dev` locally first
   - May need to check TanStack Start + Cloudflare compatibility

2. **DNS Not Configured**: shrd.stoff.dev not resolving
   - Need to add CNAME record in Cloudflare dashboard

**Immediate Next Steps**:
1. Debug web app by running locally: `cd apps/web && pnpm dev`
2. Add DNS record for shrd.stoff.dev
3. Set up OAuth providers (GitHub, Google)
4. Configure Better Auth secrets

## File Structure Summary

```
shrd.sh/
├── .env.example
├── .gitignore
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── turbo.json
├── PLAN.md
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── wrangler.toml
│   │   └── src/
│   │       ├── index.ts      # Hono app
│   │       ├── types.ts      # Env bindings
│   │       ├── storage.ts    # KV/R2 helpers
│   │       └── auth.ts       # Better Auth
│   └── web/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── wrangler.jsonc
│       └── app/
│           ├── app.css
│           ├── client.tsx
│           ├── ssr.tsx
│           ├── routeTree.gen.ts
│           ├── lib/auth-client.ts
│           └── routes/
│               ├── __root.tsx
│               ├── index.tsx
│               ├── $id.tsx
│               └── dashboard.tsx
├── packages/
│   ├── shared/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types.ts
│   │       └── utils.ts
│   ├── db/
│   │   ├── package.json
│   │   ├── drizzle.config.ts
│   │   └── src/
│   │       ├── index.ts
│   │       └── schema.ts
│   └── sdk/
│       ├── package.json
│       └── src/
│           └── index.ts
└── cli/
    ├── Cargo.toml
    └── src/
        └── main.rs
```

## Notes for Future Context

- Domain will change from shrd.stoff.dev to shrd.sh eventually
- All URLs configurable via SHRD_BASE_URL env var
- CLI is separate Rust project (not in pnpm workspace)
- MCP server will be separate npm package (@shrd/mcp) - future
- Python SDK will be separate PyPI package - future
- Collections feature scaffolded but not fully implemented - future
- Encryption feature in types but not implemented - future
