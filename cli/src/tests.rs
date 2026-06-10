use super::*;
use clap::error::ErrorKind;

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
fn format_result_line_keeps_success_output_to_one_line() {
    let line = format_result_line("https://shrd.stoff.dev/w4rttq", false);

    assert!(line.contains("https://shrd.stoff.dev/w4rttq"));
    assert!(!line.contains("expires"));
    assert!(!line.contains('\n'));
}

#[test]
fn format_result_line_appends_clipboard_status_inline() {
    let line = format_result_line("https://shrd.stoff.dev/w4rttq", true);

    assert!(line.contains("https://shrd.stoff.dev/w4rttq"));
    assert!(line.contains("copied to clipboard"));
    assert!(!line.contains('\n'));
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
    let cli =
        Cli::try_parse_from(["shrd", "get", "release_notes#key=abc"]).expect("cli should parse");

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
fn default_expiry_is_one_year() {
    let options = UploadOptions::default();
    assert_eq!(effective_expire(&options).as_deref(), Some("365d"));
}

#[test]
fn modes_override_default_expiry() {
    let temporary = UploadOptions {
        mode: Some(ShareMode::Temporary),
        ..UploadOptions::default()
    };
    let permanent = UploadOptions {
        mode: Some(ShareMode::Permanent),
        ..UploadOptions::default()
    };

    assert_eq!(effective_expire(&temporary).as_deref(), Some("1h"));
    assert_eq!(effective_expire(&permanent).as_deref(), Some("never"));
}

#[test]
fn lowercase_v_is_version_flag() {
    let err = Cli::try_parse_from(["shrd", "-v"]).expect_err("version should exit early");
    assert_eq!(err.kind(), clap::error::ErrorKind::DisplayVersion);
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
