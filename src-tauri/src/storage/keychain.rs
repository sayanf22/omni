use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Security::Credentials::{
    CREDENTIALW, CRED_PERSIST_ENTERPRISE, CRED_TYPE_GENERIC,
    CredWriteW, CredReadW, CredDeleteW, CredFree
};

/// Stores a key in the Windows Credential Manager under the target name "Omni/{name}".
pub fn store_key(name: &str, value: &str) -> anyhow::Result<()> {
    let target_str = format!("Omni/{}", name);
    let target = target_str.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let value_bytes = value.as_bytes();

    let cred = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_ptr() as *mut u16),
        CredentialBlobSize: value_bytes.len() as u32,
        CredentialBlob: value_bytes.as_ptr() as *mut _,
        Persist: CRED_PERSIST_ENTERPRISE,
        ..Default::default()
    };

    unsafe {
        CredWriteW(&cred, 0)
            .map_err(|e| anyhow::anyhow!("Failed to write credential: {:?}", e))?;
    }
    Ok(())
}

/// Retrieves a key from the Windows Credential Manager.
pub fn get_key(name: &str) -> anyhow::Result<Option<String>> {
    let target_str = format!("Omni/{}", name);
    let target = target_str.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();

    unsafe {
        let mut p_cred: *mut CREDENTIALW = std::ptr::null_mut();
        // Note: in windows-rs, CredReadW returns a Result<()> or BOOL.
        // We use a helper function or match to handle it gracefully.
        if CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0, &mut p_cred).is_ok() {
            if p_cred.is_null() {
                return Ok(None);
            }
            let blob_size = (*p_cred).CredentialBlobSize as usize;
            let blob_ptr = (*p_cred).CredentialBlob;
            let bytes = std::slice::from_raw_parts(blob_ptr, blob_size);
            let value = String::from_utf8(bytes.to_vec())
                .map_err(|e| anyhow::anyhow!("Failed to parse UTF-8: {}", e))?;

            CredFree(p_cred as *mut _);
            Ok(Some(value))
        } else {
            Ok(None)
        }
    }
}

/// Deletes a key from the Windows Credential Manager.
pub fn delete_key(name: &str) -> anyhow::Result<()> {
    let target_str = format!("Omni/{}", name);
    let target = target_str.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    unsafe {
        let _ = CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0);
    }
    Ok(())
}

/// Checks if a key exists in the Windows Credential Manager.
pub fn has_key(name: &str) -> bool {
    get_key(name).map(|opt| opt.is_some()).unwrap_or(false)
}

/// Tauri IPC wrappers
#[tauri::command]
pub fn save_api_key(name: String, value: String) -> Result<(), String> {
    store_key(&name, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_api_key(name: String) -> Result<Option<String>, String> {
    if has_key(&name) {
        Ok(Some("••••••••••••••••".to_string()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn delete_api_key(name: String) -> Result<(), String> {
    delete_key(&name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn has_api_key(name: String) -> bool {
    has_key(&name)
}
