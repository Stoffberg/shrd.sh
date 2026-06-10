# PUNCHLIST

Ordered by impact on a cold senior-engineer review. An item is closed only after the fix is verified and committed.

## Open

1. [ ] Public docs beyond README are stale. `PLAN.md`, `SELF_HOSTING.md`, `CONTRIBUTING.md`, and `CHANGELOG.md` still mention web, Better Auth, stats endpoints, old defaults, and obsolete integration scripts.
2. [ ] API metrics code still carries removed browser/stats concepts (`readsHtml`, public stats aggregation helpers, storage snapshots). Either justify it as internal ops or delete it.
3. [ ] CLI implementation is a 2,400+ line single file. It passes tests, but the file shape makes maintenance look amateur for a flagship repo.
4. [ ] Release metadata is inconsistent. Root package is `0.1.0`, CLI crate is `0.1.12`, and changelog links mention `cli-v0.1.0`.

## Closed

1. [x] README is stale and undersells the project. It documented removed AI config, SDK metadata/delete methods, stats endpoints, web-style HTML negotiation, and old defaults. Replaced it with a current product README covering what/why, terminal demo, architecture, setup, API, SDK, self-hosting, and tech decisions. Verified with `pnpm install --frozen-lockfile`, `cargo build --manifest-path cli/Cargo.toml --release`, `pnpm ci:full`, and `pnpm --filter @shrd/api test:integration`.
2. [x] Rust lint is not green. `cargo clippy --manifest-path cli/Cargo.toml --locked --all-targets -- -D warnings` failed on two `unnecessary_sort_by` findings in multipart upload code. Replaced both manifest part sorts with `sort_by_key`. Verified with `cargo fmt --manifest-path cli/Cargo.toml -- --check`, `cargo clippy --manifest-path cli/Cargo.toml --locked --all-targets -- -D warnings`, and `pnpm ci:full`.
3. [x] Root `pnpm lint` is a fake green check. It exited 0 while Turbo ran zero lint tasks. Replaced it with `lint:ts` plus `lint:rust`, removed the unused Turbo lint task, and wired `ci:core` through `pnpm lint`. Verified with `pnpm lint` and `pnpm ci:full`.
4. [x] The dead web app remained in the workspace. `pnpm build` scoped `@shrd/web` and replayed a giant TanStack/Shiki server bundle. Deleted `apps/web`, narrowed the workspace to `apps/api`, and regenerated the lockfile. Root `pnpm build` now scopes `@shrd/api`, `@shrd/db`, `@shrd/sdk`, and `@shrd/shared` only, dropping from 5 scoped packages and 3 build tasks to 4 scoped packages and 2 build tasks. Verified with `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm ci:full`.
5. [x] Scaffolded auth and account schema remained despite the no-account product contract. Deleted the unused Better Auth module, removed `better-auth` and `@atinux/kysely-d1`, and trimmed account/session/user/api-key/collection tables plus `shares.user_id` from the Drizzle schema and migration snapshot. Verified no non-multipart auth/account tables remain with `rg`, then ran `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm ci:full`, and `pnpm --filter @shrd/api test:integration`.
