use super::*;

pub(crate) fn resolve_result_urls(
    result: &PushResponse,
    encryption_key: Option<&str>,
) -> (String, String) {
    match encryption_key {
        Some(key) => (
            format!("{}#{}", result.url, key),
            format!("{}#{}", result.raw_url, key),
        ),
        None => (result.url.clone(), result.raw_url.clone()),
    }
}

pub(crate) struct HistoryRecordInput {
    pub(crate) source: Option<String>,
    pub(crate) content_type: Option<String>,
    pub(crate) filename: Option<String>,
    pub(crate) size: Option<u64>,
    pub(crate) storage_type: Option<String>,
}

pub(crate) fn record_history(
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

pub(crate) fn format_result_line(url: &str, copied: bool) -> String {
    if copied {
        format!(
            "{} {} {}",
            "→".green(),
            url.cyan(),
            "(copied to clipboard)".dimmed()
        )
    } else {
        format!("{} {}", "→".green(), url.cyan())
    }
}

pub(crate) fn print_result(
    options: &UploadOptions,
    result: &PushResponse,
    encryption_key: Option<&str>,
) {
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
        let copied = !options.no_copy && copy_to_clipboard(&url).is_ok();
        println!("{}", format_result_line(&url, copied));
    }
}

pub(crate) fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn is_binary_content_type(content_type: &str) -> bool {
    content_type.starts_with("image/")
        || content_type.starts_with("video/")
        || content_type.starts_with("audio/")
        || content_type.starts_with("application/octet-stream")
        || content_type.starts_with("application/pdf")
        || content_type.starts_with("application/zip")
        || content_type.starts_with("application/gzip")
        || content_type.starts_with("application/x-tar")
}

pub(crate) fn get_unique_filename(filename: &str) -> String {
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

pub(crate) fn format_history_age(created_at: u64) -> String {
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

pub(crate) fn print_recent_shares(options: &ListOptions) -> Result<()> {
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
        "{:<3} {:<18} {:<12} {:<10} {:<12} url",
        "#", "share", "mode", "age", "source"
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
