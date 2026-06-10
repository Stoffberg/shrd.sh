use super::*;

pub(crate) async fn push_content(
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

pub(crate) const MULTIPART_THRESHOLD: u64 = 95 * 1024 * 1024;

pub(crate) fn read_file_part(path: &str, offset: u64, size: usize) -> Result<Vec<u8>> {
    let mut file = File::open(path).with_context(|| format!("Failed to read file: {}", path))?;
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0; size];
    file.read_exact(&mut bytes)?;
    Ok(bytes)
}

pub(crate) async fn upload_file_streaming(options: &UploadOptions, path: &str) -> Result<()> {
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
    let file_content =
        std::fs::read(path).with_context(|| format!("Failed to read file: {}", path))?;
    if file_size <= INLINE_STORAGE_LIMIT as u64 {
        if let Ok(text_content) = String::from_utf8(file_content.clone()) {
            return push_content(
                options,
                text_content,
                Some(content_type),
                Some(filename),
                Some("path".to_string()),
            )
            .await;
        }
    }

    let client = reqwest::Client::new();
    let base_url = get_base_url();
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
    let idempotency_key = upload_idempotency_key()?;
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

pub(crate) async fn finalize_multipart_upload(
    client: &reqwest::Client,
    base_url: &str,
    options: &UploadOptions,
    manifest_path: &Path,
    manifest: &MultipartResumeManifest,
    details: MultipartFinalizeDetails,
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
                .header("X-Total-Size", details.content_size.to_string())
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
            content_type: Some(details.content_type),
            filename: Some(details.filename),
            size: Some(details.content_size),
            storage_type: Some("r2".to_string()),
        },
    );
    Ok(())
}

pub(crate) async fn upload_file_multipart(
    options: &UploadOptions,
    path: &str,
    file_size: u64,
) -> Result<()> {
    let path_obj = Path::new(path);
    let filename = path_obj
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file")
        .to_string();
    let content_type = guess_content_type(path);
    let client = reqwest::Client::new();
    let base_url = get_base_url();
    let encrypt = effective_encrypt(options);
    let burn = effective_burn(options);
    let expire = effective_expire(options);

    let (encrypted_payload, encryption_key, content_size) = if encrypt {
        let file_content =
            std::fs::read(path).with_context(|| format!("Failed to read file: {}", path))?;
        let (encrypted, key) = encrypt_content(&file_content)?;
        let size = encrypted.len() as u64;
        (Some(encrypted), Some(key), size)
    } else {
        (None, None, file_size)
    };

    let mut init_request = || {
        let mut request = client
            .post(format!("{}/api/v1/multipart/init", base_url))
            .header("X-Content-Type", &content_type)
            .header("X-Filename", &filename);

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
    let payload_path = if let Some(upload_content) = encrypted_payload {
        let payload_path = uploads_dir()?.join(format!("{}.payload", init.id));
        std::fs::write(&payload_path, &upload_content)?;
        payload_path.to_string_lossy().to_string()
    } else {
        path.to_string()
    };
    let mut manifest = MultipartResumeManifest {
        file_path: payload_path.clone(),
        file_size: content_size,
        base_url: base_url.clone(),
        share_id: init.id.clone(),
        upload_id: init.upload_id.clone(),
        resume_token: init.resume_token.clone(),
        part_size: init.part_size,
        uploaded_parts: Vec::new(),
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
        let part_data = read_file_part(&payload_path, uploaded, part_size)?;
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
            .sort_by_key(|entry| entry.part_number);
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
        MultipartFinalizeDetails {
            content_type,
            filename,
            content_size,
        },
        encryption_key.as_deref(),
    )
    .await
}

pub(crate) async fn resume_multipart_upload(
    options: &UploadOptions,
    manifest_path: &str,
) -> Result<()> {
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
        let part_data = read_file_part(&path, uploaded, part_size)?;
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
            .sort_by_key(|entry| entry.part_number);
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
        MultipartFinalizeDetails {
            content_type,
            filename,
            content_size: manifest.file_size,
        },
        manifest.encryption_key.as_deref(),
    )
    .await
}
