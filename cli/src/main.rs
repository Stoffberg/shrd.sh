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
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Instant;

const DEFAULT_BASE_URL: &str = "https://shrd.stoff.dev";
const KEY_LEN: usize = 32;
const GENERATED_ID_LEN: usize = 6;
const MAX_HISTORY_ITEMS: usize = 50;
const INLINE_STORAGE_LIMIT: usize = 25 * 1024;
const DEFAULT_EXPIRE: &str = "365d";
const ROOT_AFTER_HELP: &str = "Examples:\n  shrd \"hello world\"\n  shrd notes.txt\n  cat deploy.log | shrd --mode temporary\n  shrd get last\n  shrd list\n";
const UPLOAD_AFTER_HELP: &str = "Examples:\n  shrd upload notes.txt\n  shrd upload --mode private secrets.txt\n  cat deploy.log | shrd upload --expire 1h\n  shrd upload --name release-notes README.md\n";
const GET_AFTER_HELP: &str = "Examples:\n  shrd get abc123\n  shrd get last\n  shrd get https://shrd.stoff.dev/release-notes#key=secret\n  shrd get abc123 --meta\n";
const LIST_AFTER_HELP: &str =
    "Examples:\n  shrd list\n  shrd list --limit 20\n  shrd list --copy\n  shrd list --json\n";
const CONFIG_AFTER_HELP: &str =
    "Examples:\n  shrd config show\n  shrd config set-url https://shrd.example.com\n  shrd config reset\n";

mod app;
mod crypto;
mod download;
mod output;
mod refs;
mod support;
mod upload;

pub(crate) use crypto::*;
pub(crate) use download::*;
pub(crate) use output::*;
pub(crate) use refs::*;
pub(crate) use support::*;
pub(crate) use upload::*;

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

#[derive(Debug, Args, Clone, Default)]
struct UploadOptions {
    #[arg(
        short = 'x',
        long = "expire",
        alias = "expires",
        help = "Expiry time (1h, 24h, 7d, 30d, 365d, never)"
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
    filename: String,
    content_type: String,
    encryption_key: Option<String>,
    created_at: u64,
}

struct MultipartFinalizeDetails {
    content_type: String,
    filename: String,
    content_size: u64,
}

#[derive(Deserialize)]
struct MultipartPartUploadResponse {
    #[serde(rename = "partNumber")]
    part_number: u64,
    etag: String,
}

#[derive(Serialize)]
struct ConfigSummary {
    #[serde(rename = "baseUrl")]
    base_url: String,
    #[serde(rename = "configDir")]
    config_dir: String,
    #[serde(rename = "recentShares")]
    recent_shares: usize,
}

#[tokio::main]
async fn main() -> Result<()> {
    app::run().await
}

#[cfg(test)]
mod tests;
