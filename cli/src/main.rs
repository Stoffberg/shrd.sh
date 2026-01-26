use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use colored::Colorize;
use futures::stream::{self, StreamExt};
use indicatif::{ProgressBar, ProgressStyle};
use reqwest::Body;
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::time::Instant;

const DEFAULT_BASE_URL: &str = "https://shrd.stoff.dev";

#[derive(Parser)]
#[command(name = "shrd")]
#[command(about = "Share anything, instantly", long_about = None)]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[arg(help = "Content ID to retrieve, or content to share")]
    input: Option<String>,

    #[arg(short = 'x', long, help = "Expiry time (1h, 24h, 7d, 30d, never)")]
    expire: Option<String>,

    #[arg(short, long, help = "Delete after first view")]
    burn: bool,

    #[arg(short, long, help = "End-to-end encrypt")]
    encrypt: bool,

    #[arg(short, long, help = "Custom name/slug")]
    name: Option<String>,

    #[arg(short, long, help = "Output as JSON")]
    json: bool,

    #[arg(short, long, help = "Suppress output except errors")]
    quiet: bool,

    #[arg(long, help = "Don't copy to clipboard")]
    no_copy: bool,

    #[arg(short, long, help = "Share clipboard contents")]
    clipboard: bool,

    #[arg(long, help = "Get metadata instead of content")]
    meta: bool,
}

#[derive(Subcommand)]
enum Commands {
    #[command(about = "Log in to shrd.sh")]
    Login,
    #[command(about = "Log out of shrd.sh")]
    Logout,
    #[command(about = "Show current user")]
    Whoami,
    #[command(about = "Configure shrd settings")]
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
}

#[derive(Subcommand)]
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
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    encrypt: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
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

fn get_auth_token() -> Option<String> {
    let config_dir = get_config_dir().ok()?;
    let auth_file = config_dir.join("auth.json");
    let content = std::fs::read_to_string(auth_file).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("token")?.as_str().map(String::from)
}

fn save_auth_token(token: &str) -> Result<()> {
    let config_dir = get_config_dir()?;
    let auth_file = config_dir.join("auth.json");
    let content = serde_json::json!({ "token": token });
    std::fs::write(auth_file, serde_json::to_string_pretty(&content)?)?;
    Ok(())
}

fn clear_auth_token() -> Result<()> {
    let config_dir = get_config_dir()?;
    let auth_file = config_dir.join("auth.json");
    if auth_file.exists() {
        std::fs::remove_file(auth_file)?;
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
    let _ = std::fs::write(&config_file, serde_json::to_string_pretty(&config).unwrap_or_default());
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
    clipboard.get_text().context("Failed to get clipboard contents")
}

#[cfg(not(feature = "clipboard"))]
fn get_clipboard() -> Result<String> {
    anyhow::bail!("Clipboard support not compiled in")
}

fn is_valid_id(s: &str) -> bool {
    let s = s.trim_start_matches("https://").trim_start_matches("http://");
    let s = s.trim_start_matches("shrd.sh/").trim_start_matches("shrd.stoff.dev/");
    s.len() >= 4 && s.len() <= 32 && s.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

fn extract_id(s: &str) -> &str {
    let s = s.trim_start_matches("https://").trim_start_matches("http://");
    s.trim_start_matches("shrd.sh/").trim_start_matches("shrd.stoff.dev/")
}

async fn push_content(cli: &Cli, content: String) -> Result<()> {
    let client = reqwest::Client::new();
    let base_url = get_base_url();

    let request = PushRequest {
        content,
        expire: cli.expire.clone(),
        burn: cli.burn,
        encrypt: cli.encrypt,
        name: cli.name.clone(),
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

    let mut req = client
        .post(format!("{}/api/v1/push", base_url))
        .header("Content-Type", "application/json");

    if let Some(token) = get_auth_token() {
        req = req.header("Authorization", format!("Bearer {}", token));
    }

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

    if cli.json {
        println!("{}", serde_json::to_string_pretty(&serde_json::json!({
            "id": result.id,
            "url": result.url,
            "rawUrl": result.raw_url,
            "deleteUrl": result.delete_url,
            "expiresAt": result.expires_at,
            "deleteToken": result.delete_token,
        }))?);
    } else if !cli.quiet {
        println!("{} {}", "→".green(), result.url.cyan());

        if !cli.no_copy {
            if copy_to_clipboard(&result.url).is_ok() {
                eprintln!("{}", "(copied to clipboard)".dimmed());
            }
        }
    }

    Ok(())
}

async fn pull_content(cli: &Cli, id: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let base_url = get_base_url();
    let id = extract_id(id);

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
    } else {
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

        let content = response.text().await?;
        print!("{}", content);
        io::stdout().flush()?;
    }

    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    match &cli.command {
        Some(Commands::Login) => {
            let base_url = get_base_url();
            println!("Opening {} in your browser...", format!("{}/login", base_url).cyan());
            println!("After logging in, paste the token here:");
            print!("> ");
            io::stdout().flush()?;

            let mut token = String::new();
            io::stdin().read_line(&mut token)?;
            let token = token.trim();

            if token.is_empty() {
                anyhow::bail!("No token provided");
            }

            save_auth_token(token)?;
            println!("{} Logged in successfully!", "✓".green());
            return Ok(());
        }
        Some(Commands::Logout) => {
            clear_auth_token()?;
            println!("{} Logged out.", "✓".green());
            return Ok(());
        }
        Some(Commands::Whoami) => {
            if get_auth_token().is_some() {
                println!("Authenticated");
            } else {
                println!("Not logged in");
            }
            return Ok(());
        }
        Some(Commands::Config { action }) => {
            match action {
                ConfigAction::SetUrl { url } => {
                    save_config_url(url)?;
                    println!("{} Base URL set to: {}", "✓".green(), url.cyan());
                }
                ConfigAction::Show => {
                    let base_url = get_base_url();
                    let config_dir = get_config_dir()?;
                    println!("Configuration:");
                    println!("  Base URL: {}", base_url.cyan());
                    println!("  Config dir: {}", config_dir.display());
                    if get_auth_token().is_some() {
                        println!("  Auth: {}", "logged in".green());
                    } else {
                        println!("  Auth: {}", "not logged in".yellow());
                    }
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

    if cli.clipboard {
        let content = get_clipboard()?;
        return push_content(&cli, content).await;
    }

    if let Some(ref input) = cli.input {
        if is_valid_id(input) {
            return pull_content(&cli, input).await;
        } else if std::path::Path::new(input).exists() {
            let content = std::fs::read_to_string(input)
                .with_context(|| format!("Failed to read file: {}", input))?;
            return push_content(&cli, content).await;
        } else {
            return push_content(&cli, input.clone()).await;
        }
    }

    if atty::isnt(atty::Stream::Stdin) {
        let mut content = String::new();
        io::stdin().read_to_string(&mut content)?;
        if content.is_empty() {
            anyhow::bail!("No content provided");
        }
        return push_content(&cli, content).await;
    }

    println!("{}", "Usage: shrd [OPTIONS] [INPUT]".yellow());
    println!();
    println!("Examples:");
    println!("  {} | shrd           # Share from pipe", "cat file.txt".dimmed());
    println!("  {} file.txt           # Share a file", "shrd".dimmed());
    println!("  {} abc123              # Retrieve by ID", "shrd".dimmed());
    println!("  {} -c                  # Share clipboard", "shrd".dimmed());
    println!();
    println!("Run {} for more options.", "shrd --help".cyan());

    Ok(())
}
