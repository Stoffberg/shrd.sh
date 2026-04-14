use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use clap::{Args, Parser, Subcommand, ValueEnum};
use colored::Colorize;
use futures::stream::{self, StreamExt};
use fuzzy_matcher::{skim::SkimMatcherV2, FuzzyMatcher};
use indicatif::{ProgressBar, ProgressStyle};
use reqwest::{Body, StatusCode};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::digest::{digest, SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::io::{self, IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

const DEFAULT_BASE_URL: &str = "https://shrd.stoff.dev";
const KEY_LEN: usize = 32;
const GENERATED_ID_LEN: usize = 6;
const MAX_HISTORY_ITEMS: usize = 50;
const INLINE_STORAGE_LIMIT: usize = 25 * 1024;
const ROOT_AFTER_HELP: &str = "Examples:\n  shrd \"hello world\"\n  shrd notes.txt\n  cat deploy.log | shrd --mode temporary\n  shrd get last\n  shrd list\n";
const UPLOAD_AFTER_HELP: &str = "Examples:\n  shrd upload notes.txt\n  shrd upload --mode private secrets.txt\n  cat deploy.log | shrd upload --expire 1h\n  shrd upload --name release-notes README.md\n";
const GET_AFTER_HELP: &str = "Examples:\n  shrd get abc123\n  shrd get last\n  shrd get https://shrd.stoff.dev/release-notes#key=secret\n  shrd get abc123 --meta\n";
const LIST_AFTER_HELP: &str =
    "Examples:\n  shrd list\n  shrd list --limit 20\n  shrd list --copy\n  shrd list --json\n";
const CONFIG_AFTER_HELP: &str = "Examples:\n  shrd config show\n  shrd config set-url https://shrd.example.com\n  shrd config ai status\n  shrd config ai presets\n  shrd config ai install codex\n";
const AI_INSTALL_AFTER_HELP: &str =
    "Examples:\n  shrd config ai install\n  shrd config ai install codex\n  shrd config ai install --preset all --yes\n  shrd config ai install claude --force\n";
const AI_REMOVE_AFTER_HELP: &str =
    "Examples:\n  shrd config ai remove cursor\n  shrd config ai remove --preset all --yes\n";

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

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq)]
enum HistoryModeFilter {
    Temporary,
    Private,
    Permanent,
    Default,
    Encrypted,
}

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum HistoryKind {
    Text,
    Json,
    Markdown,
    Image,
    Audio,
    Video,
    Binary,
}

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq)]
enum HistorySourceFilter {
    Inline,
    Stdin,
    Clipboard,
    Path,
}

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq)]
enum AiTool {
    Cursor,
    Codex,
    #[value(alias = "claude")]
    ClaudeCode,
    Opencode,
    All,
}

#[derive(Clone, Copy, Debug, ValueEnum, PartialEq, Eq)]
enum AiPreset {
    All,
}

#[derive(Debug, Args, Clone, Default)]
struct AiTargetOptions {
    #[arg(value_enum, help = "Tool to configure", conflicts_with = "preset")]
    tool: Option<AiTool>,

    #[arg(
        long,
        value_enum,
        help = "Preset to configure",
        conflicts_with = "tool"
    )]
    preset: Option<AiPreset>,
}

#[derive(Debug, Args, Clone, Default)]
struct UploadOptions {
    #[arg(
        short = 'x',
        long = "expire",
        alias = "expires",
        help = "Expiry time (1h, 24h, 7d, 30d, never)"
    )]
    expire: Option<String>,

    #[arg(short, long, help = "Delete after first view")]
    burn: bool,

    #[arg(short, long, help = "End-to-end encrypt (key in URL fragment)")]
    encrypt: bool,

    #[arg(short, long, help = "Custom name/slug")]
    name: Option<String>,

    #[arg(
        long,
        value_enum,
        help = "Sharing preset: temporary, private, permanent"
    )]
    mode: Option<ShareMode>,

    #[arg(short, long, help = "Output as JSON")]
    json: bool,

    #[arg(short, long, help = "Suppress output except errors")]
    quiet: bool,

    #[arg(long, help = "Don't copy to clipboard")]
    no_copy: bool,

    #[arg(short, long, help = "Share clipboard contents")]
    clipboard: bool,

    #[arg(long, help = "Resume a failed multipart upload from a manifest path")]
    resume: Option<String>,
}

#[derive(Debug, Args, Clone, Default)]
struct GetOptions {
    #[arg(long, help = "Get metadata instead of content")]
    meta: bool,

    #[arg(short, long, help = "Suppress output except errors")]
    quiet: bool,

    #[arg(long, help = "Write exact bytes to stdout")]
    raw: bool,

    #[arg(
        short = 'o',
        long,
        help = "Write to a file path, directory, or '-' for stdout"
    )]
    output: Option<String>,

    #[arg(long, help = "Open the fetched content with the default app")]
    open: bool,

    #[arg(long, help = "Copy fetched text content to the clipboard")]
    copy: bool,
}

#[derive(Debug, Args, Clone, Default)]
struct ListOptions {
    #[arg(short, long, default_value_t = 10, help = "How many shares to show")]
    limit: usize,

    #[arg(long, help = "Copy the newest share URL")]
    copy: bool,

    #[arg(short, long, help = "Output as JSON")]
    json: bool,

    #[arg(long, help = "Fuzzy-match recent shares")]
    query: Option<String>,

    #[arg(long, help = "Filter by exact share name")]
    name: Option<String>,

    #[arg(long, value_enum, help = "Filter by mode")]
    mode: Option<HistoryModeFilter>,

    #[arg(long = "type", value_enum, help = "Filter by content kind")]
    kind: Option<HistoryKind>,

    #[arg(long, value_enum, help = "Filter by source")]
    source: Option<HistorySourceFilter>,

    #[arg(long, help = "Filter by age like 15m, 1h, 7d")]
    age: Option<String>,
}

#[derive(Debug, Args, Clone, Default)]
struct ConfigOptions {
    #[arg(short, long, global = true, help = "Output as JSON")]
    json: bool,
}

#[derive(Debug, Parser)]
#[command(name = "shrd")]
#[command(about = "Share anything, instantly", long_about = None)]
#[command(version, disable_version_flag = true)]
#[command(after_help = ROOT_AFTER_HELP)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(help = "Content ID to retrieve, or content to share")]
    input: Option<String>,

    #[command(flatten)]
    upload: UploadOptions,

    #[arg(short = 'v', long = "version", action = clap::ArgAction::Version, help = "Print version")]
    version: Option<bool>,

    #[arg(long, help = "Get metadata instead of content")]
    meta: bool,
}

#[derive(Debug, Subcommand)]
enum Commands {
    #[command(about = "Share text or a file", after_help = UPLOAD_AFTER_HELP)]
    Upload {
        #[arg(help = "Text to share or a file path")]
        input: Option<String>,

        #[command(flatten)]
        options: UploadOptions,
    },
    #[command(about = "Retrieve an existing share", after_help = GET_AFTER_HELP)]
    Get {
        #[arg(help = "Share ID, URL, or 'last'")]
        id: String,

        #[command(flatten)]
        options: GetOptions,
    },
    #[command(
        about = "Show recent shares from local history",
        visible_alias = "recent",
        after_help = LIST_AFTER_HELP
    )]
    List {
        #[command(flatten)]
        options: ListOptions,
    },
    #[command(about = "Search local share history", after_help = LIST_AFTER_HELP)]
    Search {
        #[arg(help = "Search query")]
        term: String,

        #[command(flatten)]
        options: ListOptions,
    },
    #[command(about = "Configure shrd settings", after_help = CONFIG_AFTER_HELP)]
    Config {
        #[command(flatten)]
        options: ConfigOptions,

        #[command(subcommand)]
        action: ConfigAction,
    },
}

#[derive(Debug, Subcommand)]
enum ConfigAction {
    #[command(about = "Set the API base URL (for self-hosted instances)")]
    SetUrl { url: String },
    #[command(about = "Install or manage global AI skills")]
    Ai {
        #[command(subcommand)]
        action: AiConfigAction,
    },
    #[command(about = "Show current configuration")]
    Show,
    #[command(about = "Reset to default configuration")]
    Reset,
}

#[derive(Debug, Subcommand)]
enum AiConfigAction {
    #[command(
        about = "Install the shrd skill into a supported AI tool",
        after_help = AI_INSTALL_AFTER_HELP
    )]
    Install {
        #[command(flatten)]
        target: AiTargetOptions,
        #[arg(long, help = "Replace customized skill directories")]
        force: bool,
        #[arg(
            short = 'y',
            long,
            help = "Skip confirmation when defaulting to all tools"
        )]
        yes: bool,
    },
    #[command(
        about = "Remove the shrd skill from a supported AI tool",
        after_help = AI_REMOVE_AFTER_HELP
    )]
    Remove {
        #[command(flatten)]
        target: AiTargetOptions,
        #[arg(long, help = "Remove customized skill directories")]
        force: bool,
        #[arg(
            short = 'y',
            long,
            help = "Skip confirmation when defaulting to all tools"
        )]
        yes: bool,
    },
    #[command(about = "Show installed AI skill status")]
    Status {
        #[command(flatten)]
        target: AiTargetOptions,
    },
    #[command(about = "List supported AI presets")]
    Presets,
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

#[derive(Serialize, Deserialize, Clone, Default)]
struct HistoryEntry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    raw_url: String,
    #[serde(default)]
    delete_url: String,
    #[serde(default)]
    delete_token: String,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    filename: Option<String>,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    kind: Option<HistoryKind>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    storage_type: Option<String>,
    #[serde(default)]
    created_at: u64,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    encrypted: bool,
    #[serde(default)]
    burn: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct HistoryFile {
    version: u8,
    entries: Vec<HistoryEntry>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum HistoryOnDisk {
    V1(Vec<HistoryEntry>),
    V2(HistoryFile),
}

#[derive(Deserialize)]
struct MultipartInitResponse {
    id: String,
    #[serde(rename = "uploadId")]
    upload_id: String,
    #[serde(rename = "resumeToken")]
    resume_token: String,
    #[serde(rename = "partSize")]
    part_size: u64,
}

#[derive(Deserialize)]
struct MultipartStatusResponse {
    #[serde(rename = "uploadedParts")]
    uploaded_parts: Vec<MultipartUploadedPart>,
    #[serde(rename = "partSize")]
    part_size: u64,
}

#[derive(Serialize, Deserialize, Clone)]
struct MultipartUploadedPart {
    #[serde(rename = "partNumber")]
    part_number: u64,
    etag: String,
    sha256: String,
    size: u64,
}

#[derive(Serialize, Deserialize)]
struct MultipartResumeManifest {
    file_path: String,
    file_size: u64,
    base_url: String,
    share_id: String,
    upload_id: String,
    resume_token: String,
    part_size: u64,
    uploaded_parts: Vec<MultipartUploadedPart>,
    idempotency_key: String,
    filename: String,
    content_type: String,
    encryption_key: Option<String>,
    created_at: u64,
}

#[derive(Deserialize)]
struct MultipartPartUploadResponse {
    #[serde(rename = "partNumber")]
    part_number: u64,
    etag: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AiSkillTarget {
    tool: AiTool,
    skill_dir: PathBuf,
    skill_file: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AiSkillState {
    Missing,
    Installed,
    Customized,
}

#[derive(Serialize)]
struct AiSkillStatus {
    tool: String,
    status: String,
    path: String,
}

#[derive(Serialize)]
struct AiPresetStatus {
    preset: String,
    tools: Vec<String>,
    default: bool,
}

#[derive(Serialize)]
struct ConfigSummary {
    #[serde(rename = "baseUrl")]
    base_url: String,
    #[serde(rename = "configDir")]
    config_dir: String,
    #[serde(rename = "recentShares")]
    recent_shares: usize,
    #[serde(rename = "aiSkills")]
    ai_skills: Vec<AiSkillStatus>,
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
    let parsed: HistoryOnDisk =
        serde_json::from_str(&content).unwrap_or(HistoryOnDisk::V1(Vec::new()));
    Ok(match parsed {
        HistoryOnDisk::V1(entries) => entries,
        HistoryOnDisk::V2(file) => file.entries,
    })
}

fn save_history(entries: &[HistoryEntry]) -> Result<()> {
    let history_file = history_file_path()?;
    std::fs::write(
        history_file,
        serde_json::to_string_pretty(&HistoryFile {
            version: 2,
            entries: entries.to_vec(),
        })?,
    )?;
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

fn history_mode_label(options: &UploadOptions) -> String {
    if let Some(mode) = effective_mode(options) {
        return mode_label(mode).to_string();
    }

    if effective_encrypt(options) {
        return "encrypted".to_string();
    }

    "default".to_string()
}

fn infer_history_kind(content_type: &str) -> HistoryKind {
    match content_type {
        "application/json" => HistoryKind::Json,
        "text/markdown" => HistoryKind::Markdown,
        _ if content_type.starts_with("image/") => HistoryKind::Image,
        _ if content_type.starts_with("audio/") => HistoryKind::Audio,
        _ if content_type.starts_with("video/") => HistoryKind::Video,
        _ if content_type.starts_with("text/") => HistoryKind::Text,
        _ => HistoryKind::Binary,
    }
}

fn root_get_options(cli: &Cli) -> GetOptions {
    GetOptions {
        meta: cli.meta,
        quiet: cli.upload.quiet,
        raw: false,
        output: None,
        open: false,
        copy: false,
    }
}

fn effective_mode(options: &UploadOptions) -> Option<ShareMode> {
    options.mode
}

fn effective_expire(options: &UploadOptions) -> Option<String> {
    if let Some(expire) = &options.expire {
        return Some(expire.clone());
    }

    match effective_mode(options) {
        Some(ShareMode::Temporary) => Some("1h".to_string()),
        Some(ShareMode::Permanent) => Some("never".to_string()),
        _ => None,
    }
}

fn effective_encrypt(options: &UploadOptions) -> bool {
    options.encrypt || matches!(effective_mode(options), Some(ShareMode::Private))
}

fn effective_burn(options: &UploadOptions) -> bool {
    options.burn
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

fn get_home_dir() -> Result<PathBuf> {
    dirs::home_dir().context("Could not find home directory")
}

fn get_xdg_config_home() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(path));
    }

    Ok(get_home_dir()?.join(".config"))
}

fn canonical_shrd_skill() -> &'static str {
    include_str!("../assets/shrd-skill.txt")
}

impl AiTool {
    fn label(self) -> &'static str {
        match self {
            AiTool::Cursor => "cursor",
            AiTool::Codex => "codex",
            AiTool::ClaudeCode => "claude-code",
            AiTool::Opencode => "opencode",
            AiTool::All => "all",
        }
    }
}

impl AiPreset {
    fn label(self) -> &'static str {
        match self {
            AiPreset::All => "all",
        }
    }

    fn tools(self) -> Vec<AiTool> {
        match self {
            AiPreset::All => vec![
                AiTool::Cursor,
                AiTool::Codex,
                AiTool::ClaudeCode,
                AiTool::Opencode,
            ],
        }
    }
}

impl AiSkillState {
    fn label(self) -> &'static str {
        match self {
            AiSkillState::Missing => "missing",
            AiSkillState::Installed => "installed",
            AiSkillState::Customized => "customized",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AiSelection {
    Tool(AiTool),
    Preset(AiPreset),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AiActionResult {
    Installed,
    Replaced,
    AlreadyInstalled,
    Removed,
    Missing,
}

impl AiSelection {
    fn label(self) -> &'static str {
        match self {
            AiSelection::Tool(tool) => tool.label(),
            AiSelection::Preset(preset) => preset.label(),
        }
    }

    fn tools(self) -> Vec<AiTool> {
        match self {
            AiSelection::Tool(tool) => vec![tool],
            AiSelection::Preset(preset) => preset.tools(),
        }
    }
}

fn resolve_ai_skill_targets_from_roots(
    home_dir: &Path,
    xdg_config_home: &Path,
    selection: AiSelection,
) -> Vec<AiSkillTarget> {
    selection
        .tools()
        .into_iter()
        .map(|tool| {
            let skill_dir = match tool {
                AiTool::Cursor => home_dir.join(".cursor").join("skills").join("shrd"),
                AiTool::Codex => home_dir.join(".codex").join("skills").join("shrd"),
                AiTool::ClaudeCode => home_dir.join(".claude").join("skills").join("shrd"),
                AiTool::Opencode => xdg_config_home.join("opencode").join("skills").join("shrd"),
                AiTool::All => unreachable!(),
            };

            AiSkillTarget {
                tool,
                skill_file: skill_dir.join("SKILL.md"),
                skill_dir,
            }
        })
        .collect()
}

fn resolve_ai_skill_targets(selection: AiSelection) -> Result<Vec<AiSkillTarget>> {
    Ok(resolve_ai_skill_targets_from_roots(
        &get_home_dir()?,
        &get_xdg_config_home()?,
        selection,
    ))
}

fn ai_skill_dir_has_extra_files(target: &AiSkillTarget) -> Result<bool> {
    if !target.skill_dir.exists() {
        return Ok(false);
    }

    for entry in std::fs::read_dir(&target.skill_dir)? {
        let entry = entry?;
        if entry.file_name() != "SKILL.md" {
            return Ok(true);
        }
    }

    Ok(false)
}

fn ai_skill_state(target: &AiSkillTarget) -> Result<AiSkillState> {
    if !target.skill_file.exists() {
        if target.skill_dir.exists() && ai_skill_dir_has_extra_files(target)? {
            return Ok(AiSkillState::Customized);
        }
        return Ok(AiSkillState::Missing);
    }

    let existing = std::fs::read_to_string(&target.skill_file)?;
    if existing == canonical_shrd_skill() && !ai_skill_dir_has_extra_files(target)? {
        return Ok(AiSkillState::Installed);
    }

    Ok(AiSkillState::Customized)
}

fn ai_skill_statuses(selection: AiSelection) -> Result<Vec<AiSkillStatus>> {
    let targets = resolve_ai_skill_targets(selection)?;
    targets
        .into_iter()
        .map(|target| {
            let state = ai_skill_state(&target)?;
            Ok(AiSkillStatus {
                tool: target.tool.label().to_string(),
                status: state.label().to_string(),
                path: target.skill_file.display().to_string(),
            })
        })
        .collect()
}

fn resolve_ai_selection(
    target: &AiTargetOptions,
    default_preset: Option<AiPreset>,
) -> (AiSelection, bool) {
    if let Some(tool) = target.tool {
        if tool == AiTool::All {
            return (AiSelection::Preset(AiPreset::All), true);
        }
        return (AiSelection::Tool(tool), true);
    }

    if let Some(preset) = target.preset {
        return (AiSelection::Preset(preset), true);
    }

    (
        AiSelection::Preset(default_preset.unwrap_or(AiPreset::All)),
        false,
    )
}

fn confirm_ai_default_selection(
    action: &str,
    selection: AiSelection,
    json: bool,
    yes: bool,
    explicit: bool,
) -> Result<()> {
    if explicit || yes {
        return Ok(());
    }

    if json {
        anyhow::bail!(
            "Refusing to default to preset '{}' in JSON mode. Re-run with --yes or choose a tool or --preset explicitly.",
            selection.label()
        );
    }

    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        anyhow::bail!(
            "Refusing to default to preset '{}' without a terminal. Re-run with --yes or choose a tool or --preset explicitly.",
            selection.label()
        );
    }

    let targets = selection
        .tools()
        .into_iter()
        .map(|tool| tool.label())
        .collect::<Vec<_>>()
        .join(", ");
    print!(
        "About to {} the shrd skill for preset '{}' ({}) [y/N]: ",
        action,
        selection.label(),
        targets
    );
    io::stdout().flush()?;

    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    let confirmed = matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes");
    if !confirmed {
        anyhow::bail!("Aborted.");
    }

    Ok(())
}

fn install_ai_skill_target(target: &AiSkillTarget, force: bool) -> Result<AiActionResult> {
    let state = ai_skill_state(target)?;
    if state == AiSkillState::Installed {
        return Ok(AiActionResult::AlreadyInstalled);
    }

    if state == AiSkillState::Customized && !force {
        anyhow::bail!(
            "{} has a customized shrd skill at {}. Re-run with --force to replace it.",
            target.tool.label(),
            target.skill_file.display()
        );
    }

    if target.skill_dir.exists() && force {
        std::fs::remove_dir_all(&target.skill_dir)?;
    }

    std::fs::create_dir_all(&target.skill_dir)?;
    std::fs::write(&target.skill_file, canonical_shrd_skill())?;
    Ok(if state == AiSkillState::Customized {
        AiActionResult::Replaced
    } else {
        AiActionResult::Installed
    })
}

fn remove_ai_skill_target(target: &AiSkillTarget, force: bool) -> Result<AiActionResult> {
    if !target.skill_dir.exists() {
        return Ok(AiActionResult::Missing);
    }

    let state = ai_skill_state(target)?;
    if state == AiSkillState::Customized && !force {
        anyhow::bail!(
            "{} has a customized shrd skill at {}. Re-run with --force to remove it.",
            target.tool.label(),
            target.skill_file.display()
        );
    }

    std::fs::remove_dir_all(&target.skill_dir)?;
    Ok(AiActionResult::Removed)
}

fn install_ai_skills(
    json: bool,
    selection: AiSelection,
    force: bool,
    explicit: bool,
    yes: bool,
) -> Result<()> {
    confirm_ai_default_selection("install", selection, json, yes, explicit)?;
    let targets = resolve_ai_skill_targets(selection)?;
    for target in &targets {
        let state = ai_skill_state(target)?;
        if state == AiSkillState::Customized && !force {
            anyhow::bail!(
                "{} has a customized shrd skill at {}. Re-run with --force to replace it.",
                target.tool.label(),
                target.skill_file.display()
            );
        }
    }

    let statuses: Vec<AiSkillStatus> = targets
        .iter()
        .map(|target| {
            let result = install_ai_skill_target(target, force)?;
            let status = match result {
                AiActionResult::Installed => "installed",
                AiActionResult::Replaced => "replaced",
                AiActionResult::AlreadyInstalled => "already-installed",
                _ => unreachable!(),
            };

            Ok(AiSkillStatus {
                tool: target.tool.label().to_string(),
                status: status.to_string(),
                path: target.skill_file.display().to_string(),
            })
        })
        .collect::<Result<_>>()?;

    if json {
        println!("{}", serde_json::to_string_pretty(&statuses)?);
    } else {
        println!("Configured shrd skill for {}", selection.label().cyan());
        for status in statuses {
            let prefix = match status.status.as_str() {
                "installed" => "✓".green(),
                "replaced" => "↺".yellow(),
                "already-installed" => "•".dimmed(),
                _ => unreachable!(),
            };
            println!(
                "{} {} for {} at {}",
                prefix,
                status.status.cyan(),
                status.tool.cyan(),
                status.path.dimmed()
            );
        }
    }

    Ok(())
}

fn remove_ai_skills(
    json: bool,
    selection: AiSelection,
    force: bool,
    explicit: bool,
    yes: bool,
) -> Result<()> {
    confirm_ai_default_selection("remove", selection, json, yes, explicit)?;
    let targets = resolve_ai_skill_targets(selection)?;
    let mut removed = Vec::new();

    for target in &targets {
        let state = ai_skill_state(target)?;
        if state == AiSkillState::Customized && !force {
            anyhow::bail!(
                "{} has a customized shrd skill at {}. Re-run with --force to remove it.",
                target.tool.label(),
                target.skill_file.display()
            );
        }
    }

    for target in &targets {
        let result = remove_ai_skill_target(target, force)?;
        let status = match result {
            AiActionResult::Removed => "removed",
            AiActionResult::Missing => "missing",
            _ => unreachable!(),
        };

        removed.push(AiSkillStatus {
            tool: target.tool.label().to_string(),
            status: status.to_string(),
            path: target.skill_file.display().to_string(),
        });
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&removed)?);
    } else {
        println!(
            "Configured shrd skill removal for {}",
            selection.label().cyan()
        );
        for status in removed {
            let prefix = if status.status == "removed" {
                "✓".green()
            } else {
                "•".yellow()
            };
            println!(
                "{} {} for {} at {}",
                prefix,
                status.status.cyan(),
                status.tool.cyan(),
                status.path.dimmed()
            );
        }
    }

    Ok(())
}

fn print_ai_skill_status(json: bool, selection: AiSelection) -> Result<()> {
    let statuses = ai_skill_statuses(selection)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&statuses)?);
        return Ok(());
    }

    println!("shrd AI skill status for {}", selection.label().cyan());
    println!("{:<14} {:<18} {}", "tool", "status", "path");
    for status in statuses {
        println!("{:<14} {:<18} {}", status.tool, status.status, status.path);
    }

    Ok(())
}

fn print_ai_presets(json: bool) -> Result<()> {
    let presets = vec![AiPresetStatus {
        preset: AiPreset::All.label().to_string(),
        tools: AiPreset::All
            .tools()
            .into_iter()
            .map(|tool| tool.label().to_string())
            .collect(),
        default: true,
    }];

    if json {
        println!("{}", serde_json::to_string_pretty(&presets)?);
    } else {
        println!("{:<14} {:<7} tools", "preset", "default");
        for preset in presets {
            println!(
                "{:<14} {:<7} {}",
                preset.preset,
                if preset.default { "yes" } else { "no" },
                preset.tools.join(", ")
            );
        }
    }

    Ok(())
}

fn print_config_show(json: bool) -> Result<()> {
    let base_url = get_base_url();
    let config_dir = get_config_dir()?;
    let history_count = load_history().map(|entries| entries.len()).unwrap_or(0);
    let ai_skills = ai_skill_statuses(AiSelection::Preset(AiPreset::All))?;

    if json {
        let summary = ConfigSummary {
            base_url,
            config_dir: config_dir.display().to_string(),
            recent_shares: history_count,
            ai_skills,
        };
        println!("{}", serde_json::to_string_pretty(&summary)?);
        return Ok(());
    }

    println!("Configuration:");
    println!("  Base URL: {}", base_url.cyan());
    println!("  Config dir: {}", config_dir.display());
    println!("  Recent shares: {}", history_count);
    println!("  AI skills:");
    for status in ai_skills {
        println!("    {}: {} ({})", status.tool, status.status, status.path);
    }

    Ok(())
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

fn generate_idempotency_key() -> Result<String> {
    let rng = SystemRandom::new();
    let mut bytes = [0u8; 24];
    rng.fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("Failed to generate idempotency key"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn sha256_hex(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect::<String>()
}

fn should_retry_status(status: StatusCode, response: &reqwest::Response) -> bool {
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT
            | StatusCode::TOO_EARLY
            | StatusCode::TOO_MANY_REQUESTS
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    ) || (status == StatusCode::CONFLICT && response.headers().get("Retry-After").is_some())
        || status.is_server_error()
}

async fn retry_delay(attempt: usize) {
    let jitter = (unix_now() % 250) + 50;
    let base_ms = 150u64.saturating_mul(1u64 << attempt.min(5));
    tokio::time::sleep(std::time::Duration::from_millis(base_ms + jitter)).await;
}

async fn send_with_retry<F>(mut make_request: F, attempts: usize) -> Result<reqwest::Response>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    let mut last_error: Option<anyhow::Error> = None;

    for attempt in 0..attempts {
        match make_request().send().await {
            Ok(response)
                if should_retry_status(response.status(), &response) && attempt + 1 < attempts =>
            {
                retry_delay(attempt).await;
                continue;
            }
            Ok(response) => return Ok(response),
            Err(error) if attempt + 1 < attempts => {
                last_error = Some(error.into());
                retry_delay(attempt).await;
            }
            Err(error) => return Err(error.into()),
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("request failed")))
}

fn uploads_dir() -> Result<PathBuf> {
    let dir = get_config_dir()?.join("uploads");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn manifest_path_for_upload(id: &str) -> Result<PathBuf> {
    Ok(uploads_dir()?.join(format!("{}.json", id)))
}

fn write_resume_manifest(manifest_path: &Path, manifest: &MultipartResumeManifest) -> Result<()> {
    std::fs::write(manifest_path, serde_json::to_string_pretty(manifest)?)?;
    Ok(())
}

fn read_resume_manifest(path: &str) -> Result<MultipartResumeManifest> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read manifest: {}", path))?;
    Ok(serde_json::from_str(&content)?)
}

fn parse_age_filter(value: &str) -> Result<u64> {
    let trimmed = value.trim();
    if trimmed.len() < 2 {
        anyhow::bail!("Invalid age filter");
    }
    let (amount, unit) = trimmed.split_at(trimmed.len() - 1);
    let parsed = amount.parse::<u64>().context("Invalid age filter")?;
    let seconds = match unit {
        "m" => parsed * 60,
        "h" => parsed * 60 * 60,
        "d" => parsed * 24 * 60 * 60,
        _ => anyhow::bail!("Invalid age filter"),
    };
    Ok(seconds)
}

fn history_source_label(source: Option<&str>) -> Option<String> {
    match source {
        Some("inline") => Some("inline".to_string()),
        Some("stdin") => Some("stdin".to_string()),
        Some("clipboard") => Some("clipboard".to_string()),
        Some(_) => Some("path".to_string()),
        None => None,
    }
}

fn matches_history_mode(entry: &HistoryEntry, filter: HistoryModeFilter) -> bool {
    let mode = entry.mode.as_deref().unwrap_or("default");
    match filter {
        HistoryModeFilter::Temporary => mode == "temporary",
        HistoryModeFilter::Private => mode == "private",
        HistoryModeFilter::Permanent => mode == "permanent",
        HistoryModeFilter::Default => mode == "default",
        HistoryModeFilter::Encrypted => mode == "encrypted",
    }
}

fn matches_history_source(entry: &HistoryEntry, filter: HistorySourceFilter) -> bool {
    let source = entry.source.as_deref().unwrap_or("inline");
    match filter {
        HistorySourceFilter::Inline => source == "inline",
        HistorySourceFilter::Stdin => source == "stdin",
        HistorySourceFilter::Clipboard => source == "clipboard",
        HistorySourceFilter::Path => source == "path",
    }
}

fn history_match_score(entry: &HistoryEntry, query: &str) -> Option<i64> {
    let matcher = SkimMatcherV2::default();
    [
        entry.id.as_str(),
        entry.name.as_deref().unwrap_or_default(),
        entry.filename.as_deref().unwrap_or_default(),
        entry.url.as_str(),
        entry.source.as_deref().unwrap_or_default(),
    ]
    .into_iter()
    .filter_map(|value| matcher.fuzzy_match(value, query))
    .max()
}

fn filter_history_entries(
    entries: Vec<HistoryEntry>,
    options: &ListOptions,
) -> Result<Vec<HistoryEntry>> {
    let max_age = options.age.as_deref().map(parse_age_filter).transpose()?;
    let now = unix_now();
    let mut filtered = entries
        .into_iter()
        .filter(|entry| {
            options
                .name
                .as_deref()
                .map(|name| entry.name.as_deref() == Some(name))
                .unwrap_or(true)
        })
        .filter(|entry| {
            options
                .mode
                .map(|mode| matches_history_mode(entry, mode))
                .unwrap_or(true)
        })
        .filter(|entry| {
            options
                .kind
                .map(|kind| entry.kind == Some(kind))
                .unwrap_or(true)
        })
        .filter(|entry| {
            options
                .source
                .map(|source| matches_history_source(entry, source))
                .unwrap_or(true)
        })
        .filter(|entry| {
            max_age
                .map(|age| now.saturating_sub(entry.created_at) <= age)
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();

    if let Some(query) = options.query.as_deref() {
        let mut scored = filtered
            .drain(..)
            .filter_map(|entry| history_match_score(&entry, query).map(|score| (score, entry)))
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| {
            right
                .0
                .cmp(&left.0)
                .then_with(|| right.1.created_at.cmp(&left.1.created_at))
        });
        filtered = scored.into_iter().map(|(_, entry)| entry).collect();
    }

    Ok(filtered)
}

fn preferred_filename(meta: &ShareMeta, id: &str) -> String {
    if let Some(filename) = meta.filename.as_deref() {
        return filename.to_string();
    }

    if let Some(name) = meta.name.as_deref() {
        return name.to_string();
    }

    let extension = if is_binary_content_type(&meta.content_type) {
        "bin"
    } else {
        "txt"
    };
    format!("{}.{}", id, extension)
}

enum OutputTarget {
    Stdout,
    File(PathBuf),
}

fn resolve_output_target(
    meta: &ShareMeta,
    id: &str,
    output: Option<&str>,
) -> Result<Option<OutputTarget>> {
    let Some(output) = output else {
        return Ok(None);
    };

    if output == "-" {
        return Ok(Some(OutputTarget::Stdout));
    }

    let path = PathBuf::from(output);
    let final_path = if path.is_dir() {
        path.join(preferred_filename(meta, id))
    } else {
        path
    };

    if final_path.exists() {
        anyhow::bail!("Output path already exists: {}", final_path.display());
    }

    Ok(Some(OutputTarget::File(final_path)))
}

fn temp_output_path(meta: &ShareMeta, id: &str) -> PathBuf {
    let unique = unix_now();
    std::env::temp_dir().join(format!("{}-{}", unique, preferred_filename(meta, id)))
}

fn upload_progress_bar(total: u64, options: &UploadOptions) -> Option<ProgressBar> {
    let upload_speed = get_upload_speed();
    let estimated_seconds = total as f64 / upload_speed;
    if estimated_seconds <= 10.0 || options.quiet || options.json {
        return None;
    }

    let pb = ProgressBar::new(total);
    pb.set_style(
        ProgressStyle::default_bar()
            .template("{spinner:.green} [{bar:30.cyan/blue}] {bytes}/{total_bytes} @ {bytes_per_sec} ({eta})")
            .unwrap()
            .progress_chars("━━─"),
    );
    pb.enable_steady_tick(std::time::Duration::from_millis(100));
    Some(pb)
}

fn body_from_bytes(bytes: Vec<u8>, progress_bar: Option<ProgressBar>) -> Body {
    if let Some(pb) = progress_bar {
        let pb_clone = pb.clone();
        let chunks: Vec<Vec<u8>> = bytes.chunks(8192).map(|chunk| chunk.to_vec()).collect();
        let stream = stream::iter(chunks).map(move |chunk| {
            pb_clone.inc(chunk.len() as u64);
            Ok::<_, std::io::Error>(chunk)
        });
        Body::wrap_stream(stream)
    } else {
        Body::from(bytes)
    }
}

async fn push_content(
    options: &UploadOptions,
    content: String,
    content_type: Option<String>,
    filename: Option<String>,
    source: Option<String>,
) -> Result<()> {
    let client = reqwest::Client::new();
    let base_url = get_base_url();
    let encrypt = effective_encrypt(options);
    let burn = effective_burn(options);
    let expire = effective_expire(options);
    let idempotency_key = generate_idempotency_key()?;
    let source_label = history_source_label(source.as_deref());

    let (final_content, encryption_key) = if encrypt {
        let (encrypted_content, key) = encrypt_content(content.as_bytes())?;
        (
            base64::engine::general_purpose::STANDARD.encode(&encrypted_content),
            Some(key),
        )
    } else {
        (content, None)
    };

    let request = PushRequest {
        content: final_content.clone(),
        expire,
        burn,
        name: options.name.clone(),
        content_type: content_type.clone(),
        filename: filename.clone(),
        encrypted: encrypt,
    };

    let body_bytes = serde_json::to_vec(&request)?;
    let progress_bar = upload_progress_bar(body_bytes.len() as u64, options);
    let start_time = Instant::now();

    let response = send_with_retry(
        || {
            client
                .post(format!("{}/api/v1/push", base_url))
                .header("Content-Type", "application/json")
                .header("X-Idempotency-Key", &idempotency_key)
                .body(body_from_bytes(body_bytes.clone(), progress_bar.clone()))
        },
        5,
    )
    .await?;

    if let Some(pb) = progress_bar {
        pb.finish_and_clear();
    }

    save_upload_speed(
        body_bytes.len() as f64 / start_time.elapsed().as_secs_f64(),
        body_bytes.len(),
    );

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Failed to push: {} - {}", status, body);
    }

    let result: PushResponse = response.json().await?;
    print_result(options, &result, encryption_key.as_deref());
    let _ = record_history(
        options,
        &result,
        encryption_key.as_deref(),
        HistoryRecordInput {
            source: source_label,
            content_type: content_type.clone(),
            filename,
            size: Some(final_content.len() as u64),
            storage_type: Some(if final_content.len() <= INLINE_STORAGE_LIMIT {
                "kv".to_string()
            } else {
                "r2".to_string()
            }),
        },
    );

    Ok(())
}

const MULTIPART_THRESHOLD: u64 = 95 * 1024 * 1024;
async fn upload_file_streaming(options: &UploadOptions, path: &str) -> Result<()> {
    let path_obj = Path::new(path);
    let file_size = std::fs::metadata(path)
        .with_context(|| format!("Failed to read file: {}", path))?
        .len();

    if file_size > MULTIPART_THRESHOLD {
        return upload_file_multipart(options, path, file_size).await;
    }

    let filename = path_obj
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file")
        .to_string();
    let content_type = guess_content_type(path);
    let client = reqwest::Client::new();
    let base_url = get_base_url();
    let idempotency_key = generate_idempotency_key()?;
    let file_content =
        std::fs::read(path).with_context(|| format!("Failed to read file: {}", path))?;
    let encrypt = effective_encrypt(options);
    let burn = effective_burn(options);
    let expire = effective_expire(options);

    let (upload_content, encryption_key, content_size) = if encrypt {
        let (encrypted, key) = encrypt_content(&file_content)?;
        let size = encrypted.len() as u64;
        (encrypted, Some(key), size)
    } else {
        (file_content, None, file_size)
    };

    let progress_bar = upload_progress_bar(content_size, options);
    let start_time = Instant::now();
    let response = send_with_retry(
        || {
            let mut request = client
                .post(format!("{}/api/v1/upload", base_url))
                .header("Content-Length", content_size.to_string())
                .header("X-Content-Type", &content_type)
                .header("X-Filename", &filename)
                .header("X-Idempotency-Key", &idempotency_key)
                .body(body_from_bytes(
                    upload_content.clone(),
                    progress_bar.clone(),
                ));

            if burn {
                request = request.header("X-Burn", "true");
            }
            if encrypt {
                request = request.header("X-Encrypted", "true");
            }
            if let Some(ref expire) = expire {
                request = request.header("X-Expire", expire);
            }
            if let Some(ref name) = options.name {
                request = request.header("X-Name", name);
            }

            request
        },
        5,
    )
    .await?;

    if let Some(pb) = progress_bar {
        pb.finish_and_clear();
    }

    save_upload_speed(
        content_size as f64 / start_time.elapsed().as_secs_f64(),
        content_size as usize,
    );

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("Failed to upload: {} - {}", status, body);
    }

    let result: PushResponse = response.json().await?;
    print_result(options, &result, encryption_key.as_deref());
    let _ = record_history(
        options,
        &result,
        encryption_key.as_deref(),
        HistoryRecordInput {
            source: Some("path".to_string()),
            content_type: Some(content_type),
            filename: Some(filename),
            size: Some(content_size),
            storage_type: Some("r2".to_string()),
        },
    );
    Ok(())
}

async fn finalize_multipart_upload(
    client: &reqwest::Client,
    base_url: &str,
    options: &UploadOptions,
    manifest_path: &Path,
    manifest: &MultipartResumeManifest,
    content_type: String,
    filename: String,
    content_size: u64,
    encryption_key: Option<&str>,
) -> Result<()> {
    let complete_response = send_with_retry(
        || {
            client
                .post(format!(
                    "{}/api/v1/multipart/{}/complete",
                    base_url, manifest.share_id
                ))
                .header("X-Upload-Id", &manifest.upload_id)
                .header("X-Total-Size", content_size.to_string())
                .header("X-Idempotency-Key", &manifest.idempotency_key)
        },
        5,
    )
    .await?;

    if !complete_response.status().is_success() {
        let status = complete_response.status();
        let body = complete_response.text().await.unwrap_or_default();
        anyhow::bail!("Failed to complete multipart upload: {} - {}", status, body);
    }

    let result: PushResponse = complete_response.json().await?;
    let _ = std::fs::remove_file(manifest_path);
    if manifest
        .file_path
        .starts_with(&uploads_dir()?.display().to_string())
    {
        let _ = std::fs::remove_file(&manifest.file_path);
    }
    print_result(options, &result, encryption_key);
    let _ = record_history(
        options,
        &result,
        encryption_key,
        HistoryRecordInput {
            source: Some("path".to_string()),
            content_type: Some(content_type),
            filename: Some(filename),
            size: Some(content_size),
            storage_type: Some("r2".to_string()),
        },
    );
    Ok(())
}

async fn upload_file_multipart(options: &UploadOptions, path: &str, file_size: u64) -> Result<()> {
    let path_obj = Path::new(path);
    let filename = path_obj
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file")
        .to_string();
    let content_type = guess_content_type(path);
    let client = reqwest::Client::new();
    let base_url = get_base_url();
    let file_content =
        std::fs::read(path).with_context(|| format!("Failed to read file: {}", path))?;
    let encrypt = effective_encrypt(options);
    let burn = effective_burn(options);
    let expire = effective_expire(options);
    let idempotency_key = generate_idempotency_key()?;

    let (upload_content, encryption_key, content_size) = if encrypt {
        let (encrypted, key) = encrypt_content(&file_content)?;
        let size = encrypted.len() as u64;
        (encrypted, Some(key), size)
    } else {
        (file_content, None, file_size)
    };

    let mut init_request = || {
        let mut request = client
            .post(format!("{}/api/v1/multipart/init", base_url))
            .header("X-Content-Type", &content_type)
            .header("X-Filename", &filename)
            .header("X-Idempotency-Key", &idempotency_key);

        if burn {
            request = request.header("X-Burn", "true");
        }
        if encrypt {
            request = request.header("X-Encrypted", "true");
        }
        if let Some(ref expire) = expire {
            request = request.header("X-Expire", expire);
        }
        if let Some(ref name) = options.name {
            request = request.header("X-Name", name);
        }

        request
    };

    let init_response = send_with_retry(&mut init_request, 5).await?;
    if !init_response.status().is_success() {
        anyhow::bail!(
            "Failed to init multipart upload: {}",
            init_response.status()
        );
    }

    let init: MultipartInitResponse = init_response.json().await?;
    let manifest_path = manifest_path_for_upload(&init.id)?;
    let payload_path = if encryption_key.is_some() {
        let payload_path = uploads_dir()?.join(format!("{}.payload", init.id));
        std::fs::write(&payload_path, &upload_content)?;
        payload_path.to_string_lossy().to_string()
    } else {
        path.to_string()
    };
    let mut manifest = MultipartResumeManifest {
        file_path: payload_path,
        file_size: content_size,
        base_url: base_url.clone(),
        share_id: init.id.clone(),
        upload_id: init.upload_id.clone(),
        resume_token: init.resume_token.clone(),
        part_size: init.part_size,
        uploaded_parts: Vec::new(),
        idempotency_key,
        filename: filename.clone(),
        content_type: content_type.clone(),
        encryption_key: encryption_key.clone(),
        created_at: unix_now(),
    };
    write_resume_manifest(&manifest_path, &manifest)?;

    let progress_bar = upload_progress_bar(content_size, options);
    let start_time = Instant::now();
    let mut uploaded = 0u64;
    let mut part_number = 1u64;

    while uploaded < content_size {
        let part_size = std::cmp::min(init.part_size, content_size - uploaded) as usize;
        let part_data = upload_content[uploaded as usize..uploaded as usize + part_size].to_vec();
        let part_sha256 = sha256_hex(&part_data);

        let response = send_with_retry(
            || {
                client
                    .put(format!(
                        "{}/api/v1/multipart/{}/part/{}",
                        base_url, init.id, part_number
                    ))
                    .header("X-Upload-Id", &init.upload_id)
                    .header("X-Part-SHA256", &part_sha256)
                    .header("Content-Length", part_size.to_string())
                    .body(body_from_bytes(part_data.clone(), progress_bar.clone()))
            },
            3,
        )
        .await?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            eprintln!(
                "{}",
                format!(
                    "resume with: shrd upload --resume {}",
                    manifest_path.display()
                )
                .dimmed()
            );
            anyhow::bail!(
                "Failed to upload part {}: {} - {}",
                part_number,
                status,
                body
            );
        }

        let uploaded_part: MultipartPartUploadResponse = response.json().await?;
        manifest
            .uploaded_parts
            .retain(|entry| entry.part_number != uploaded_part.part_number);
        manifest.uploaded_parts.push(MultipartUploadedPart {
            part_number: uploaded_part.part_number,
            etag: uploaded_part.etag,
            sha256: part_sha256,
            size: part_size as u64,
        });
        manifest
            .uploaded_parts
            .sort_by(|left, right| left.part_number.cmp(&right.part_number));
        write_resume_manifest(&manifest_path, &manifest)?;

        uploaded += part_size as u64;
        part_number += 1;
    }

    if let Some(pb) = progress_bar {
        pb.finish_and_clear();
    }

    save_upload_speed(
        content_size as f64 / start_time.elapsed().as_secs_f64(),
        content_size as usize,
    );

    finalize_multipart_upload(
        &client,
        &base_url,
        options,
        &manifest_path,
        &manifest,
        content_type,
        filename,
        content_size,
        encryption_key.as_deref(),
    )
    .await
}

async fn resume_multipart_upload(options: &UploadOptions, manifest_path: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let mut manifest = read_resume_manifest(manifest_path)?;
    let status_response = send_with_retry(
        || {
            client
                .get(format!(
                    "{}/api/v1/multipart/{}/status",
                    manifest.base_url, manifest.share_id
                ))
                .header("X-Upload-Id", &manifest.upload_id)
                .header("X-Resume-Token", &manifest.resume_token)
        },
        5,
    )
    .await?;

    if !status_response.status().is_success() {
        let status = status_response.status();
        let body = status_response.text().await.unwrap_or_default();
        anyhow::bail!("Failed to resume multipart upload: {} - {}", status, body);
    }

    let status: MultipartStatusResponse = status_response.json().await?;
    manifest.uploaded_parts = status.uploaded_parts;
    manifest.part_size = status.part_size;
    write_resume_manifest(Path::new(manifest_path), &manifest)?;

    let path = manifest.file_path.clone();
    let file_content =
        std::fs::read(&path).with_context(|| format!("Failed to read file: {}", path))?;
    let filename = manifest.filename.clone();
    let content_type = manifest.content_type.clone();
    let progress_bar = upload_progress_bar(manifest.file_size, options);
    let uploaded_bytes = manifest
        .uploaded_parts
        .iter()
        .map(|part| part.size)
        .sum::<u64>();
    if let Some(ref pb) = progress_bar {
        pb.set_position(uploaded_bytes);
    }

    let mut uploaded = 0u64;
    let mut part_number = 1u64;
    while uploaded < manifest.file_size {
        let part_size = std::cmp::min(status.part_size, manifest.file_size - uploaded) as usize;
        let part_data = file_content[uploaded as usize..uploaded as usize + part_size].to_vec();
        let part_sha256 = sha256_hex(&part_data);

        if manifest
            .uploaded_parts
            .iter()
            .any(|part| part.part_number == part_number && part.sha256 == part_sha256)
        {
            uploaded += part_size as u64;
            part_number += 1;
            continue;
        }

        let response = send_with_retry(
            || {
                client
                    .put(format!(
                        "{}/api/v1/multipart/{}/part/{}",
                        manifest.base_url, manifest.share_id, part_number
                    ))
                    .header("X-Upload-Id", &manifest.upload_id)
                    .header("X-Part-SHA256", &part_sha256)
                    .header("Content-Length", part_size.to_string())
                    .body(body_from_bytes(part_data.clone(), progress_bar.clone()))
            },
            3,
        )
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

        let uploaded_part: MultipartPartUploadResponse = response.json().await?;
        manifest
            .uploaded_parts
            .retain(|entry| entry.part_number != uploaded_part.part_number);
        manifest.uploaded_parts.push(MultipartUploadedPart {
            part_number: uploaded_part.part_number,
            etag: uploaded_part.etag,
            sha256: part_sha256,
            size: part_size as u64,
        });
        manifest
            .uploaded_parts
            .sort_by(|left, right| left.part_number.cmp(&right.part_number));
        write_resume_manifest(Path::new(manifest_path), &manifest)?;

        uploaded += part_size as u64;
        part_number += 1;
    }

    if let Some(pb) = progress_bar {
        pb.finish_and_clear();
    }

    finalize_multipart_upload(
        &client,
        &manifest.base_url,
        options,
        Path::new(manifest_path),
        &manifest,
        content_type,
        filename,
        manifest.file_size,
        manifest.encryption_key.as_deref(),
    )
    .await
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

fn summarize_share(result: &PushResponse, options: &UploadOptions) -> String {
    let mut labels = Vec::new();
    if let Some(mode) = effective_mode(options) {
        labels.push(mode_label(mode).to_string());
    }
    if effective_encrypt(options) && effective_mode(options) != Some(ShareMode::Private) {
        labels.push("encrypted".to_string());
    }
    if effective_burn(options) {
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

struct HistoryRecordInput {
    source: Option<String>,
    content_type: Option<String>,
    filename: Option<String>,
    size: Option<u64>,
    storage_type: Option<String>,
}

fn record_history(
    options: &UploadOptions,
    result: &PushResponse,
    encryption_key: Option<&str>,
    input: HistoryRecordInput,
) -> Result<()> {
    let (url, raw_url) = resolve_result_urls(result, encryption_key);
    let content_type = input.content_type.clone();
    append_history(HistoryEntry {
        id: result.id.clone(),
        url,
        raw_url,
        delete_url: result.delete_url.clone(),
        delete_token: result.delete_token.clone(),
        expires_at: result.expires_at.clone(),
        name: result.name.clone(),
        filename: input.filename,
        content_type: content_type.clone(),
        kind: content_type.as_deref().map(infer_history_kind),
        size: input.size,
        storage_type: input.storage_type,
        created_at: unix_now(),
        source: input.source,
        mode: Some(history_mode_label(options)),
        encrypted: effective_encrypt(options),
        burn: effective_burn(options),
    })
}

fn print_result(options: &UploadOptions, result: &PushResponse, encryption_key: Option<&str>) {
    let (url, raw_url) = resolve_result_urls(result, encryption_key);

    if options.json {
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
    } else if !options.quiet {
        println!("{} {}", "→".green(), url.cyan());
        eprintln!("{}", summarize_share(result, options).dimmed());
        if !options.no_copy {
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

fn print_recent_shares(options: &ListOptions) -> Result<()> {
    let entries = filter_history_entries(load_history()?, options)?;
    if entries.is_empty() {
        if options.json {
            println!(
                "{}",
                serde_json::to_string_pretty(&HistoryFile {
                    version: 2,
                    entries: Vec::new(),
                })?
            );
        } else {
            println!("No recent shares yet.");
        }
        return Ok(());
    }

    if options.copy {
        let latest = &entries[0];
        copy_to_clipboard(&latest.url)?;
        println!("{} {}", "→".green(), latest.url.cyan());
        return Ok(());
    }

    let shown_entries: Vec<HistoryEntry> = entries.into_iter().take(options.limit).collect();

    if options.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&HistoryFile {
                version: 2,
                entries: shown_entries,
            })?
        );
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

async fn pull_content(options: &GetOptions, id: &str) -> Result<()> {
    use tokio::io::AsyncWriteExt;

    if options.raw && options.open {
        anyhow::bail!("--raw cannot be used with --open");
    }
    if options.raw && options.copy {
        anyhow::bail!("--raw cannot be used with --copy");
    }
    if options.open && options.copy {
        anyhow::bail!("--open cannot be used with --copy");
    }

    let client = reqwest::Client::new();
    let base_url = get_base_url();
    let resolved_reference = resolve_recent_reference(id)?;
    let (raw_id, decryption_key) = parse_id_and_key(&resolved_reference);
    let id = normalize_share_id(&raw_id);

    if options.meta {
        let response =
            send_with_retry(|| client.get(format!("{}/{}/meta", base_url, id)), 5).await?;

        if !response.status().is_success() {
            if response.status() == StatusCode::NOT_FOUND {
                anyhow::bail!("Share not found or expired");
            }
            anyhow::bail!("Failed to fetch: {}", response.status());
        }

        let meta: ShareMeta = response.json().await?;
        println!("{}", serde_json::to_string_pretty(&meta)?);
        return Ok(());
    }

    let meta_response =
        send_with_retry(|| client.get(format!("{}/{}/meta", base_url, id)), 5).await?;
    if !meta_response.status().is_success() {
        if meta_response.status() == StatusCode::NOT_FOUND {
            anyhow::bail!("Share not found or expired");
        }
        anyhow::bail!("Failed to fetch: {}", meta_response.status());
    }

    let meta: ShareMeta = meta_response.json().await?;
    let is_binary = is_binary_content_type(&meta.content_type);
    let is_tty = atty::is(atty::Stream::Stdout);
    let response = send_with_retry(|| client.get(format!("{}/{}/raw", base_url, id)), 5).await?;
    if !response.status().is_success() {
        if response.status() == StatusCode::NOT_FOUND {
            anyhow::bail!("Share not found or expired");
        }
        anyhow::bail!("Failed to fetch: {}", response.status());
    }

    let content = if meta.encrypted.unwrap_or(false) {
        let key = decryption_key.context("Missing decryption key in share URL")?;
        if meta.storage_type.as_deref() == Some("kv") {
            let encoded = response.text().await?;
            let ciphertext = base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .context("Failed to decode encrypted content")?;
            decrypt_content(&ciphertext, &key)?
        } else {
            let ciphertext = response.bytes().await?;
            decrypt_content(ciphertext.as_ref(), &key)?
        }
    } else {
        response.bytes().await?.to_vec()
    };

    if options.copy {
        if is_binary {
            anyhow::bail!("Cannot copy binary content. Use --output instead.");
        }

        let text = String::from_utf8(content).context("Fetched content is not valid UTF-8")?;
        copy_to_clipboard(&text)?;
        if !options.quiet {
            println!("{}", "(copied to clipboard)".dimmed());
        }
        return Ok(());
    }

    let explicit_output = resolve_output_target(&meta, &id, options.output.as_deref())?;
    let target = if options.raw {
        OutputTarget::Stdout
    } else if let Some(target) = explicit_output {
        target
    } else if options.open {
        OutputTarget::File(temp_output_path(&meta, &id))
    } else if is_binary && is_tty {
        OutputTarget::File(PathBuf::from(get_unique_filename(&preferred_filename(
            &meta, &id,
        ))))
    } else {
        OutputTarget::Stdout
    };

    match target {
        OutputTarget::Stdout => {
            let mut stdout = tokio::io::stdout();
            stdout.write_all(&content).await?;
            stdout.flush().await?;
        }
        OutputTarget::File(path) => {
            let mut file = tokio::fs::File::create(&path).await?;
            file.write_all(&content).await?;
            file.flush().await?;
            if options.open {
                opener::open(&path)?;
            }
            if !options.quiet {
                println!("{} {}", "→".green(), path.display().to_string().cyan());
            }
        }
    }

    Ok(())
}

async fn upload_from_source(
    options: &UploadOptions,
    input: Option<&str>,
    explicit_upload: bool,
) -> Result<()> {
    if let Some(manifest_path) = options.resume.as_deref() {
        return resume_multipart_upload(options, manifest_path).await;
    }

    if options.clipboard {
        let content = get_clipboard()?;
        return push_content(options, content, None, None, Some("clipboard".to_string())).await;
    }

    if let Some(input) = input {
        if std::path::Path::new(input).exists() {
            return upload_file_streaming(options, input).await;
        }
        return push_content(
            options,
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
        return push_content(options, content, None, None, Some("stdin".to_string())).await;
    }

    let usage = if explicit_upload {
        "Usage: shrd upload [OPTIONS] [INPUT]"
    } else {
        "Usage: shrd [OPTIONS] [INPUT]"
    };
    println!("{}", usage.yellow());
    println!();
    println!("Examples:");
    if explicit_upload {
        println!(
            "  {} | shrd upload      # Share from pipe",
            "cat file.txt".dimmed()
        );
        println!("  {} upload file.txt    # Share a file", "shrd".dimmed());
        println!("  {} upload -c          # Share clipboard", "shrd".dimmed());
        println!("  {} upload --mode private secrets.txt", "shrd".dimmed());
    } else {
        println!(
            "  {} | shrd           # Share from pipe",
            "cat file.txt".dimmed()
        );
        println!("  {} file.txt           # Share a file", "shrd".dimmed());
        println!(
            "  {} upload file.txt    # Explicit upload mode",
            "shrd".dimmed()
        );
    }
    println!("  {} get abc123         # Retrieve by ID", "shrd".dimmed());
    println!(
        "  {} list               # Show recent shares",
        "shrd".dimmed()
    );
    if !explicit_upload {
        println!("  {} -c                 # Share clipboard", "shrd".dimmed());
    }
    println!();
    println!("Run {} for more options.", "shrd --help".cyan());

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match &cli.command {
        Some(Commands::Upload { input, options }) => {
            return upload_from_source(options, input.as_deref(), true).await
        }
        Some(Commands::Get { id, options }) => return pull_content(options, id).await,
        Some(Commands::List { options }) => return print_recent_shares(options),
        Some(Commands::Search { term, options }) => {
            let mut search_options = options.clone();
            search_options.query = Some(term.clone());
            return print_recent_shares(&search_options);
        }
        Some(Commands::Config { options, action }) => {
            match action {
                ConfigAction::SetUrl { url } => {
                    save_config_url(url)?;
                    println!("{} Base URL set to: {}", "✓".green(), url.cyan());
                }
                ConfigAction::Ai { action } => match action {
                    AiConfigAction::Install { target, force, yes } => {
                        let (selection, explicit) =
                            resolve_ai_selection(target, Some(AiPreset::All));
                        install_ai_skills(options.json, selection, *force, explicit, *yes)?;
                    }
                    AiConfigAction::Remove { target, force, yes } => {
                        let (selection, explicit) =
                            resolve_ai_selection(target, Some(AiPreset::All));
                        remove_ai_skills(options.json, selection, *force, explicit, *yes)?;
                    }
                    AiConfigAction::Status { target } => {
                        let (selection, _) = resolve_ai_selection(target, Some(AiPreset::All));
                        print_ai_skill_status(options.json, selection)?;
                    }
                    AiConfigAction::Presets => {
                        print_ai_presets(options.json)?;
                    }
                },
                ConfigAction::Show => {
                    print_config_show(options.json)?;
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
            return pull_content(&root_get_options(&cli), input).await;
        }
        return upload_from_source(&cli.upload, Some(input), false).await;
    }

    upload_from_source(&cli.upload, None, false).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::error::ErrorKind;
    use std::fs;

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

        match cli.command {
            Some(Commands::Upload { input, options }) => {
                assert_eq!(input.as_deref(), Some("notes.txt"));
                assert_eq!(options.expire.as_deref(), Some("7d"));
            }
            _ => panic!("expected upload command"),
        }
    }

    #[test]
    fn cli_supports_get_subcommand() {
        let cli = Cli::try_parse_from(["shrd", "get", "release_notes#key=abc"])
            .expect("cli should parse");

        match cli.command {
            Some(Commands::Get { id, options }) => {
                assert_eq!(id, "release_notes#key=abc");
                assert!(!options.meta);
            }
            _ => panic!("expected get command"),
        }
    }

    #[test]
    fn cli_supports_get_output_flags() {
        let cli = Cli::try_parse_from(["shrd", "get", "last", "--raw", "--output", "-"])
            .expect("cli should parse");

        match cli.command {
            Some(Commands::Get { id, options }) => {
                assert_eq!(id, "last");
                assert!(options.raw);
                assert_eq!(options.output.as_deref(), Some("-"));
            }
            _ => panic!("expected get command"),
        }
    }

    #[test]
    fn cli_supports_list_and_recent_alias() {
        let cli = Cli::try_parse_from(["shrd", "list", "--limit", "5"]).expect("cli should parse");

        match cli.command {
            Some(Commands::List { options }) => {
                assert_eq!(options.limit, 5);
                assert!(!options.copy);
            }
            _ => panic!("expected list command"),
        }

        let alias = Cli::try_parse_from(["shrd", "recent", "--copy"]).expect("alias should parse");
        match alias.command {
            Some(Commands::List { options }) => assert!(options.copy),
            _ => panic!("expected list command"),
        }
    }

    #[test]
    fn cli_supports_search_command() {
        let cli = Cli::try_parse_from([
            "shrd",
            "search",
            "deploy",
            "--mode",
            "temporary",
            "--type",
            "text",
        ])
        .expect("cli should parse");

        match cli.command {
            Some(Commands::Search { term, options }) => {
                assert_eq!(term, "deploy");
                assert_eq!(options.mode, Some(HistoryModeFilter::Temporary));
                assert_eq!(options.kind, Some(HistoryKind::Text));
            }
            _ => panic!("expected search command"),
        }
    }

    #[test]
    fn cli_supports_mode_flag() {
        let cli = Cli::try_parse_from(["shrd", "--mode", "permanent", "notes.txt"])
            .expect("cli should parse");

        assert_eq!(cli.upload.mode, Some(ShareMode::Permanent));
    }

    #[test]
    fn lowercase_v_is_version_flag() {
        let err = Cli::try_parse_from(["shrd", "-v"]).expect_err("version should exit early");
        assert_eq!(err.kind(), clap::error::ErrorKind::DisplayVersion);
    }

    #[test]
    fn cli_supports_config_ai_install() {
        let cli = Cli::try_parse_from(["shrd", "config", "ai", "install", "claude-code"])
            .expect("cli should parse");

        match cli.command {
            Some(Commands::Config {
                options,
                action:
                    ConfigAction::Ai {
                        action: AiConfigAction::Install { target, force, yes },
                    },
            }) => {
                assert!(!options.json);
                assert_eq!(target.tool, Some(AiTool::ClaudeCode));
                assert_eq!(target.preset, None);
                assert!(!force);
                assert!(!yes);
            }
            _ => panic!("expected config ai install command"),
        }
    }

    #[test]
    fn cli_supports_claude_alias_for_ai_tool() {
        let cli = Cli::try_parse_from(["shrd", "config", "ai", "install", "claude"])
            .expect("cli should parse");

        match cli.command {
            Some(Commands::Config {
                action:
                    ConfigAction::Ai {
                        action: AiConfigAction::Install { target, .. },
                    },
                ..
            }) => assert_eq!(target.tool, Some(AiTool::ClaudeCode)),
            _ => panic!("expected config ai install command"),
        }
    }

    #[test]
    fn cli_supports_config_ai_install_without_target() {
        let cli =
            Cli::try_parse_from(["shrd", "config", "ai", "install"]).expect("cli should parse");

        match cli.command {
            Some(Commands::Config {
                action:
                    ConfigAction::Ai {
                        action: AiConfigAction::Install { target, yes, .. },
                    },
                ..
            }) => {
                assert_eq!(target.tool, None);
                assert_eq!(target.preset, None);
                assert!(!yes);
            }
            _ => panic!("expected config ai install command"),
        }
    }

    #[test]
    fn cli_supports_config_ai_install_with_preset() {
        let cli = Cli::try_parse_from([
            "shrd", "config", "ai", "install", "--preset", "all", "--yes",
        ])
        .expect("cli should parse");

        match cli.command {
            Some(Commands::Config {
                action:
                    ConfigAction::Ai {
                        action: AiConfigAction::Install { target, yes, .. },
                    },
                ..
            }) => {
                assert_eq!(target.tool, None);
                assert_eq!(target.preset, Some(AiPreset::All));
                assert!(yes);
            }
            _ => panic!("expected config ai install command"),
        }
    }

    #[test]
    fn cli_keeps_legacy_all_target_for_ai_install() {
        let cli = Cli::try_parse_from(["shrd", "config", "ai", "install", "all"])
            .expect("cli should parse");

        match cli.command {
            Some(Commands::Config {
                action:
                    ConfigAction::Ai {
                        action: AiConfigAction::Install { target, .. },
                    },
                ..
            }) => assert_eq!(target.tool, Some(AiTool::All)),
            _ => panic!("expected config ai install command"),
        }
    }

    #[test]
    fn config_json_flag_reaches_ai_subcommands() {
        let cli = Cli::try_parse_from(["shrd", "config", "ai", "status", "--json"])
            .expect("cli should parse");

        match cli.command {
            Some(Commands::Config {
                options,
                action:
                    ConfigAction::Ai {
                        action: AiConfigAction::Status { target },
                    },
            }) => {
                assert!(options.json);
                assert_eq!(target.tool, None);
                assert_eq!(target.preset, None);
            }
            _ => panic!("expected config ai status command"),
        }
    }

    #[test]
    fn cli_supports_config_ai_presets() {
        let cli =
            Cli::try_parse_from(["shrd", "config", "ai", "presets"]).expect("cli should parse");

        match cli.command {
            Some(Commands::Config {
                action:
                    ConfigAction::Ai {
                        action: AiConfigAction::Presets,
                    },
                ..
            }) => {}
            _ => panic!("expected config ai presets command"),
        }
    }

    #[test]
    fn config_help_only_shows_config_flags() {
        let err = Cli::try_parse_from(["shrd", "config", "--help"]).expect_err("help should exit");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
        let help = err.to_string();
        assert!(help.contains("--json"));
        assert!(!help.contains("--expire"));
        assert!(!help.contains("--clipboard"));
        assert!(!help.contains("--meta"));
    }

    #[test]
    fn get_help_only_shows_get_flags() {
        let err = Cli::try_parse_from(["shrd", "get", "--help"]).expect_err("help should exit");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
        let help = err.to_string();
        assert!(help.contains("--meta"));
        assert!(help.contains("shrd get last"));
        assert!(!help.contains("--expire"));
        assert!(!help.contains("--clipboard"));
    }

    #[test]
    fn upload_help_does_not_show_meta_flag() {
        let err = Cli::try_parse_from(["shrd", "upload", "--help"]).expect_err("help should exit");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
        let help = err.to_string();
        assert!(!help.contains("--meta"));
        assert!(help.contains("shrd upload notes.txt"));
    }

    #[test]
    fn list_help_shows_primary_command_name() {
        let err = Cli::try_parse_from(["shrd", "--help"]).expect_err("help should exit");
        assert_eq!(err.kind(), ErrorKind::DisplayHelp);
        let help = err.to_string();
        assert!(help.contains("  list"));
        assert!(help.contains("[aliases: recent]"));
        assert!(help.contains("shrd list"));
    }

    #[test]
    fn shrd_skill_content_matches_current_cli_surface() {
        let skill = canonical_shrd_skill();
        assert!(skill.contains("shrd upload path/to/file"));
        assert!(skill.contains("shrd get last"));
        assert!(skill.contains("shrd list"));
        assert!(skill.contains("--mode <mode>"));
        assert!(!skill.contains("shrd login"));
        assert!(!skill.contains("shrd logout"));
        assert!(!skill.contains("shrd whoami"));
    }

    #[test]
    fn resolve_ai_skill_targets_uses_expected_paths() {
        let home = PathBuf::from("/tmp/home");
        let xdg = PathBuf::from("/tmp/xdg");
        let targets =
            resolve_ai_skill_targets_from_roots(&home, &xdg, AiSelection::Preset(AiPreset::All));

        let paths: Vec<(AiTool, PathBuf)> = targets
            .into_iter()
            .map(|target| (target.tool, target.skill_file))
            .collect();

        assert!(paths.contains(&(
            AiTool::Cursor,
            home.join(".cursor")
                .join("skills")
                .join("shrd")
                .join("SKILL.md"),
        )));
        assert!(paths.contains(&(
            AiTool::Codex,
            home.join(".codex")
                .join("skills")
                .join("shrd")
                .join("SKILL.md"),
        )));
        assert!(paths.contains(&(
            AiTool::ClaudeCode,
            home.join(".claude")
                .join("skills")
                .join("shrd")
                .join("SKILL.md"),
        )));
        assert!(paths.contains(&(
            AiTool::Opencode,
            xdg.join("opencode")
                .join("skills")
                .join("shrd")
                .join("SKILL.md"),
        )));
    }

    #[test]
    fn resolve_ai_selection_defaults_to_all_preset() {
        let (selection, explicit) = resolve_ai_selection(&AiTargetOptions::default(), None);

        assert_eq!(selection, AiSelection::Preset(AiPreset::All));
        assert!(!explicit);
    }

    #[test]
    fn resolve_ai_selection_prefers_explicit_tool() {
        let (selection, explicit) = resolve_ai_selection(
            &AiTargetOptions {
                tool: Some(AiTool::Codex),
                preset: None,
            },
            Some(AiPreset::All),
        );

        assert_eq!(selection, AiSelection::Tool(AiTool::Codex));
        assert!(explicit);
    }

    #[test]
    fn install_ai_skill_writes_canonical_skill() {
        let root = std::env::temp_dir().join(format!("shrd-ai-install-{}", unix_now()));
        let target = AiSkillTarget {
            tool: AiTool::Codex,
            skill_dir: root.join("skill"),
            skill_file: root.join("skill").join("SKILL.md"),
        };

        install_ai_skill_target(&target, false).expect("install should succeed");

        let written = fs::read_to_string(&target.skill_file).expect("skill should exist");
        assert_eq!(written, canonical_shrd_skill());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn install_ai_skill_requires_force_for_customized_skill() {
        let root = std::env::temp_dir().join(format!("shrd-ai-custom-{}", unix_now()));
        let target = AiSkillTarget {
            tool: AiTool::Cursor,
            skill_dir: root.join("skill"),
            skill_file: root.join("skill").join("SKILL.md"),
        };

        fs::create_dir_all(&target.skill_dir).expect("skill dir");
        fs::write(&target.skill_file, "custom skill").expect("custom skill");

        let err = install_ai_skill_target(&target, false).expect_err("install should fail");
        assert!(err.to_string().contains("--force"));

        install_ai_skill_target(&target, true).expect("forced install should succeed");
        let written = fs::read_to_string(&target.skill_file).expect("skill should exist");
        assert_eq!(written, canonical_shrd_skill());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn remove_ai_skill_requires_force_for_extra_files() {
        let root = std::env::temp_dir().join(format!("shrd-ai-remove-{}", unix_now()));
        let target = AiSkillTarget {
            tool: AiTool::Opencode,
            skill_dir: root.join("skill"),
            skill_file: root.join("skill").join("SKILL.md"),
        };

        fs::create_dir_all(&target.skill_dir).expect("skill dir");
        fs::write(&target.skill_file, canonical_shrd_skill()).expect("canonical skill");
        fs::write(target.skill_dir.join("notes.txt"), "custom").expect("extra file");

        let err = remove_ai_skill_target(&target, false).expect_err("remove should fail");
        assert!(err.to_string().contains("--force"));

        remove_ai_skill_target(&target, true).expect("forced remove should succeed");
        assert!(!target.skill_dir.exists());

        let _ = fs::remove_dir_all(root);
    }
}
