use super::*;

pub(crate) async fn pull_content(options: &GetOptions, id: &str) -> Result<()> {
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
