use super::*;

pub(crate) fn get_base_url() -> String {
    if let Ok(url) = std::env::var("SHRD_BASE_URL") {
        return url;
    }

    if let Some(url) = get_config_base_url() {
        return url;
    }

    DEFAULT_BASE_URL.to_string()
}

pub(crate) fn history_file_path() -> Result<std::path::PathBuf> {
    Ok(get_config_dir()?.join("history.json"))
}

pub(crate) fn load_history() -> Result<Vec<HistoryEntry>> {
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

pub(crate) fn save_history(entries: &[HistoryEntry]) -> Result<()> {
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

pub(crate) fn append_history(entry: HistoryEntry) -> Result<()> {
    let mut entries = load_history()?;
    entries.insert(0, entry);
    entries.truncate(MAX_HISTORY_ITEMS);
    save_history(&entries)
}

pub(crate) fn latest_history_entry() -> Result<HistoryEntry> {
    load_history()?
        .into_iter()
        .next()
        .context("No recent shares yet")
}

pub(crate) fn resolve_recent_reference(input: &str) -> Result<String> {
    if input != "last" {
        return Ok(input.to_string());
    }

    Ok(latest_history_entry()?.url)
}

pub(crate) fn mode_label(mode: ShareMode) -> &'static str {
    match mode {
        ShareMode::Temporary => "temporary",
        ShareMode::Private => "private",
        ShareMode::Permanent => "permanent",
    }
}

pub(crate) fn history_mode_label(options: &UploadOptions) -> String {
    if let Some(mode) = effective_mode(options) {
        return mode_label(mode).to_string();
    }

    if effective_encrypt(options) {
        return "encrypted".to_string();
    }

    "default".to_string()
}

pub(crate) fn infer_history_kind(content_type: &str) -> HistoryKind {
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

pub(crate) fn root_get_options(cli: &Cli) -> GetOptions {
    GetOptions {
        meta: cli.meta,
        quiet: cli.upload.quiet,
        raw: false,
        output: None,
        open: false,
        copy: false,
    }
}

pub(crate) fn effective_mode(options: &UploadOptions) -> Option<ShareMode> {
    options.mode
}

pub(crate) fn effective_expire(options: &UploadOptions) -> Option<String> {
    if let Some(expire) = &options.expire {
        return Some(expire.clone());
    }

    match effective_mode(options) {
        Some(ShareMode::Temporary) => Some("1h".to_string()),
        Some(ShareMode::Permanent) => Some("never".to_string()),
        _ => Some(DEFAULT_EXPIRE.to_string()),
    }
}

pub(crate) fn effective_encrypt(options: &UploadOptions) -> bool {
    options.encrypt || matches!(effective_mode(options), Some(ShareMode::Private))
}

pub(crate) fn effective_burn(options: &UploadOptions) -> bool {
    options.burn
}

pub(crate) fn get_config_base_url() -> Option<String> {
    let config_dir = get_config_dir().ok()?;
    let config_file = config_dir.join("config.json");
    let content = std::fs::read_to_string(config_file).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    json.get("base_url")?.as_str().map(String::from)
}

pub(crate) fn save_config_url(url: &str) -> Result<()> {
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

pub(crate) fn get_config_dir() -> Result<std::path::PathBuf> {
    let config_dir = dirs::config_dir()
        .context("Could not find config directory")?
        .join("shrd");
    std::fs::create_dir_all(&config_dir)?;
    Ok(config_dir)
}

pub(crate) fn print_config_show(json: bool) -> Result<()> {
    let base_url = get_base_url();
    let config_dir = get_config_dir()?;
    let history_count = load_history().map(|entries| entries.len()).unwrap_or(0);

    if json {
        let summary = ConfigSummary {
            base_url,
            config_dir: config_dir.display().to_string(),
            recent_shares: history_count,
        };
        println!("{}", serde_json::to_string_pretty(&summary)?);
        return Ok(());
    }

    println!("Configuration:");
    println!("  Base URL: {}", base_url.cyan());
    println!("  Config dir: {}", config_dir.display());
    println!("  Recent shares: {}", history_count);

    Ok(())
}

pub(crate) const DEFAULT_UPLOAD_SPEED: f64 = 500_000.0;

pub(crate) fn get_upload_speed() -> f64 {
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

pub(crate) fn save_upload_speed(speed_bps: f64, body_size: usize) {
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
pub(crate) fn copy_to_clipboard(text: &str) -> Result<()> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new()?;
    clipboard.set_text(text)?;
    Ok(())
}

#[cfg(not(feature = "clipboard"))]
pub(crate) fn copy_to_clipboard(_text: &str) -> Result<()> {
    Ok(())
}

#[cfg(feature = "clipboard")]
pub(crate) fn get_clipboard() -> Result<String> {
    use arboard::Clipboard;
    let mut clipboard = Clipboard::new()?;
    clipboard
        .get_text()
        .context("Failed to get clipboard contents")
}

#[cfg(not(feature = "clipboard"))]
pub(crate) fn get_clipboard() -> Result<String> {
    anyhow::bail!("Clipboard support not compiled in")
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    digest(&SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect::<String>()
}

pub(crate) fn upload_idempotency_key() -> Result<String> {
    let rng = SystemRandom::new();
    let mut bytes = [0u8; 16];
    rng.fill(&mut bytes)
        .map_err(|_| anyhow::anyhow!("Failed to generate idempotency key"))?;
    Ok(format!("shrd-upload-{}", URL_SAFE_NO_PAD.encode(bytes)))
}

pub(crate) fn should_retry_status(status: StatusCode, response: &reqwest::Response) -> bool {
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

pub(crate) async fn retry_delay(attempt: usize) {
    let jitter = (unix_now() % 250) + 50;
    let base_ms = 150u64.saturating_mul(1u64 << attempt.min(5));
    tokio::time::sleep(std::time::Duration::from_millis(base_ms + jitter)).await;
}

pub(crate) async fn send_with_retry<F>(
    mut make_request: F,
    attempts: usize,
) -> Result<reqwest::Response>
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

pub(crate) fn uploads_dir() -> Result<PathBuf> {
    let dir = get_config_dir()?.join("uploads");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub(crate) fn manifest_path_for_upload(id: &str) -> Result<PathBuf> {
    Ok(uploads_dir()?.join(format!("{}.json", id)))
}

pub(crate) fn write_resume_manifest(
    manifest_path: &Path,
    manifest: &MultipartResumeManifest,
) -> Result<()> {
    std::fs::write(manifest_path, serde_json::to_string_pretty(manifest)?)?;
    Ok(())
}

pub(crate) fn read_resume_manifest(path: &str) -> Result<MultipartResumeManifest> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read manifest: {}", path))?;
    Ok(serde_json::from_str(&content)?)
}

pub(crate) fn parse_age_filter(value: &str) -> Result<u64> {
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

pub(crate) fn history_source_label(source: Option<&str>) -> Option<String> {
    match source {
        Some("inline") => Some("inline".to_string()),
        Some("stdin") => Some("stdin".to_string()),
        Some("clipboard") => Some("clipboard".to_string()),
        Some(_) => Some("path".to_string()),
        None => None,
    }
}

pub(crate) fn matches_history_mode(entry: &HistoryEntry, filter: HistoryModeFilter) -> bool {
    let mode = entry.mode.as_deref().unwrap_or("default");
    match filter {
        HistoryModeFilter::Temporary => mode == "temporary",
        HistoryModeFilter::Private => mode == "private",
        HistoryModeFilter::Permanent => mode == "permanent",
        HistoryModeFilter::Default => mode == "default",
        HistoryModeFilter::Encrypted => mode == "encrypted",
    }
}

pub(crate) fn matches_history_source(entry: &HistoryEntry, filter: HistorySourceFilter) -> bool {
    let source = entry.source.as_deref().unwrap_or("inline");
    match filter {
        HistorySourceFilter::Inline => source == "inline",
        HistorySourceFilter::Stdin => source == "stdin",
        HistorySourceFilter::Clipboard => source == "clipboard",
        HistorySourceFilter::Path => source == "path",
    }
}

pub(crate) fn history_match_score(entry: &HistoryEntry, query: &str) -> Option<i64> {
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

pub(crate) fn filter_history_entries(
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

pub(crate) fn preferred_filename(meta: &ShareMeta, id: &str) -> String {
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

pub(crate) enum OutputTarget {
    Stdout,
    File(PathBuf),
}

pub(crate) fn resolve_output_target(
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

pub(crate) fn temp_output_path(meta: &ShareMeta, id: &str) -> PathBuf {
    let unique = unix_now();
    std::env::temp_dir().join(format!("{}-{}", unique, preferred_filename(meta, id)))
}

pub(crate) fn upload_progress_bar(total: u64, options: &UploadOptions) -> Option<ProgressBar> {
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

pub(crate) fn body_from_bytes(bytes: Vec<u8>, progress_bar: Option<ProgressBar>) -> Body {
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
