# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial release of shrd.sh
- CLI written in Rust with push/pull commands
- Cloudflare Workers API with Hono
- KV storage for content <25KB
- R2 storage for larger content
- Automatic content expiration (default 24 hours)
- Delete tokens for content removal
- TypeScript SDK (@shrd/sdk)
- Web frontend with TanStack Start
- GitHub Actions CI/CD pipeline
- Automatic R2 cleanup via scheduled worker
- Unit tests with Vitest
- Integration test suite

### Security
- CORS enabled for cross-origin requests
- Bearer token authentication for delete operations
- No ambiguous characters in generated IDs

## [0.1.0] - 2026-01-25

### Added
- Initial project setup
- Monorepo structure with pnpm workspaces and Turborepo
- API endpoints:
  - `POST /api/v1/push` - Create a share
  - `GET /:id` - Retrieve content
  - `GET /:id/raw` - Retrieve raw content
  - `GET /:id/meta` - Get metadata
  - `DELETE /api/v1/:id` - Delete content
  - `GET /health` - Health check
- CLI commands:
  - `shrd <content>` - Push content
  - `shrd <id>` - Pull content
  - `shrd --clipboard` - Share clipboard
  - `shrd --expire` - Set expiration
  - `shrd --meta` - Get metadata
- D1 database schema with Drizzle ORM
- Better Auth integration (scaffolded)

[Unreleased]: https://github.com/Stoffberg/shrd.sh/compare/cli-v0.1.0...HEAD
[0.1.0]: https://github.com/Stoffberg/shrd.sh/releases/tag/cli-v0.1.0
