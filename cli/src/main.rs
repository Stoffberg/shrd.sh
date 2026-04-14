use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use clap::{Args, Parser, Subcommand, ValueEnum};
use colored::Colorize;
use futures::stream::{self, StreamExt};
use indicatif::{ProgressBar, ProgressStyle};
use reqwest::Body;
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::Instant;

const DEFAULT_BASE_URL: &str = "https://shrd.stoff.dev";
const KEY_LEN: usize = 32;
const GENERATED_ID_LEN: usize = 6;
const MAX_HISTORY_ITEMS: usize = 50;
const ROOT_AFTER_HELP: &str = "Examples:\n  shrd \"hello world\"\n  shrd notes.txt\n  cat deploy.log | shrd --mode temporary\n  shrd get last\n  shrd list\n";
const UPLOAD_AFTER_HELP: &str = "Examples:\n  shrd upload notes.txt\n  shrd upload --mode private secrets.txt\n  cat deploy.log | shrd upload --expire 1h\n  shrd upload --name release-notes README.md\n";
const GET_AFTER_HELP: &str = "Examples:\n  shrd get abc123\n  shrd get last\n  shrd get https://shrd.stoff.dev/release-notes#key=secret\n  shrd get abc123 --meta\n";
const LIST_AFTER_HELP: &str =
    "Examples:\n  shrd list\n  shrd list --limit 20\n  shrd list --copy\n  shrd list --json\n";
const CONFIG_AFTER_HELP: &str = "Examples:\n  shrd config show\n  shrd config set-url https://shrd.example.com\n  shrd config ai status\n  shrd config ai install codex\n";
const AI_INSTALL_AFTER_HELP: &str =
    "Examples:\n  shrd config ai install codex\n  shrd config ai install claude\n  shrd config ai install all --force\n";
const AI_REMOVE_AFTER_HELP: &str =
    "Examples:\n  shrd config ai remove cursor\n  shrd config ai remove all --force\n";

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
enum AiTool {
    Cursor,
    Codex,
    #[value(alias = "claude")]
    ClaudeCode,
    Opencode,
    All,
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
}

#[derive(Debug, Args, Clone, Default)]
struct GetOptions {
    #[arg(long, help = "Get metadata instead of content")]
    meta: bool,

    #[arg(short, long, help = "Suppress output except errors")]
    quiet: bool,
}

#[derive(Debug, Args, Clone, Default)]
struct ListOptions {
    #[arg(short, long, default_value_t = 10, help = "How many shares to show")]
    limit: usize,

    #[arg(long, help = "Copy the newest share URL")]
    copy: bool,

    #[arg(short, long, help = "Output as JSON")]
    json: bool,
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
        #[arg(value_enum, help = "Tool to configure")]
        tool: AiTool,
        #[arg(long, help = "Replace customized skill directories")]
        force: bool,
    },
    #[command(
        about = "Remove the shrd skill from a supported AI tool",
        after_help = AI_REMOVE_AFTER_HELP
    )]
    Remove {
        #[arg(value_enum, help = "Tool to configure")]
        tool: AiTool,
        #[arg(long, help = "Remove customized skill directories")]
        force: bool,
    },
    #[command(about = "Show installed AI skill status")]
    Status,
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

fn root_get_options(cli: &Cli) -> GetOptions {
    GetOptions {
        meta: cli.meta,
        quiet: cli.upload.quiet,
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

impl AiSkillState {
    fn label(self) -> &'static str {
        match self {
            AiSkillState::Missing => "missing",
            AiSkillState::Installed => "installed",
            AiSkillState::Customized => "customized",
        }
    }
}

fn resolve_ai_skill_targets_from_roots(
    home_dir: &Path,
    xdg_config_home: &Path,
    tool: AiTool,
) -> Vec<AiSkillTarget> {
    let tools = match tool {
        AiTool::All => vec![
            AiTool::Cursor,
            AiTool::Codex,
            AiTool::ClaudeCode,
            AiTool::Opencode,
        ],
        _ => vec![tool],
    };

    tools
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

fn resolve_ai_skill_targets(tool: AiTool) -> Result<Vec<AiSkillTarget>> {
    Ok(resolve_ai_skill_targets_from_roots(
        &get_home_dir()?,
        &get_xdg_config_home()?,
        tool,
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

fn ai_skill_statuses(tool: AiTool) -> Result<Vec<AiSkillStatus>> {
    let targets = resolve_ai_skill_targets(tool)?;
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

fn install_ai_skill_target(target: &AiSkillTarget, force: bool) -> Result<()> {
    let state = ai_skill_state(target)?;
    if state == AiSkillState::Installed {
        return Ok(());
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
    Ok(())
}

fn remove_ai_skill_target(target: &AiSkillTarget, force: bool) -> Result<bool> {
    if !target.skill_dir.exists() {
        return Ok(false);
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
    Ok(true)
}

fn install_ai_skills(json: bool, tool: AiTool, force: bool) -> Result<()> {
    let targets = resolve_ai_skill_targets(tool)?;
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

    for target in &targets {
        install_ai_skill_target(target, force)?;
    }

    let statuses: Vec<AiSkillStatus> = targets
        .into_iter()
        .map(|target| AiSkillStatus {
            tool: target.tool.label().to_string(),
            status: "installed".to_string(),
            path: target.skill_file.display().to_string(),
        })
        .collect();

    if json {
        println!("{}", serde_json::to_string_pretty(&statuses)?);
    } else {
        for status in statuses {
            println!(
                "{} Installed shrd skill for {} at {}",
                "✓".green(),
                status.tool.cyan(),
                status.path.dimmed()
            );
        }
    }

    Ok(())
}

fn remove_ai_skills(json: bool, tool: AiTool, force: bool) -> Result<()> {
    let targets = resolve_ai_skill_targets(tool)?;
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
        let was_removed = remove_ai_skill_target(target, force)?;
        removed.push(AiSkillStatus {
            tool: target.tool.label().to_string(),
            status: if was_removed {
                "removed".to_string()
            } else {
                "missing".to_string()
            },
            path: target.skill_file.display().to_string(),
        });
    }

    if json {
        println!("{}", serde_json::to_string_pretty(&removed)?);
    } else {
        for status in removed {
            if status.status == "removed" {
                println!(
                    "{} Removed shrd skill for {} from {}",
                    "✓".green(),
                    status.tool.cyan(),
                    status.path.dimmed()
                );
            } else {
                println!(
                    "{} No shrd skill installed for {} at {}",
                    "•".yellow(),
                    status.tool.cyan(),
                    status.path.dimmed()
                );
            }
        }
    }

    Ok(())
}

fn print_ai_skill_status(json: bool, tool: AiTool) -> Result<()> {
    let statuses = ai_skill_statuses(tool)?;

    if json {
        println!("{}", serde_json::to_string_pretty(&statuses)?);
        return Ok(());
    }

    println!("{:<14} {:<12} {}", "tool", "status", "path");
    for status in statuses {
        println!("{:<14} {:<12} {}", status.tool, status.status, status.path);
    }

    Ok(())
}

fn print_config_show(json: bool) -> Result<()> {
    let base_url = get_base_url();
    let config_dir = get_config_dir()?;
    let history_count = load_history().map(|entries| entries.len()).unwrap_or(0);
    let ai_skills = ai_skill_statuses(AiTool::All)?;

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
        name: options.name.clone(),
        content_type,
        filename,
        encrypted: encrypt,
    };

    let body_bytes = serde_json::to_vec(&request)?;
    let body_size = body_bytes.len();

    let upload_speed = get_upload_speed();
    let estimated_seconds = body_size as f64 / upload_speed;
    let show_progress = estimated_seconds > 10.0 && !options.quiet && !options.json;

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
    print_result(options, &result, encryption_key.as_deref());
    let _ = record_history(options, &result, encryption_key.as_deref(), source);

    Ok(())
}

const MULTIPART_THRESHOLD: u64 = 95 * 1024 * 1024; // 95MB - use multipart for larger
const PART_SIZE: u64 = 50 * 1024 * 1024; // 50MB parts

async fn upload_file_streaming(options: &UploadOptions, path: &str) -> Result<()> {
    let path_obj = std::path::Path::new(path);
    let file_size = std::fs::metadata(path)
        .with_context(|| format!("Failed to read file: {}", path))?
        .len();

    if file_size > MULTIPART_THRESHOLD {
        return upload_file_multipart(options, path, file_size).await;
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

    let upload_speed = get_upload_speed();
    let estimated_seconds = content_size as f64 / upload_speed;
    let show_progress = estimated_seconds > 10.0 && !options.quiet && !options.json;

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
    if let Some(ref name) = options.name {
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
    print_result(options, &result, encryption_key.as_deref());
    let _ = record_history(
        options,
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

async fn upload_file_multipart(options: &UploadOptions, path: &str, file_size: u64) -> Result<()> {
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
    if let Some(ref name) = options.name {
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
    let show_progress = estimated_seconds > 10.0 && !options.quiet && !options.json;

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
    print_result(options, &result, encryption_key.as_deref());
    let _ = record_history(
        options,
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

fn record_history(
    options: &UploadOptions,
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
        mode: effective_mode(options).map(|mode| mode_label(mode).to_string()),
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
    let entries = load_history()?;
    if entries.is_empty() {
        if options.json {
            println!("[]");
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

async fn pull_content(options: &GetOptions, id: &str) -> Result<()> {
    use tokio::io::AsyncWriteExt;

    let client = reqwest::Client::new();
    let base_url = get_base_url();
    let resolved_reference = resolve_recent_reference(id)?;
    let (raw_id, decryption_key) = parse_id_and_key(&resolved_reference);
    let id = normalize_share_id(&raw_id);

    if options.meta {
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

            if !options.quiet {
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
    let show_progress = estimated_seconds > 10.0 && !options.quiet && is_tty;

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

        if !options.quiet {
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

async fn upload_from_source(
    options: &UploadOptions,
    input: Option<&str>,
    explicit_upload: bool,
) -> Result<()> {
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
        Some(Commands::Config { options, action }) => {
            match action {
                ConfigAction::SetUrl { url } => {
                    save_config_url(url)?;
                    println!("{} Base URL set to: {}", "✓".green(), url.cyan());
                }
                ConfigAction::Ai { action } => match action {
                    AiConfigAction::Install { tool, force } => {
                        install_ai_skills(options.json, *tool, *force)?;
                    }
                    AiConfigAction::Remove { tool, force } => {
                        remove_ai_skills(options.json, *tool, *force)?;
                    }
                    AiConfigAction::Status => {
                        print_ai_skill_status(options.json, AiTool::All)?;
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
                        action: AiConfigAction::Install { tool, force },
                    },
            }) => {
                assert!(!options.json);
                assert_eq!(tool, AiTool::ClaudeCode);
                assert!(!force);
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
                        action: AiConfigAction::Install { tool, .. },
                    },
                ..
            }) => assert_eq!(tool, AiTool::ClaudeCode),
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
                        action: AiConfigAction::Status,
                    },
            }) => assert!(options.json),
            _ => panic!("expected config ai status command"),
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
        let targets = resolve_ai_skill_targets_from_roots(&home, &xdg, AiTool::All);

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
