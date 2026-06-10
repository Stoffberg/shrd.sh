# PUNCHLIST

Ordered by impact on a cold senior-engineer review. An item is closed only after the fix is verified and committed.

## Open

1. [ ] Root `pnpm lint` is a fake green check. It exits 0 while Turbo runs zero lint tasks, which looks careless to anyone running the advertised gates.
2. [ ] The dead web app remains in the workspace. `pnpm build` still builds `@shrd/web`, pulls in React/TanStack/Shiki, and emits a huge server bundle for a product direction that is explicitly CLI/API file sharing only.
3. [ ] Scaffolded auth and account schema remain despite the no-account product contract. `apps/api/src/auth.ts`, Better Auth dependencies, and user/session/api-key/collection tables read like abandoned scope.
4. [ ] Public docs beyond README are stale. `PLAN.md`, `SELF_HOSTING.md`, `CONTRIBUTING.md`, and `CHANGELOG.md` still mention web, Better Auth, stats endpoints, old defaults, and obsolete integration scripts.
5. [ ] API metrics code still carries removed browser/stats concepts (`readsHtml`, public stats aggregation helpers, storage snapshots). Either justify it as internal ops or delete it.
6. [ ] CLI implementation is a 2,400+ line single file. It passes tests, but the file shape makes maintenance look amateur for a flagship repo.
7. [ ] Release metadata is inconsistent. Root package is `0.1.0`, CLI crate is `0.1.12`, and changelog links mention `cli-v0.1.0`.
8. [ ] Setup commands are not curated for the frozen feature set. Full `pnpm install` works, but root `pnpm build` still spends time on web and prints noisy web bundle output.

## Closed

1. [x] README is stale and undersells the project. It documented removed AI config, SDK metadata/delete methods, stats endpoints, web-style HTML negotiation, and old defaults. Replaced it with a current product README covering what/why, terminal demo, architecture, setup, API, SDK, self-hosting, and tech decisions. Verified with `pnpm install --frozen-lockfile`, `cargo build --manifest-path cli/Cargo.toml --release`, `pnpm ci:full`, and `pnpm --filter @shrd/api test:integration`.
2. [x] Rust lint is not green. `cargo clippy --manifest-path cli/Cargo.toml --locked --all-targets -- -D warnings` failed on two `unnecessary_sort_by` findings in multipart upload code. Replaced both manifest part sorts with `sort_by_key`. Verified with `cargo fmt --manifest-path cli/Cargo.toml -- --check`, `cargo clippy --manifest-path cli/Cargo.toml --locked --all-targets -- -D warnings`, and `pnpm ci:full`.
