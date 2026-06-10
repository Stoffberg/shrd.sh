use super::*;

pub(crate) async fn upload_from_source(
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

pub(crate) async fn run() -> Result<()> {
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
