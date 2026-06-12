---
name: shrd
description: Use the shrd CLI/API to share files, text, logs, archives, or stdin from one machine and download them on another. Use when a task asks to upload with shrd, download with shrd, transfer files between PCs, create private or expiring share links, inspect recent shrd shares, configure a shrd base URL, or verify an upload/download round trip. Do not use for developing or releasing the shrd repo.
---

# shrd

## Purpose

Use `shrd` as a terminal-first file transfer tool: upload bytes, get a URL, download the same bytes somewhere else.

## Install Or Check

```bash
command -v shrd || { brew tap Stoffberg/tap && brew install shrd; }
shrd --version
```

If Homebrew refuses `stoffberg/tap/shrd` because tap trust is required, trust only the formula and retry:

```bash
brew trust --formula stoffberg/tap/shrd
brew upgrade shrd || brew reinstall shrd
shrd --version
```

Default service: `https://shrd.stoff.dev`.

For another server:

```bash
SHRD_BASE_URL=https://shrd.example.com shrd upload ./file.zip
shrd config set-url https://shrd.example.com
shrd config show
shrd config reset
```

## Upload

```bash
shrd upload ./report.pdf
shrd upload ./archive.zip --name release-bundle
shrd upload "inline text"
cat deploy.log | shrd upload --expire 1h
shrd upload ./secret.env --mode private --expire 1h
```

Useful upload flags:
- `--expire <value>`: `1h`, `24h`, `7d`, `365d`, or `never`; default is `365d`.
- `--mode temporary`: short-lived share, currently `1h`.
- `--mode private`: client-side encryption; keep the full URL including `#key=...`.
- `--mode permanent`: no expiry.
- `--burn`: delete after the first successful read.
- `--encrypt`: encrypt before upload.
- `--name <slug>`: stable public slug, 4-64 URL-safe characters.
- `--json`: machine-readable output.
- `--no-copy`: do not copy the share URL to the clipboard.
- `--resume <manifest>`: resume an interrupted multipart upload.

## Download

```bash
shrd get release-bundle --output ./downloads/
shrd get https://shrd.stoff.dev/release-bundle --raw --output -
shrd get 'https://shrd.stoff.dev/7kq4zn#key=...' --raw --output ./secret.env
shrd get last --open
shrd get release-bundle --meta
```

Quote URLs that contain `#key=...` so the shell does not mangle the encrypted fragment.

Useful download flags:
- `--output <path>`: save to a file, directory, or `-` for stdout.
- `--raw`: write exact bytes without decoration.
- `--open`: save to a temp file and open with the default app.
- `--copy`: copy fetched text to the clipboard.
- `--meta`: print metadata JSON instead of downloading content.

## Remote File Transfer

For shell-over-HTTP, SSH, or any remote command runner with request timeouts, avoid sending binary output back through the command response. Upload locally, stream raw bytes to a remote `.part` file, move it into place, then compare hashes.

Local side:

```bash
sha256=$(shasum -a 256 ./file.mp4 | awk '{print $1}')
url=$(shrd upload ./file.mp4 --mode temporary --no-copy --json | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(d).url))')
printf '%s\n%s\n' "$sha256" "$url"
```

Remote side:

```bash
out="$HOME/Desktop/file.mp4"
tmp="$out.part"
rm -f "$tmp"
shrd get "$url" --raw --output - > "$tmp"
mv -f "$tmp" "$out"
shasum -a 256 "$out"
```

If the remote command runner has a short timeout, run the remote download in the background and poll a text log. Do not log the raw download stream.

```bash
log="/tmp/shrd-transfer-$(date +%s).log"
( set -e; shrd get "$url" --raw --output - > "$tmp"; mv -f "$tmp" "$out"; ls -lh "$out"; shasum -a 256 "$out" ) > "$log" 2>&1 &
printf 'PID=%s\nLOG=%s\n' "$!" "$log"
```

## Recent Shares

Local history is stored on the client.

```bash
shrd get last
shrd list
shrd list --limit 20 --json
shrd list --query report
shrd search release
```

## Round Trip Check

```bash
tmpdir=$(mktemp -d)
printf 'shrd smoke\n' > "$tmpdir/input.txt"
url=$(shrd upload "$tmpdir/input.txt" --expire 1h --no-copy --json | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(d).url))')
shrd get "$url" --raw --output - > "$tmpdir/output.txt"
cmp "$tmpdir/input.txt" "$tmpdir/output.txt"
rm -rf "$tmpdir"
```

## Safety

- Use `--mode private` for secrets.
- Keep delete tokens private.
- Do not paste sensitive file contents into chat; upload the file and pass the private URL when needed.
