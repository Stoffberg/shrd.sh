use super::*;

pub(crate) fn encrypt_content(plaintext: &[u8]) -> Result<(Vec<u8>, String)> {
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

pub(crate) fn decrypt_content(ciphertext: &[u8], key_b64: &str) -> Result<Vec<u8>> {
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
