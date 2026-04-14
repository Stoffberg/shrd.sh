Canonical contract notes for this repo:

- CLI support is positional first, with explicit `upload` and `get` subcommands as stable alternatives. There is no account-management flow in the CLI.
- The CLI keeps a local recent-share history. `recent` and `list` are the supported views for that history, and `get last` is the stable shortcut for recalling the newest share.
- Product presets belong in `--mode` instead of new one-off flags. Current modes are `temporary`, `private`, and `permanent`.
- Request-side expiry is string-based: `Nh`, `Nd`, or `never`. `expiresIn` is compatibility input only. Invalid expiry values should fail fast with `400`, not silently fall back.
- Share `name` is the public slug when provided. It must be unique, must avoid reserved route roots, and must work the same way for text push, direct upload, and multipart upload.
- API responses and metadata should use `expiresAt: string | null`. `null` means no automatic expiry.
- Metadata responses should keep `contentType`, `filename`, `encrypted`, `name`, and `storageType` available because the CLI and browser decryption flows depend on them.
