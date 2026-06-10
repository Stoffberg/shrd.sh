use super::*;

pub(crate) fn parse_id_and_key(input: &str) -> (String, Option<String>) {
    if let Some(hash_pos) = input.find('#') {
        let id = input[..hash_pos].to_string();
        let fragment = &input[hash_pos + 1..];
        let key = if let Some(stripped) = fragment.strip_prefix("key=") {
            Some(stripped.to_string())
        } else {
            Some(fragment.to_string())
        };
        (id, key)
    } else {
        (input.to_string(), None)
    }
}

pub(crate) fn normalize_share_id(input: &str) -> String {
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

pub(crate) fn is_valid_share_id(input: &str) -> bool {
    let id = normalize_share_id(input);
    let len = id.len();
    (4..=64).contains(&len)
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(crate) fn looks_like_share_reference(input: &str) -> bool {
    let trimmed = input.trim();
    if trimmed.contains("://") || trimmed.contains('/') || trimmed.contains('#') {
        return is_valid_share_id(trimmed);
    }

    let id = normalize_share_id(trimmed);
    id.len() == GENERATED_ID_LEN && is_valid_share_id(&id)
}
