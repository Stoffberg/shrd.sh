# Contributing to shrd.sh

Thanks for your interest in contributing to shrd.sh! This document outlines how to get started.

## Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+
- Rust (for CLI development)
- Cloudflare account (for deployment)

### Getting Started

```bash
git clone https://github.com/Stoffberg/shrd.sh
cd shrd.sh
pnpm install
```

### Running Locally

```bash
# Start the API (requires wrangler login)
cd apps/api && pnpm dev

# Start the web app
cd apps/web && pnpm dev

# Build the CLI
cd cli && cargo build
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run API tests only
cd apps/api && pnpm test

# Run CLI tests
cd cli && cargo test

# Run integration tests (requires deployed API)
./tests/integration.sh
```

## Project Structure

```
shrd.sh/
├── apps/
│   ├── api/          # Cloudflare Worker API (Hono)
│   └── web/          # Web frontend (TanStack Start)
├── packages/
│   ├── shared/       # Shared types & utils
│   ├── db/           # D1 schema (Drizzle)
│   └── sdk/          # TypeScript SDK
├── cli/              # Rust CLI
└── tests/            # Integration tests
```

## Making Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (`pnpm test`)
5. Commit your changes (`git commit -m 'feat: add amazing feature'`)
6. Push to your branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## Commit Messages

We use conventional commits:

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `refactor:` Code refactoring
- `test:` Test additions or fixes
- `chore:` Maintenance tasks

## Code Style

- TypeScript: Follow existing patterns, use strict types
- Rust: Run `cargo fmt` before committing
- No unused imports or variables
- Prefer explicit over implicit

## Areas for Contribution

- Bug fixes
- Performance improvements
- Documentation improvements
- New CLI features
- SDK improvements
- Test coverage

## Questions?

Open an issue or discussion on GitHub.
