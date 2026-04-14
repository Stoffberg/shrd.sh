use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use clap::{Parser, Subcommand, ValueEnum};
use colored::Colorize;
use futures::stream::{self, StreamExt};
use indicatif::{ProgressBar, ProgressStyle};
use reqwest::Body;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::time::Instant;

const DEFAULT_BASE_URL: &str = "https://shrd.stoff.dev";
const KEY_LEN: usize = 32;
const GENERATED_ID_LEN: usize = 6;
const MAX_HISTORY_ITEMS: usize = 50;

fn encrypt_content(plaintext: &[u8]) -> Result<(Vec<u8>, String)> {
    let rng = SystemRandom::new();

    let mut key_bytes = [0u8; KEY_LEN];
    rng.fill(&mut key_bytes)
        .map_err(|_| anyhow::anyhow!("Failed to generate encryption key"))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill(&mut nonce_bytes)
        .map_err(|_| anyhow::anyhow!("Failed to generate nonce"))?;

    let unbound_key = UnboundKey::new(&AES_256_GCM, &key_bytes)
        .map_err(|_| anyhow::anyhow!("Failed to create encryption key"))?;
    let key = LessSafeKey::new(unbound_key);

    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let mut ciphertext = plaintext.to_vec();
    key.seal_in_place_append_tag(nonce, Aad::empty(), &mut ciphertext)
        .map_err(|_| anyhow::anyhow!("Encryption failed"))?;

    let mut result = nonce_bytes.to_vec();
    result.extend(ciphertext);

    let key_b64 = URL_SAFE_NO_PAD.encode(key_bytes);

    Ok((result, key_b64))
}

fn decrypt_content(ciphertext: &[u8], key_b64: &str) -> Result<Vec<u8>> {
    if ciphertext.len() < NONCE_LEN {
        anyhow::bail!("Invalid encrypted content: too short");
    }

    let key_bytes = URL_SAFE_NO_PAD
        .decode(key_b64)
        .context("Invalid encryption key")?;

    if key_bytes.len() != KEY_LEN {
        anyhow::bail!("Invalid encryption key length");
    }

    let nonce_bytes: [u8; NONCE_LEN] = ciphertext[..NONCE_LEN]
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid nonce"))?;
    let encrypted = &ciphertext[NONCE_LEN..];

    let unbound_key = UnboundKey::new(&AES_256_GCM, &key_bytes)
        .map_err(|_| anyhow::anyhow!("Failed to create decryption key"))?;
    let key = LessSafeKey::new(unbound_key);

    let nonce = Nonce::assume_unique_for_key(nonce_bytes);

    let mut plaintext = encrypted.to_vec();
    key.open_in_place(nonce, Aad::empty(), &mut plaintext)
        .map_err(|_| anyhow::anyhow!("Decryption failed - invalid key or corrupted data"))?;

    let tag_len = AES_256_GCM.tag_len();
    plaintext.truncate(plaintext.len() - tag_len);

    Ok(plaintext)
}

fn parse_id_and_key(input: &str) -> (String, Option<String>) {
    if let Some(hash_pos) = input.find('#') {
        let id = input[..hash_pos].to_string();
        let fragment = &input[hash_pos + 1..];
        let key = if fragment.starts_with("key=") {
            Some(fragment[4..].to_string())
        } else {
            Some(fragment.to_string())
        };
        (id, key)
    } else {
        (input.to_string(), None)
    }
}

fn normalize_share_id(input: &str) -> String {
    let trimmed = input
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let without_host = if let Some((_, path)) = trimmed.split_once('/') {
        path
    } else {
        trimmed
    };
    let path = without_host
        .trim_start_matches("shrd.sh/")
        .trim_start_matches("shrd.stoff.dev/");
    let id = path.split('/').next().unwrap_or(path).trim();
    id.to_string()
}

fn is_valid_share_id(input: &str) -> bool {
    let id = normalize_share_id(input);
    let len = id.len();
    len >= 4
        && len <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn looks_like_share_reference(input: &str) -> bool {
    let trimmed = input.trim();
    if trimmed.contains("://") || trimmed.contains('/') || trimmed.contains('#') {
        return is_valid_share_id(trimmed);
    }

    let id = normalize_share_id(trimmed);
    id.len() == GENERATED_ID_LEN && is_valid_share_id(&id)
}

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq)]
enum ShareMode {
    Temporary,
    Private,
    Permanent,
}

#[derive(Debug, Parser)]
#[command(name = "shrd")]
#[command(about = "Share anything, instantly", long_about = None)]
#[command(version, disable_version_flag = true)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(help = "Content ID to retrieve, or content to share")]
    input: Option<String>,

    #[arg(
        short = 'x',
        long = "expire",
        alias = "expires",
        global = true,
        help = "Expiry time (1h, 24h, 7d, 30d, never)"
    )]
    expire: Option<String>,

    #[arg(short, long, global = true, help = "Delete after first view")]
    burn: bool,

    #[arg(
        short,
        long,
        global = true,
        help = "End-to-end encrypt (key in URL fragment)"
    )]
    encrypt: bool,

    #[arg(short, long, global = true, help = "Custom name/slug")]
    name: Option<String>,

    #[arg(
        long,
        value_enum,
        global = true,
        help = "Sharing preset: temporary, private, permanent"
    )]
    mode: Option<ShareMode>,

    #[arg(short, long, global = true, help = "Output as JSON")]
    json: bool,

    #[arg(short = 'v', long = "version", action = clap::ArgAction::Version, help = "Print version")]
    version: Option<bool>,

    #[arg(short, long, global = true, help = "Suppress output except errors")]
    quiet: bool,

    #[arg(long, global = true, help = "Don't copy to clipboard")]
    no_copy: bool,

    #[arg(short, long, global = true, help = "Share clipboard contents")]
    clipboard: bool,

    #[arg(long, global = true, help = "Get metadata instead of content")]
    meta: bool,
}

#[derive(Debug, Subcommand)]
enum Commands {
    #[command(about = "Share text or a file")]
    Upload {
        #[arg(help = "Text to share or a file path")]
        input: Option<String>,
    },
    #[command(about = "Retrieve an existing share")]
    Get {
        #[arg(help = "Share ID or URL")]
        id: String,
    },
    #[command(
        about = "Show recent shares from local history",
        visible_alias = "list"
    )]
    Recent {
        #[arg(short, long, default_value_t = 10, help = "How many shares to show")]
        limit: usize,
        #[arg(long, help = "Copy the newest share URL")]
        copy: bool,
    },
    #[command(about = "Configure shrd settings")]
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
}

#[derive(Debug, Subcommand)]
enum ConfigAction {
    #[command(about = "Set the API base URL (for self-hosted instances)")]
    SetUrl { url: String },
    #[command(about = "Show current configuration")]
    Show,
    #[command(about = "Reset to default configuration")]
    Reset,
}

#[derive(Serialize)]
struct PushRequest {
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expire: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    burn: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(rename = "contentType", skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    filename: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    encrypted: bool,
}

fn guess_content_type(path: &str) -> String {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());

    match ext.as_deref() {
        Some("txt") => "text/plain",
        Some("md") => "text/markdown",
        Some("json") => "application/json",
        Some("xml") => "application/xml",
        Some("html" | "htm") => "text/html",
        Some("css") => "text/css",
        Some("js") => "text/javascript",
        Some("ts") => "text/typescript",
        Some("yaml" | "yml") => "text/yaml",
        Some("csv") => "text/csv",
        Some("rs") => "text/x-rust",
        Some("py") => "text/x-python",
        Some("go") => "text/x-go",
        Some("sh" | "bash") => "text/x-shellscript",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("zip") => "application/zip",
        Some("tar") => "application/x-tar",
        Some("gz") => "application/gzip",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("avi") => "video/x-msvideo",
        Some("mkv") => "video/x-matroska",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("ogg") => "audio/ogg",
        _ => "application/octet-stream",
    }
    .into()
}

#[derive(Deserialize)]
struct PushResponse {
    id: String,
    url: String,
    #[serde(rename = "rawUrl")]
    raw_url: String,
    #[serde(rename = "deleteUrl")]
    delete_url: String,
    #[serde(rename = "deleteToken")]
    delete_token: String,
    #[serde(rename = "expiresAt")]
    expires_at: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct ShareMeta {
    id: String,
    #[serde(rename = "contentType")]
    content_type: String,
    size: u64,
    views: u64,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "expiresAt")]
    expires_at: Option<String>,
    filename: Option<String>,
    name: Option<String>,
    burn: Option<bool>,
    #[serde(rename = "storageType")]
    storage_type: Option<String>,
    encrypted: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone)]
struct HistoryEntry {
    id: String,
    url: String,
    raw_url: String,
    delete_url: String,
    delete_token: String,
    expires_at: Option<String>,
    name: Option<String>,
    created_at: u64,
    source: Option<String>,
    mode: Option<String>,
    encrypted: bool,
    burn: bool,
}

fn get_base_url() -> String {
    // Priority: 1. Environment variable, 2. Config file, 3. Default
    if let Ok(url) = std::env::var("SHRD_BASE_URL") {
        return url;
    }

    if let Some(url) = get_config_base_url() {
        return url;
    }

    DEFAULT_BASE_URL.to_string()
}

fn history_file_path() -> Result<std::path::PathBuf> {
    Ok(get_config_dir()?.join("history.json"))
}

fn load_history() -> Result<Vec<HistoryEntry>> {
    let history_file = history_file_path()?;
    if !history_file.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(history_file)?;
    let entries = serde_json::from_str(&content).unwrap_or_default();
    Ok(entries)
}

fn save_history(entries: &[HistoryEntry]) -> Result<()> {
    let history_file = history_file_path()?;
    std::fs::write(history_file, serde_json::to_string_pretty(entries)?)?;
    Ok(())
}

fn append_history(entry: HistoryEntry) -> Result<()> {
    let mut entries = load_history()?;
    entries.insert(0, entry);
    entries.truncate(MAX_HISTORY_ITEMS);
    save_history(&entries)
}

fn latest_history_entry() -> Result<HistoryEntry> {
    load_history()?
        .into_iter()
        .next()
        .context("No recent shares yet")
}

fn resolve_recent_reference(input: &str) -> Result<String> {
    if input != "last" {
        return Ok(input.to_string());
    }

    Ok(latest_history_entry()?.url)
}

fn mode_label(mode: ShareMode) -> &'static str {
    match mode {
        ShareMode::Temporary => "temporary",
        ShareMode::Private => "private",
        ShareMode::Permanent => "permanent",
    }
}

fn effective_mode(cli: &Cli) -> Option<ShareMode> {
    cli.mode
}

fn effective_expire(cli: &Cli) -> Option<String> {
    if let Some(expire) = &cli.expire {
        return Some(expire.clone());
    }

    match effective_mode(cli) {
        Some(ShareMode::Temporary) => Some("1h".to_string()),
        Some(ShareMode::Permanent) => Some("never".to_string()),
        _ => None,
    }
}

fn effective_encrypt(cli: &Cli) -> bool {
    cli.encrypt || matches!(effective_mode(cli), Some(ShareMode::Private))
}

fn effective_burn(cli: &Cli) -> bool {
    cli.burn
}

fn get_config_base_url() -> Option<String> {
    let config_dir = get_config_dir().ok()?;
    let config_file = config_dir.join("config.json");
    let content = std::fs::read_to_string(config_file).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("base_url")?.as_str().map(String::from)
}

fn save_config_url(url: &str) -> Result<()> {
    let config_dir = get_config_dir()?;
    let config_file = config_dir.join("config.json");

    let mut config: serde_json::Value = if config_file.exists() {
        let content = std::fs::read_to_string(&config_file)?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    config["base_url"] = serde_json::Value::String(url.to_string());
    std::fs::write(config_file, serde_json::to_string_pretty(&config)?)?;
    Ok(())
}

fn get_config_dir() -> Result<std::path::PathBuf> {
    let config_dir = dirs::config_dir()
        .context("Could not find config directory")?
        .join("shrd");
    std::fs::create_dir_all(&config_dir)?;
    Ok(config_dir)
}

const DEFAULT_UPLOAD_SPEED: f64 = 500_000.0; // 500 KB/s conservative default

fn get_upload_speed() -> f64 {
    let config_dir = match get_config_dir() {
        Ok(dir) => dir,
        Err(_) => return DEFAULT_UPLOAD_SPEED,
    };
    let config_file = config_dir.join("config.json");
    let content = match std::fs::read_to_string(&config_file) {
        Ok(c) => c,
        Err(_) => return DEFAULT_UPLOAD_SPEED,
    };
    let json: serde_json::Value = match serde_json::from_str(&content) {
        Ok(j) => j,
        Err(_) => return DEFAULT_UPLOAD_SPEED,
    };
    json.get("upload_speed_bps")
        .and_then(|v| v.as_f64())
        .unwrap_or(DEFAULT_UPLOAD_SPEED)
}

fn save_upload_speed(speed_bps: f64, body_size: usize) {
    // Only update speed estimate for meaningful uploads (>50KB)
    // Small uploads are dominated by latency, not bandwidth
    if body_size < 50_000 {
        return;
    }

    let config_dir = match get_config_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let config_file = config_dir.join("config.json");

    let mut config: serde_json::Value = if config_file.exists() {
        std::fs::read_to_string(&config_file)
            .ok()
            .and_then(|c| serde_json::from_str(&c).ok())
            .unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Exponential moving average with new measurement weighted at 30%
    let old_speed = config
        .get("upload_speed_bps")
        .and_then(|v| v.as_f64())
        .unwrap_or(speed_bps);
    let new_speed = old_speed * 0.7 + speed_bps * 0.3;

    config["upload_speed_bps"] = serde_json::Value::from(new_speed);
    let _ = std::fs::write(
        &config_file,
        serde_json::to_string_pretty(&config).unwrap_or_default(),
    );
}

#[cfg(feature = "clipboard")]
fn copy_to_clipboard(text: &str) -> Result<()> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new()?;
    clipboard.set_text(text)?;
    Ok(())
}

#[cfg(not(feature = "clipboard"))]
fn copy_to_clipboard(_text: &str) -> Result<()> {
    Ok(())
}

#[cfg(feature = "clipboard")]
fn get_clipboard() -> Result<String> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new()?;
    clipboard
        .get_text()
        .context("Failed to get clipboard contents")
}

#[cfg(not(feature = "clipboard"))]
fn get_clipboard() -> Result<String> {
    anyhow::bail!("Clipboard support not compiled in")
}

async fn push_content(
    cli: &Cli,
    content: String,
    content_type: Option<String>,
    filename: Option<String>,
    source: Option<String>,
) -> Result<()> {
    let client = reqwest::Client::new();
    let base_url = get_base_url();

    let encrypt = effective_encrypt(cli);
    let burn = effective_burn(cli);
    let expire = effective_expire(cli);

    let (final_content, encryption_key) = if encrypt {
        let (encrypted_content, key) = encrypt_content(content.as_bytes())?;
        let encoded_content = base64::engine::general_purpose::STANDARD.encode(&encrypted_content);
        (encoded_content, Some(key))
    } else {
        (content, None)
    };

    let request = PushRequest {
        content: final_content,
        expire,
        burn,
        name: cli.name.clone(),
        content_type,
        filename,
        encrypted: encrypt,
    };

    let body_bytes = serde_json::to_vec(&request)?;
    let body_size = body_bytes.len();

    let upload_speed = get_upload_speed();
    let estimated_seconds = body_size as f64 / upload_speed;
    let show_progress = estimated_seconds > 10.0 && !cli.quiet && !cli.json;

    let progress_bar = if show_progress {
        let pb = ProgressBar::new(body_size as u64);
        pb.set_style(
            ProgressStyle::default_bar()
                .template("{spinner:.green} [{bar:30.cyan/blue}] {bytes}/{total_bytes} @ {bytes_per_sec} ({eta})")
                .unwrap()
                .progress_chars("━━─"),
        );
        pb.enable_steady_tick(std::time::Duration::from_millis(100));
        Some(pb)
    } else {
        None
    };

    let start_time = Instant::now();

    let body = if let Some(ref pb) = progress_bar {
        let pb_clone = pb.clone();
        let chunk_size = 8192;
        let chunks: Vec<Vec<u8>> = body_bytes.chunks(chunk_size).map(|c| c.to_vec()).collect();

        let stream = stream::iter(chunks).map(move |chunk| {
            pb_clone.inc(chunk.len() as u64);
            Ok::<_, std::io::Error>(chunk)
        });

        Body::wrap_stream(stream)
    } else {
        Body::from(body_bytes)
    };

    let req = client
        .post(format!("{}/api/v1/push", base_url))
        .header("Content-Type", "application/json");

    let response = req.body(body).send().await?;

    if let Some(pb) = progress_bar {
        pb.finish_and_clear();
    }

    let elapsed = start_time.elapsed();
    let actual_speed = body_size as f64 / elapsed.as_secs_f64();
    save_upload_speed(actual_speed, body_size);

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Failed to push: {} - {}", status, body);
    }

    let result: PushResponse = response.json().await?;
    print_result(cli, &result, encryption_key.as_deref());
    let _ = record_history(cli, &result, encryption_key.as_deref(), source);

    Ok(())
}

const MULTIPART_THRESHOLD: u64 = 95 * 1024 * 1024; // 95MB - use multipart for larger
const PART_SIZE: u64 = 50 * 1024 * 1024; // 50MB parts

async fn upload_file_streaming(cli: &Cli, path: &str) -> Result<()> {
    let path_obj = std::path::Path::new(path);
    let file_size = std::fs::metadata(path)
        .with_context(|| format!("Failed to read file: {}", path))?
        .len();

    if file_size > MULTIPART_THRESHOLD {
        return upload_file_multipart(cli, path, file_size).await;
    }

    let filename = path_obj
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let content_type = guess_content_type(path);

    let client = reqwest::Client::new();
    let base_url = get_base_url();

    let file_content =
        std::fs::read(path).with_context(|| format!("Failed to read file: {}", path))?;

    let encrypt = effective_encrypt(cli);
    let burn = effective_burn(cli);
    let expire = effective_expire(cli);

    let (upload_content, encryption_key, content_size) = if encrypt {
        let (encrypted, key) = encrypt_content(&file_content)?;
        let size = encrypted.len() as u64;
        (encrypted, Some(key), size)
    } else {
        (file_content, None, file_size)
    };

    let upload_speed = get_upload_speed();
    let estimated_seconds = content_size as f64 / upload_speed;
    let show_progress = estimated_seconds > 10.0 && !cli.quiet && !cli.json;

    let progress_bar = if show_progress {
        let pb = ProgressBar::new(content_size);
        pb.set_style(
            ProgressStyle::default_bar()
                .template("{spinner:.green} [{bar:30.cyan/blue}] {bytes}/{total_bytes} @ {bytes_per_sec} ({eta})")
                .unwrap()
                .progress_chars("━━─"),
        );
        pb.enable_steady_tick(std::time::Duration::from_millis(100));
        Some(pb)
    } else {
        None
    };

    let start_time = Instant::now();

    let body = if let Some(ref pb) = progress_bar {
        let pb_clone = pb.clone();
        let chunk_size = 8192;
        let chunks: Vec<Vec<u8>> = upload_content
            .chunks(chunk_size)
            .map(|c| c.to_vec())
            .collect();
        let stream = stream::iter(chunks).map(move |chunk| {
            pb_clone.inc(chunk.len() as u64);
            Ok::<_, std::io::Error>(chunk)
        });
        Body::wrap_stream(stream)
    } else {
        Body::from(upload_content)
    };

    let mut req = client
        .post(format!("{}/api/v1/upload", base_url))
        .header("Content-Length", content_size.to_string())
        .header("X-Content-Type", &content_type)
        .header("X-Filename", filename);

    if burn {
        req = req.header("X-Burn", "true");
    }
    if encrypt {
        req = req.header("X-Encrypted", "true");
    }
    if let Some(ref expire) = expire {
        req = req.header("X-Expire", expire);
    }
    if let Some(ref name) = cli.name {
        req = req.header("X-Name", name);
    }

    let response = req.body(body).send().await?;

    if let Some(pb) = progress_bar {
        pb.finish_and_clear();
    }

    let elapsed = start_time.elapsed();
    let actual_speed = content_size as f64 / elapsed.as_secs_f64();
    save_upload_speed(actual_speed, content_size as usize);

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Failed to upload: {} - {}", status, body);
    }

    let result: PushResponse = response.json().await?;
    print_result(cli, &result, encryption_key.as_deref());
    let _ = record_history(
        cli,
        &result,
        encryption_key.as_deref(),
        Some(path.to_string()),
    );
    Ok(())
}

#[derive(Deserialize)]
struct MultipartInitResponse {
    id: String,
    #[serde(rename = "uploadId")]
    upload_id: String,
}

async fn upload_file_multipart(cli: &Cli, path: &str, file_size: u64) -> Result<()> {
    let path_obj = std::path::Path::new(path);
    let filename = path_obj
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let content_type = guess_content_type(path);

    let client = reqwest::Client::new();
    let base_url = get_base_url();

    let file_content =
        std::fs::read(path).with_context(|| format!("Failed to read file: {}", path))?;

    let encrypt = effective_encrypt(cli);
    let burn = effective_burn(cli);
    let expire = effective_expire(cli);

    let (upload_content, encryption_key, content_size) = if encrypt {
        let (encrypted, key) = encrypt_content(&file_content)?;
        let size = encrypted.len() as u64;
        (encrypted, Some(key), size)
    } else {
        (file_content, None, file_size)
    };

    let mut init_req = client
        .post(format!("{}/api/v1/multipart/init", base_url))
        .header("X-Content-Type", &content_type)
        .header("X-Filename", filename);

    if burn {
        init_req = init_req.header("X-Burn", "true");
    }
    if encrypt {
        init_req = init_req.header("X-Encrypted", "true");
    }
    if let Some(ref expire) = expire {
        init_req = init_req.header("X-Expire", expire);
    }
    if let Some(ref name) = cli.name {
        init_req = init_req.header("X-Name", name);
    }

    let init_response = init_req.send().await?;
    if !init_response.status().is_success() {
        anyhow::bail!(
            "Failed to init multipart upload: {}",
            init_response.status()
        );
    }

    let init: MultipartInitResponse = init_response.json().await?;

    let upload_speed = get_upload_speed();
    let estimated_seconds = content_size as f64 / upload_speed;
    let show_progress = estimated_seconds > 10.0 && !cli.quiet && !cli.json;

    let progress_bar = if show_progress {
        let pb = ProgressBar::new(content_size);
        pb.set_style(
            ProgressStyle::default_bar()
                .template("{spinner:.green} [{bar:30.cyan/blue}] {bytes}/{total_bytes} @ {bytes_per_sec} ({eta})")
                .unwrap()
                .progress_chars("━━─"),
        );
        pb.enable_steady_tick(std::time::Duration::from_millis(100));
        Some(pb)
    } else {
        None
    };

    let start_time = Instant::now();
    let mut part_number = 1;
    let mut uploaded = 0u64;

    while uploaded < content_size {
        let remaining = content_size - uploaded;
        let part_size = std::cmp::min(PART_SIZE, remaining) as usize;
        let part_data = upload_content[uploaded as usize..(uploaded as usize + part_size)].to_vec();

        let body = if let Some(ref pb) = progress_bar {
            let pb_clone = pb.clone();
            let chunk_size = 8192;
            let chunks: Vec<Vec<u8>> = part_data.chunks(chunk_size).map(|c| c.to_vec()).collect();
            let stream = stream::iter(chunks).map(move |chunk| {
                pb_clone.inc(chunk.len() as u64);
                Ok::<_, std::io::Error>(chunk)
            });
            Body::wrap_stream(stream)
        } else {
            Body::from(part_data)
        };

        let response = client
            .put(format!(
                "{}/api/v1/multipart/{}/part/{}",
                base_url, init.id, part_number
            ))
            .header("X-Upload-Id", &init.upload_id)
            .header("Content-Length", part_size.to_string())
            .body(body)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!(
                "Failed to upload part {}: {} - {}",
                part_number,
                status,
                body
            );
        }

        uploaded += part_size as u64;
        part_number += 1;
    }

    let complete_response = client
        .post(format!(
            "{}/api/v1/multipart/{}/complete",
            base_url, init.id
        ))
        .header("X-Upload-Id", &init.upload_id)
        .header("X-Total-Size", content_size.to_string())
        .send()
        .await?;

    if let Some(pb) = progress_bar {
        pb.finish_and_clear();
    }

    let elapsed = start_time.elapsed();
    let actual_speed = content_size as f64 / elapsed.as_secs_f64();
    save_upload_speed(actual_speed, content_size as usize);

    if !complete_response.status().is_success() {
        let status = complete_response.status();
        let body = complete_response.text().await.unwrap_or_default();
        anyhow::bail!("Failed to complete multipart upload: {} - {}", status, body);
    }

    let result: PushResponse = complete_response.json().await?;
    print_result(cli, &result, encryption_key.as_deref());
    let _ = record_history(
        cli,
        &result,
        encryption_key.as_deref(),
        Some(path.to_string()),
    );
    Ok(())
}

fn resolve_result_urls(result: &PushResponse, encryption_key: Option<&str>) -> (String, String) {
    match encryption_key {
        Some(key) => (
            format!("{}#{}", result.url, key),
            format!("{}#{}", result.raw_url, key),
        ),
        None => (result.url.clone(), result.raw_url.clone()),
    }
}

fn summarize_share(result: &PushResponse, cli: &Cli) -> String {
    let mut labels = Vec::new();
    if let Some(mode) = effective_mode(cli) {
        labels.push(mode_label(mode).to_string());
    }
    if effective_encrypt(cli) && effective_mode(cli) != Some(ShareMode::Private) {
        labels.push("encrypted".to_string());
    }
    if effective_burn(cli) {
        labels.push("burn".to_string());
    }
    if let Some(name) = &result.name {
        labels.push(format!("named {}", name));
    }
    if let Some(expires_at) = &result.expires_at {
        labels.push(format!("expires {}", expires_at));
    } else {
        labels.push("never expires".to_string());
    }
    labels.join(" · ")
}

fn record_history(
    cli: &Cli,
    result: &PushResponse,
    encryption_key: Option<&str>,
    source: Option<String>,
) -> Result<()> {
    let (url, raw_url) = resolve_result_urls(result, encryption_key);
    append_history(HistoryEntry {
        id: result.id.clone(),
        url,
        raw_url,
        delete_url: result.delete_url.clone(),
        delete_token: result.delete_token.clone(),
        expires_at: result.expires_at.clone(),
        name: result.name.clone(),
        created_at: unix_now(),
        source,
        mode: effective_mode(cli).map(|mode| mode_label(mode).to_string()),
        encrypted: effective_encrypt(cli),
        burn: effective_burn(cli),
    })
}

fn print_result(cli: &Cli, result: &PushResponse, encryption_key: Option<&str>) {
    let (url, raw_url) = resolve_result_urls(result, encryption_key);

    if cli.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "id": result.id,
                "url": url,
                "rawUrl": raw_url,
                "deleteUrl": result.delete_url,
                "expiresAt": result.expires_at,
                "deleteToken": result.delete_token,
                "name": result.name,
            }))
            .unwrap_or_default()
        );
    } else if !cli.quiet {
        println!("{} {}", "→".green(), url.cyan());
        eprintln!("{}", summarize_share(result, cli).dimmed());
        if !cli.no_copy {
            if copy_to_clipboard(&url).is_ok() {
                eprintln!("{}", "(copied to clipboard)".dimmed());
            }
        }
    }
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn is_binary_content_type(content_type: &str) -> bool {
    content_type.starts_with("image/")
        || content_type.starts_with("video/")
        || content_type.starts_with("audio/")
        || content_type.starts_with("application/octet-stream")
        || content_type.starts_with("application/pdf")
        || content_type.starts_with("application/zip")
        || content_type.starts_with("application/gzip")
        || content_type.starts_with("application/x-tar")
}

fn get_unique_filename(filename: &str) -> String {
    if !std::path::Path::new(filename).exists() {
        return filename.to_string();
    }

    let path = std::path::Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);
    let ext = path.extension().and_then(|e| e.to_str());

    for i in 1..1000 {
        let new_name = match ext {
            Some(e) => format!("{} ({}).{}", stem, i, e),
            None => format!("{} ({})", stem, i),
        };
        if !std::path::Path::new(&new_name).exists() {
            return new_name;
        }
    }
    format!(
        "{}.{}",
        filename,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    )
}

fn format_history_age(created_at: u64) -> String {
    let now = unix_now();
    let diff = now.saturating_sub(created_at);
    if diff < 60 {
        return "just now".to_string();
    }
    if diff < 3600 {
        return format!("{}m ago", diff / 60);
    }
    if diff < 86400 {
        return format!("{}h ago", diff / 3600);
    }
    format!("{}d ago", diff / 86400)
}

fn print_recent_shares(cli: &Cli, limit: usize, copy: bool) -> Result<()> {
    let entries = load_history()?;
    if entries.is_empty() {
        if cli.json {
            println!("[]");
        } else {
            println!("No recent shares yet.");
        }
        return Ok(());
    }

    if copy {
        let latest = &entries[0];
        copy_to_clipboard(&latest.url)?;
        println!("{} {}", "→".green(), latest.url.cyan());
        return Ok(());
    }

    let shown_entries: Vec<HistoryEntry> = entries.into_iter().take(limit).collect();

    if cli.json {
        println!("{}", serde_json::to_string_pretty(&shown_entries)?);
        return Ok(());
    }

    println!(
        "{:<3} {:<18} {:<12} {:<10} {:<12} {}",
        "#", "share", "mode", "age", "source", "url"
    );
    for (index, entry) in shown_entries.into_iter().enumerate() {
        let label = entry.name.unwrap_or(entry.id);
        let mode = entry.mode.unwrap_or_else(|| {
            if entry.encrypted {
                "encrypted".to_string()
            } else {
                "default".to_string()
            }
        });
        let source = entry.source.unwrap_or_else(|| "inline".to_string());
        println!(
            "{:<3} {:<18} {:<12} {:<10} {:<12} {}",
            index + 1,
            label,
            mode,
            format_history_age(entry.created_at),
            source,
            entry.url
        );
    }

    Ok(())
}

async fn pull_content(cli: &Cli, id: &str) -> Result<()> {
    use tokio::io::AsyncWriteExt;

    let client = reqwest::Client::new();
    let base_url = get_base_url();
    let resolved_reference = resolve_recent_reference(id)?;
    let (raw_id, decryption_key) = parse_id_and_key(&resolved_reference);
    let id = normalize_share_id(&raw_id);

    if cli.meta {
        let response = client
            .get(format!("{}/{}/meta", base_url, id))
            .send()
            .await?;

        if !response.status().is_success() {
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                anyhow::bail!("Share not found or expired");
            }
            anyhow::bail!("Failed to fetch: {}", response.status());
        }

        let meta: ShareMeta = response.json().await?;
        println!("{}", serde_json::to_string_pretty(&meta)?);
        return Ok(());
    }

    let meta_response = client
        .get(format!("{}/{}/meta", base_url, id))
        .send()
        .await?;

    if !meta_response.status().is_success() {
        if meta_response.status() == reqwest::StatusCode::NOT_FOUND {
            anyhow::bail!("Share not found or expired");
        }
        anyhow::bail!("Failed to fetch: {}", meta_response.status());
    }

    let meta: ShareMeta = meta_response.json().await?;
    let is_binary = is_binary_content_type(&meta.content_type);
    let is_tty = atty::is(atty::Stream::Stdout);
    let is_encrypted = meta.encrypted.unwrap_or(false);

    let response = client
        .get(format!("{}/{}/raw", base_url, id))
        .send()
        .await?;

    if !response.status().is_success() {
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            anyhow::bail!("Share not found or expired");
        }
        anyhow::bail!("Failed to fetch: {}", response.status());
    }

    if is_encrypted {
        let key = decryption_key.context("Missing decryption key in share URL")?;
        let decrypted = if meta.storage_type.as_deref() == Some("kv") {
            let encoded = response.text().await?;
            let ciphertext = base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .context("Failed to decode encrypted content")?;
            decrypt_content(&ciphertext, &key)?
        } else {
            let ciphertext = response.bytes().await?;
            decrypt_content(ciphertext.as_ref(), &key)?
        };

        if is_binary && is_tty {
            let default_filename = format!("{}.bin", id);
            let filename = meta
                .filename
                .as_deref()
                .or(meta.name.as_deref())
                .unwrap_or(&default_filename);
            let save_path = get_unique_filename(filename);
            let mut file = tokio::fs::File::create(&save_path).await?;
            file.write_all(&decrypted).await?;
            file.flush().await?;

            if !cli.quiet {
                println!("{} {}", "→".green(), save_path.cyan());
            }
            return Ok(());
        }

        let mut stdout = tokio::io::stdout();
        stdout.write_all(&decrypted).await?;
        stdout.flush().await?;
        return Ok(());
    }

    let content_length = meta.size;
    let upload_speed = get_upload_speed();
    let estimated_seconds = content_length as f64 / upload_speed;
    let show_progress = estimated_seconds > 10.0 && !cli.quiet && !cli.json && is_tty;

    let progress_bar = if show_progress {
        let pb = ProgressBar::new(content_length);
        pb.set_style(
            ProgressStyle::default_bar()
                .template("{spinner:.green} [{bar:30.cyan/blue}] {bytes}/{total_bytes} @ {bytes_per_sec} ({eta})")
                .unwrap()
                .progress_chars("━━─"),
        );
        pb.enable_steady_tick(std::time::Duration::from_millis(100));
        Some(pb)
    } else {
        None
    };

    if is_binary && is_tty {
        let default_filename = format!("{}.bin", id);
        let filename = meta
            .filename
            .as_deref()
            .or(meta.name.as_deref())
            .unwrap_or(&default_filename);
        let save_path = get_unique_filename(filename);

        let mut file = tokio::fs::File::create(&save_path).await?;
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if let Some(ref pb) = progress_bar {
                pb.inc(chunk.len() as u64);
            }
            file.write_all(&chunk).await?;
        }

        if let Some(pb) = progress_bar {
            pb.finish_and_clear();
        }

        if !cli.quiet {
            println!("{} {}", "→".green(), save_path.cyan());
        }
    } else {
        let mut stream = response.bytes_stream();
        let mut stdout = tokio::io::stdout();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if let Some(ref pb) = progress_bar {
                pb.inc(chunk.len() as u64);
            }
            stdout.write_all(&chunk).await?;
        }

        if let Some(pb) = progress_bar {
            pb.finish_and_clear();
        }

        stdout.flush().await?;
    }

    Ok(())
}

async fn upload_from_source(cli: &Cli, input: Option<&str>) -> Result<()> {
    if cli.clipboard {
        let content = get_clipboard()?;
        return push_content(cli, content, None, None, Some("clipboard".to_string())).await;
    }

    if let Some(input) = input {
        if std::path::Path::new(input).exists() {
            return upload_file_streaming(cli, input).await;
        }
        return push_content(
            cli,
            input.to_string(),
            None,
            None,
            Some("inline".to_string()),
        )
        .await;
    }

    if atty::isnt(atty::Stream::Stdin) {
        let mut content = String::new();
        io::stdin().read_to_string(&mut content)?;
        if content.is_empty() {
            anyhow::bail!("No content provided");
        }
        return push_content(cli, content, None, None, Some("stdin".to_string())).await;
    }

    println!("{}", "Usage: shrd [OPTIONS] [INPUT]".yellow());
    println!();
    println!("Examples:");
    println!(
        "  {} | shrd           # Share from pipe",
        "cat file.txt".dimmed()
    );
    println!("  {} file.txt           # Share a file", "shrd".dimmed());
    println!(
        "  {} upload file.txt    # Explicit upload mode",
        "shrd".dimmed()
    );
    println!("  {} get abc123         # Retrieve by ID", "shrd".dimmed());
    println!(
        "  {} recent             # Show recent shares",
        "shrd".dimmed()
    );
    println!("  {} -c                 # Share clipboard", "shrd".dimmed());
    println!();
    println!("Run {} for more options.", "shrd --help".cyan());

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match &cli.command {
        Some(Commands::Upload { input }) => {
            return upload_from_source(&cli, input.as_deref()).await
        }
        Some(Commands::Get { id }) => return pull_content(&cli, id).await,
        Some(Commands::Recent { limit, copy }) => return print_recent_shares(&cli, *limit, *copy),
        Some(Commands::Config { action }) => {
            match action {
                ConfigAction::SetUrl { url } => {
                    save_config_url(url)?;
                    println!("{} Base URL set to: {}", "✓".green(), url.cyan());
                }
                ConfigAction::Show => {
                    let base_url = get_base_url();
                    let config_dir = get_config_dir()?;
                    let history_count = load_history().map(|entries| entries.len()).unwrap_or(0);
                    println!("Configuration:");
                    println!("  Base URL: {}", base_url.cyan());
                    println!("  Config dir: {}", config_dir.display());
                    println!("  Recent shares: {}", history_count);
                }
                ConfigAction::Reset => {
                    let config_dir = get_config_dir()?;
                    let config_file = config_dir.join("config.json");
                    if config_file.exists() {
                        std::fs::remove_file(&config_file)?;
                    }
                    println!("{} Configuration reset to defaults", "✓".green());
                }
            }
            return Ok(());
        }
        None => {}
    }

    if let Some(ref input) = cli.input {
        if cli.meta || looks_like_share_reference(input) {
            return pull_content(&cli, input).await;
        }
        return upload_from_source(&cli, Some(input)).await;
    }

    upload_from_source(&cli, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let original = b"Hello, World!";
        let (ciphertext, key) = encrypt_content(original).expect("encryption failed");
        let decrypted = decrypt_content(&ciphertext, &key).expect("decryption failed");
        assert_eq!(original.to_vec(), decrypted);
    }

    #[test]
    fn encrypt_decrypt_empty_content() {
        let original = b"";
        let (ciphertext, key) = encrypt_content(original).expect("encryption failed");
        let decrypted = decrypt_content(&ciphertext, &key).expect("decryption failed");
        assert_eq!(original.to_vec(), decrypted);
    }

    #[test]
    fn encrypt_decrypt_unicode() {
        let original = "Hello 世界 🌍 Привет мир".as_bytes();
        let (ciphertext, key) = encrypt_content(original).expect("encryption failed");
        let decrypted = decrypt_content(&ciphertext, &key).expect("decryption failed");
        assert_eq!(original.to_vec(), decrypted);
    }

    #[test]
    fn encrypt_decrypt_large_content() {
        let original: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
        let (ciphertext, key) = encrypt_content(&original).expect("encryption failed");
        let decrypted = decrypt_content(&ciphertext, &key).expect("decryption failed");
        assert_eq!(original, decrypted);
    }

    #[test]
    fn encrypt_produces_different_ciphertext_each_time() {
        let original = b"Same content";
        let (ciphertext1, _key1) = encrypt_content(original).expect("encryption failed");
        let (ciphertext2, _key2) = encrypt_content(original).expect("encryption failed");
        assert_ne!(
            ciphertext1, ciphertext2,
            "ciphertext should differ due to random nonce/key"
        );
    }

    #[test]
    fn decrypt_fails_with_wrong_key() {
        let original = b"Secret data";
        let (ciphertext, _correct_key) = encrypt_content(original).expect("encryption failed");

        let wrong_key = URL_SAFE_NO_PAD.encode([0u8; KEY_LEN]);
        let result = decrypt_content(&ciphertext, &wrong_key);
        assert!(result.is_err(), "decryption should fail with wrong key");
    }

    #[test]
    fn decrypt_fails_with_corrupted_ciphertext() {
        let original = b"Secret data";
        let (mut ciphertext, key) = encrypt_content(original).expect("encryption failed");

        if let Some(byte) = ciphertext.get_mut(NONCE_LEN + 5) {
            *byte ^= 0xFF;
        }

        let result = decrypt_content(&ciphertext, &key);
        assert!(
            result.is_err(),
            "decryption should fail with corrupted ciphertext"
        );
    }

    #[test]
    fn decrypt_fails_with_truncated_ciphertext() {
        let result = decrypt_content(&[0u8; 5], "some_key");
        assert!(
            result.is_err(),
            "decryption should fail with too-short ciphertext"
        );
    }

    #[test]
    fn decrypt_fails_with_invalid_key_length() {
        let original = b"Secret data";
        let (ciphertext, _key) = encrypt_content(original).expect("encryption failed");

        let short_key = URL_SAFE_NO_PAD.encode([0u8; 16]);
        let result = decrypt_content(&ciphertext, &short_key);
        assert!(
            result.is_err(),
            "decryption should fail with wrong key length"
        );
    }

    #[test]
    fn ciphertext_contains_nonce_prefix() {
        let original = b"Test";
        let (ciphertext, _key) = encrypt_content(original).expect("encryption failed");
        assert!(
            ciphertext.len() >= NONCE_LEN,
            "ciphertext should contain nonce prefix"
        );
    }

    #[test]
    fn key_is_valid_base64() {
        let original = b"Test";
        let (_ciphertext, key) = encrypt_content(original).expect("encryption failed");
        let decoded = URL_SAFE_NO_PAD.decode(&key);
        assert!(decoded.is_ok(), "key should be valid base64");
        assert_eq!(
            decoded.unwrap().len(),
            KEY_LEN,
            "decoded key should be 32 bytes"
        );
    }

    #[test]
    fn parse_id_and_key_with_key() {
        let (id, key) = parse_id_and_key("abc123#mykey");
        assert_eq!(id, "abc123");
        assert_eq!(key, Some("mykey".to_string()));
    }

    #[test]
    fn parse_id_and_key_with_key_prefix() {
        let (id, key) = parse_id_and_key("abc123#key=mykey");
        assert_eq!(id, "abc123");
        assert_eq!(key, Some("mykey".to_string()));
    }

    #[test]
    fn parse_id_and_key_without_key() {
        let (id, key) = parse_id_and_key("abc123");
        assert_eq!(id, "abc123");
        assert_eq!(key, None);
    }

    #[test]
    fn normalize_share_id_handles_full_urls() {
        let id = normalize_share_id("https://shrd.stoff.dev/deploy_log/raw#key=secret");
        assert_eq!(id, "deploy_log");
    }

    #[test]
    fn looks_like_share_reference_only_auto_pulls_for_urls_and_generated_ids() {
        assert!(looks_like_share_reference("abc123"));
        assert!(looks_like_share_reference("https://shrd.sh/custom_name"));
        assert!(!looks_like_share_reference("hello"));
        assert!(!looks_like_share_reference("release_notes"));
    }

    #[test]
    fn cli_supports_upload_subcommand_and_expires_alias() {
        let cli = Cli::try_parse_from(["shrd", "upload", "--expires", "7d", "notes.txt"])
            .expect("cli should parse");

        assert_eq!(cli.expire.as_deref(), Some("7d"));
        match cli.command {
            Some(Commands::Upload { input }) => {
                assert_eq!(input.as_deref(), Some("notes.txt"));
            }
            _ => panic!("expected upload command"),
        }
    }

    #[test]
    fn cli_supports_get_subcommand() {
        let cli = Cli::try_parse_from(["shrd", "get", "release_notes#key=abc"])
            .expect("cli should parse");

        match cli.command {
            Some(Commands::Get { id }) => {
                assert_eq!(id, "release_notes#key=abc");
            }
            _ => panic!("expected get command"),
        }
    }

    #[test]
    fn cli_supports_recent_alias() {
        let cli = Cli::try_parse_from(["shrd", "list", "--limit", "5"]).expect("cli should parse");

        match cli.command {
            Some(Commands::Recent { limit, copy }) => {
                assert_eq!(limit, 5);
                assert!(!copy);
            }
            _ => panic!("expected recent command"),
        }
    }

    #[test]
    fn cli_supports_mode_flag() {
        let cli = Cli::try_parse_from(["shrd", "--mode", "permanent", "notes.txt"])
            .expect("cli should parse");

        assert_eq!(cli.mode, Some(ShareMode::Permanent));
    }

    #[test]
    fn lowercase_v_is_version_flag() {
        let err = Cli::try_parse_from(["shrd", "-v"]).expect_err("version should exit early");
        assert_eq!(err.kind(), clap::error::ErrorKind::DisplayVersion);
    }
}
