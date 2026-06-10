# Changelog

## Unreleased

### Changed
- Focused the repo on CLI/API file sharing: upload, share, download, and delete by token.
- Made one-year expiry the default, with `temporary`, `private`, and `permanent` modes for explicit overrides.
- Share URLs now serve file bytes directly instead of HTML previews.
- Root lint and CI now run real TypeScript and Rust checks.

### Added
- Multipart upload support for large files.
- API compatibility, e2e, integration, and unit test lanes.
- SDK helpers for push, upload, download, and pull.

### Removed
- Web app workspace and browser renderer.
- Better Auth, account tables, API keys, and collection scaffolding.
