use sha2::{Sha256, Digest};
use aes_gcm::{
    aead::{Aead, KeyInit, AeadCore},
    Aes256Gcm, Nonce
};
use aes_gcm::aead::OsRng;
use base64::{Engine as _, engine::general_purpose::STANDARD};

/// Derives a 256-bit encryption key deterministically from the user's password and user_id.
/// Uses 100,000 rounds of SHA-256 to resist brute-force attacks.
pub fn derive_encryption_key(user_id: &str, password: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(user_id.as_bytes());
    hasher.update(b":");
    hasher.update(password.as_bytes());
    let mut key = hasher.finalize();

    for _ in 0..99_999 {
        let mut h = Sha256::new();
        h.update(&key);
        key = h.finalize();
    }

    let mut result = [0u8; 32];
    result.copy_from_slice(&key);
    result
}

/// Encrypts a plaintext string using AES-256-GCM with the derived key.
/// Returns the Base64-encoded payload (nonce + ciphertext).
pub fn encrypt_data(key_bytes: &[u8; 32], plaintext: &str) -> Result<String, String> {
    let key = aes_gcm::Key::<Aes256Gcm>::from_slice(key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 12 bytes
    
    let ciphertext = cipher.encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| format!("Encryption error: {:?}", e))?;
    
    let mut result = nonce.to_vec();
    result.extend_from_slice(&ciphertext);
    Ok(STANDARD.encode(&result))
}

/// Decrypts a Base64-encoded payload (nonce + ciphertext) using AES-256-GCM with the derived key.
/// Returns the decrypted plaintext string.
pub fn decrypt_data(key_bytes: &[u8; 32], ciphertext_base64: &str) -> Result<String, String> {
    let data = STANDARD.decode(ciphertext_base64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    
    if data.len() < 12 {
        return Err("Ciphertext too short (missing nonce)".to_string());
    }
    
    let (nonce_bytes, ciphertext_bytes) = data.split_at(12);
    let key = aes_gcm::Key::<Aes256Gcm>::from_slice(key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce_bytes);
    
    let decrypted_bytes = cipher.decrypt(nonce, ciphertext_bytes)
        .map_err(|e| format!("Decryption error: {:?}", e))?;
    
    String::from_utf8(decrypted_bytes)
        .map_err(|e| format!("UTF-8 conversion error: {}", e))
}
