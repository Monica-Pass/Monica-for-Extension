//! Windows Hello boundary for the privileged Native Messaging Host.
//!
//! The extension never receives a WebAuthn assertion or a private key.  The
//! Host asks the Windows platform authenticator to perform user verification
//! and returns only bounded status/result objects.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::runtime::RpcFailure;

pub const HELLO_PROTOCOL_VERSION: u32 = 1;
pub const HELLO_RP_ID: &str = "monica-extension.local";
const HELLO_ORIGIN: &str = "https://monica-extension.local";
const HELLO_TIMEOUT_MS: u32 = 120_000;
const MAX_BINDING_ID_BYTES: usize = 64;
const MAX_CHALLENGE_BYTES: usize = 64;
const MIN_CHALLENGE_BYTES: usize = 32;
const MAX_CREDENTIAL_ID_BYTES: usize = 1024;
const MAX_HELLO_RECORDS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HelloCredentialRecord {
    version: u32,
    binding_id: String,
    rp_id: String,
    credential_id: String,
    created_at_unix_secs: u64,
    #[serde(default)]
    last_verified_at_unix_secs: Option<u64>,
}

pub struct WindowsHelloStore {
    root: PathBuf,
}

impl WindowsHelloStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn status(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "hello.status params must be an object.")?;
        let binding_id = optional_binding_id(params.remove("bindingId"))?;
        reject_unknown(params)?;
        let available = platform_authenticator_available()?;
        let (enrolled, record_invalid) = match binding_id.as_deref() {
            None => (false, false),
            Some(id) => match read_record(&self.record_path(id)) {
                Ok(None) => (false, false),
                Ok(Some(record)) => match credential_bytes(&record, id) {
                    Ok(_) => (true, false),
                    Err(_) => (false, true),
                },
                Err(_) => (false, true),
            },
        };
        Ok(json!({
            "version": HELLO_PROTOCOL_VERSION,
            "supported": cfg!(windows),
            "available": available,
            "enrolled": enrolled,
            "bindingIdPresent": binding_id.is_some(),
            "rpId": HELLO_RP_ID,
            "reason": if !cfg!(windows) { "windows-only" } else if record_invalid { "binding-record-invalid" } else if !available { "platform-authenticator-unavailable" } else if !enrolled { "not-enrolled" } else { "ready" }
        }))
    }

    pub fn enroll(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "hello.enroll params must be an object.")?;
        let binding_id = binding_id_value(params.remove("bindingId"))?;
        let display_name = optional_bounded_string(params.remove("displayName"), 128)?
            .unwrap_or_else(|| "Monica 密码库".to_string());
        let confirmed = bool_value(params.remove("confirmed"), "confirmed")?;
        reject_unknown(params)?;
        if !confirmed {
            return Err(RpcFailure::new(
                "confirmation-required",
                "注册 Windows Hello 需要明确确认。",
                false,
            ));
        }
        if self.record_path(&binding_id).exists() {
            return Err(RpcFailure::new(
                "hello-already-enrolled",
                "此 Monica 本地绑定已经注册 Windows Hello。",
                false,
            ));
        }
        if count_records(&self.root)? >= MAX_HELLO_RECORDS {
            return Err(RpcFailure::new(
                "hello-limit",
                "本机 Windows Hello 绑定数量已达到上限。",
                false,
            ));
        }
        let credential_id = platform_enroll(&binding_id, &display_name)?;
        let created_at = unix_seconds()?;
        let record = HelloCredentialRecord {
            version: HELLO_PROTOCOL_VERSION,
            binding_id: binding_id.clone(),
            rp_id: HELLO_RP_ID.to_string(),
            credential_id: URL_SAFE_NO_PAD.encode(credential_id),
            created_at_unix_secs: created_at,
            last_verified_at_unix_secs: None,
        };
        write_record(&self.record_path(&binding_id), &record)?;
        Ok(json!({
            "version": HELLO_PROTOCOL_VERSION,
            "bindingId": binding_id,
            "rpId": HELLO_RP_ID,
            "enrolledAtUnixSeconds": created_at,
            "verified": true
        }))
    }

    pub fn verify(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "hello.verify params must be an object.")?;
        let binding_id = binding_id_value(params.remove("bindingId"))?;
        let challenge = challenge_value(params.remove("challengeBase64Url"))?;
        reject_unknown(params)?;
        let path = self.record_path(&binding_id);
        let mut record = read_record(&path)?.ok_or_else(|| {
            RpcFailure::new(
                "hello-not-enrolled",
                "Windows Hello 尚未注册或本机绑定已丢失。",
                false,
            )
        })?;
        let credential_id = credential_bytes(&record, &binding_id)?;
        platform_verify(&binding_id, &challenge, &credential_id)?;
        let verified_at = unix_seconds()?;
        record.last_verified_at_unix_secs = Some(verified_at);
        write_record(&path, &record)?;
        Ok(json!({
            "version": HELLO_PROTOCOL_VERSION,
            "verified": true,
            "bindingId": binding_id,
            "proofId": Uuid::new_v4().to_string(),
            "expiresAtUnixSeconds": verified_at.saturating_add(60)
        }))
    }

    pub fn revoke(&self, params: Value) -> Result<Value, RpcFailure> {
        let mut params = take_object(params, "hello.revoke params must be an object.")?;
        let binding_id = binding_id_value(params.remove("bindingId"))?;
        let confirmed = bool_value(params.remove("confirmed"), "confirmed")?;
        reject_unknown(params)?;
        if !confirmed {
            return Err(RpcFailure::new(
                "confirmation-required",
                "撤销 Windows Hello 需要明确确认。",
                false,
            ));
        }
        let path = self.record_path(&binding_id);
        let Some(record) = read_record(&path)? else {
            return Ok(
                json!({ "version": HELLO_PROTOCOL_VERSION, "revoked": true, "bindingId": binding_id }),
            );
        };
        let credential_id = credential_bytes(&record, &binding_id)?;
        platform_revoke(&credential_id)?;
        fs::remove_file(&path).map_err(|_| {
            RpcFailure::new(
                "hello-storage-error",
                "Windows Hello 本机绑定无法删除。",
                true,
            )
        })?;
        Ok(json!({ "version": HELLO_PROTOCOL_VERSION, "revoked": true, "bindingId": binding_id }))
    }

    fn record_path(&self, binding_id: &str) -> PathBuf {
        self.root.join("hello").join(format!("{binding_id}.json"))
    }
}

fn take_object(value: Value, message: &str) -> Result<Map<String, Value>, RpcFailure> {
    match value {
        Value::Object(value) => Ok(value),
        _ => Err(RpcFailure::invalid(message)),
    }
}

fn reject_unknown(value: Map<String, Value>) -> Result<(), RpcFailure> {
    if value.is_empty() {
        Ok(())
    } else {
        Err(RpcFailure::invalid("Windows Hello 参数包含未知字段。"))
    }
}

fn binding_id_value(value: Option<Value>) -> Result<String, RpcFailure> {
    let value = value.ok_or_else(|| RpcFailure::invalid("Windows Hello 绑定 ID 缺失。"))?;
    let Value::String(value) = value else {
        return Err(RpcFailure::invalid("Windows Hello 绑定 ID 无效。"));
    };
    let parsed =
        Uuid::parse_str(&value).map_err(|_| RpcFailure::invalid("Windows Hello 绑定 ID 无效。"))?;
    let normalized = parsed.to_string();
    if value != normalized || normalized.len() > MAX_BINDING_ID_BYTES {
        return Err(RpcFailure::invalid("Windows Hello 绑定 ID 无效。"));
    }
    Ok(normalized)
}

fn optional_binding_id(value: Option<Value>) -> Result<Option<String>, RpcFailure> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => binding_id_value(Some(value)).map(Some),
    }
}

fn challenge_value(value: Option<Value>) -> Result<Vec<u8>, RpcFailure> {
    let value = value.ok_or_else(|| RpcFailure::invalid("Windows Hello 验证挑战缺失。"))?;
    let Value::String(value) = value else {
        return Err(RpcFailure::invalid("Windows Hello 验证挑战无效。"));
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| RpcFailure::invalid("Windows Hello 验证挑战无效。"))?;
    if bytes.len() < MIN_CHALLENGE_BYTES || bytes.len() > MAX_CHALLENGE_BYTES {
        return Err(RpcFailure::invalid("Windows Hello 验证挑战长度无效。"));
    }
    Ok(bytes)
}

fn optional_bounded_string(value: Option<Value>, max: usize) -> Result<Option<String>, RpcFailure> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() && value.len() <= max => Ok(Some(value)),
        _ => Err(RpcFailure::invalid("Windows Hello 显示名称无效。")),
    }
}

fn bool_value(value: Option<Value>, name: &str) -> Result<bool, RpcFailure> {
    match value {
        Some(Value::Bool(value)) => Ok(value),
        _ => Err(RpcFailure::invalid(format!(
            "Windows Hello {name} 参数无效。"
        ))),
    }
}

fn count_records(root: &Path) -> Result<usize, RpcFailure> {
    let directory = root.join("hello");
    let entries = fs::read_dir(directory).map_err(|_| {
        RpcFailure::new(
            "hello-storage-error",
            "Windows Hello 本机绑定目录不可用。",
            true,
        )
    })?;
    Ok(entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .take(MAX_HELLO_RECORDS + 1)
        .count())
}

fn read_record(path: &Path) -> Result<Option<HelloCredentialRecord>, RpcFailure> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|_| {
        RpcFailure::new(
            "hello-storage-error",
            "Windows Hello 本机绑定无法读取。",
            true,
        )
    })?;
    if bytes.len() > 16 * 1024 {
        return Err(RpcFailure::new(
            "hello-record-invalid",
            "Windows Hello 本机绑定过大。",
            false,
        ));
    }
    let record = serde_json::from_slice(&bytes).map_err(|_| {
        RpcFailure::new(
            "hello-record-invalid",
            "Windows Hello 本机绑定格式无效。",
            false,
        )
    })?;
    Ok(Some(record))
}

fn credential_bytes(
    record: &HelloCredentialRecord,
    binding_id: &str,
) -> Result<Vec<u8>, RpcFailure> {
    if record.rp_id != HELLO_RP_ID
        || record.binding_id != binding_id
        || record.version != HELLO_PROTOCOL_VERSION
    {
        return Err(RpcFailure::new(
            "hello-record-invalid",
            "Windows Hello 本机绑定记录无效，已保持锁定。",
            false,
        ));
    }
    let credential_id = URL_SAFE_NO_PAD
        .decode(record.credential_id.as_bytes())
        .map_err(|_| {
            RpcFailure::new(
                "hello-record-invalid",
                "Windows Hello 凭据记录无效，已保持锁定。",
                false,
            )
        })?;
    if credential_id.is_empty() || credential_id.len() > MAX_CREDENTIAL_ID_BYTES {
        return Err(RpcFailure::new(
            "hello-record-invalid",
            "Windows Hello 凭据记录长度无效，已保持锁定。",
            false,
        ));
    }
    Ok(credential_id)
}

fn write_record(path: &Path, record: &HelloCredentialRecord) -> Result<(), RpcFailure> {
    let directory = path.parent().ok_or_else(|| {
        RpcFailure::new(
            "hello-storage-error",
            "Windows Hello 本机绑定目录无效。",
            true,
        )
    })?;
    fs::create_dir_all(directory).map_err(|_| {
        RpcFailure::new(
            "hello-storage-error",
            "Windows Hello 本机绑定目录无法创建。",
            true,
        )
    })?;
    let temp = directory.join(format!("{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec(record).map_err(|_| {
        RpcFailure::new(
            "hello-storage-error",
            "Windows Hello 本机绑定无法编码。",
            true,
        )
    })?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| ())?;
        file.write_all(&bytes).map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
        if path.exists() {
            fs::remove_file(path).map_err(|_| ())?;
        }
        fs::rename(&temp, path).map_err(|_| ())?;
        Ok::<(), ()>(())
    })();
    let _ = fs::remove_file(&temp);
    result.map_err(|_| {
        RpcFailure::new(
            "hello-storage-error",
            "Windows Hello 本机绑定无法保存。",
            true,
        )
    })
}

fn unix_seconds() -> Result<u64, RpcFailure> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .map_err(|_| RpcFailure::new("hello-clock-error", "系统时间不可用。", true))
}

#[cfg(not(windows))]
fn platform_authenticator_available() -> Result<bool, RpcFailure> {
    Ok(false)
}

#[cfg(not(windows))]
fn platform_enroll(_: &str, _: &str) -> Result<Vec<u8>, RpcFailure> {
    Err(RpcFailure::new(
        "hello-unsupported",
        "Windows Hello 仅支持 Windows。",
        false,
    ))
}

#[cfg(not(windows))]
fn platform_verify(_: &str, _: &[u8], _: &[u8]) -> Result<(), RpcFailure> {
    Err(RpcFailure::new(
        "hello-unsupported",
        "Windows Hello 仅支持 Windows。",
        false,
    ))
}

#[cfg(not(windows))]
fn platform_revoke(_: &[u8]) -> Result<(), RpcFailure> {
    Err(RpcFailure::new(
        "hello-unsupported",
        "Windows Hello 仅支持 Windows。",
        false,
    ))
}

#[cfg(windows)]
mod windows_platform {
    use super::*;
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::core::HRESULT;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Networking::WindowsWebServices::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value).encode_wide().chain(once(0)).collect()
    }

    fn error_for(hr: HRESULT, action: &str) -> RpcFailure {
        let name = unsafe {
            let pointer = WebAuthNGetErrorName(hr);
            if pointer.is_null() {
                String::new()
            } else {
                let mut length = 0usize;
                while *pointer.add(length) != 0 && length < 128 {
                    length += 1;
                }
                String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
            }
        };
        let lowered = name.to_ascii_lowercase();
        if lowered == "notallowederror" {
            return RpcFailure::new(
                "hello-cancelled",
                format!("Windows Hello {action} 被取消、超时或设备不可用。"),
                false,
            );
        }
        if lowered == "notsupportederror" || lowered == "constrainterror" {
            return RpcFailure::new(
                "hello-unavailable",
                format!("Windows Hello {action} 当前不可用。"),
                false,
            );
        }
        RpcFailure::new(
            "hello-native-error",
            format!("Windows Hello {action} 失败。"),
            true,
        )
    }

    fn supported_api_version() -> u32 {
        unsafe { WebAuthNGetApiVersionNumber() }.clamp(1, WEBAUTHN_API_CURRENT_VERSION)
    }

    fn interaction_window(action: &str) -> Result<HWND, RpcFailure> {
        let window = unsafe { GetForegroundWindow() };
        if window.is_null() {
            Err(RpcFailure::new(
                "hello-window-unavailable",
                format!("Windows Hello {action} 缺少可用的前台窗口。"),
                true,
            ))
        } else {
            Ok(window)
        }
    }

    pub fn available() -> Result<bool, RpcFailure> {
        let mut available = 0;
        let hr = unsafe { WebAuthNIsUserVerifyingPlatformAuthenticatorAvailable(&mut available) };
        if hr < 0 {
            return Err(error_for(hr, "设备检查"));
        }
        Ok(available != 0)
    }

    pub fn enroll(binding_id: &str, display_name: &str) -> Result<Vec<u8>, RpcFailure> {
        let window = interaction_window("注册")?;
        let rp_id = wide(HELLO_RP_ID);
        let rp_name = wide("Monica Password Manager");
        let user_name = wide(display_name);
        let user_display_name = wide(display_name);
        let mut user_id = Uuid::parse_str(binding_id)
            .map_err(|_| RpcFailure::invalid("Windows Hello 绑定 ID 无效。"))?
            .as_bytes()
            .to_vec();
        let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
            dwVersion: WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
            pwszId: rp_id.as_ptr(),
            pwszName: rp_name.as_ptr(),
            pwszIcon: std::ptr::null(),
        };
        let user = WEBAUTHN_USER_ENTITY_INFORMATION {
            dwVersion: WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
            cbId: user_id.len() as u32,
            pbId: user_id.as_mut_ptr(),
            pwszName: user_name.as_ptr(),
            pwszIcon: std::ptr::null(),
            pwszDisplayName: user_display_name.as_ptr(),
        };
        let mut credential_parameter = WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
            dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
            pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
            lAlg: WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256,
        };
        let credential_parameters = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS {
            cCredentialParameters: 1,
            pCredentialParameters: &mut credential_parameter,
        };
        let challenge = URL_SAFE_NO_PAD.encode(Uuid::new_v4().as_bytes());
        let mut client_json = format!(
            r#"{{"type":"webauthn.create","challenge":"{challenge}","origin":"{HELLO_ORIGIN}"}}"#
        )
        .into_bytes();
        let hash_alg = wide("SHA-256");
        let client_data = WEBAUTHN_CLIENT_DATA {
            dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
            cbClientDataJSON: client_json.len() as u32,
            pbClientDataJSON: client_json.as_mut_ptr(),
            pwszHashAlgId: hash_alg.as_ptr(),
        };
        let options = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS {
            dwVersion: supported_api_version()
                .min(WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS_CURRENT_VERSION),
            dwTimeoutMilliseconds: HELLO_TIMEOUT_MS,
            dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM,
            dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
            dwAttestationConveyancePreference: WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE,
            ..Default::default()
        };
        let mut attestation = std::ptr::null_mut();
        let hr = unsafe {
            WebAuthNAuthenticatorMakeCredential(
                window,
                &rp,
                &user,
                &credential_parameters,
                &client_data,
                &options,
                &mut attestation,
            )
        };
        if hr < 0 {
            return Err(error_for(hr, "注册"));
        }
        let result = if attestation.is_null() {
            Err(RpcFailure::new(
                "hello-native-error",
                "Windows Hello 注册没有返回凭据。",
                true,
            ))
        } else {
            let value = unsafe { &*attestation };
            if value.pbCredentialId.is_null()
                || value.cbCredentialId == 0
                || value.cbCredentialId as usize > MAX_CREDENTIAL_ID_BYTES
            {
                Err(RpcFailure::new(
                    "hello-native-error",
                    "Windows Hello 注册凭据无效。",
                    true,
                ))
            } else {
                Ok(unsafe {
                    std::slice::from_raw_parts(value.pbCredentialId, value.cbCredentialId as usize)
                        .to_vec()
                })
            }
        };
        if !attestation.is_null() {
            unsafe {
                WebAuthNFreeCredentialAttestation(attestation);
            }
        }
        result
    }

    pub fn verify(_: &str, challenge: &[u8], credential_id: &[u8]) -> Result<(), RpcFailure> {
        let window = interaction_window("验证")?;
        let rp_id = wide(HELLO_RP_ID);
        let challenge_encoded = URL_SAFE_NO_PAD.encode(challenge);
        let mut client_json = format!(r#"{{"type":"webauthn.get","challenge":"{challenge_encoded}","origin":"{HELLO_ORIGIN}"}}"#).into_bytes();
        let hash_alg = wide("SHA-256");
        let client_data = WEBAUTHN_CLIENT_DATA {
            dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
            cbClientDataJSON: client_json.len() as u32,
            pbClientDataJSON: client_json.as_mut_ptr(),
            pwszHashAlgId: hash_alg.as_ptr(),
        };
        let mut credential_id_mut = credential_id.to_vec();
        let mut credential = WEBAUTHN_CREDENTIAL {
            dwVersion: WEBAUTHN_CREDENTIAL_CURRENT_VERSION,
            cbId: credential_id_mut.len() as u32,
            pbId: credential_id_mut.as_mut_ptr(),
            pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
        };
        let credentials = WEBAUTHN_CREDENTIALS {
            cCredentials: 1,
            pCredentials: &mut credential,
        };
        let options = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
            dwVersion: supported_api_version()
                .min(WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS_CURRENT_VERSION),
            dwTimeoutMilliseconds: HELLO_TIMEOUT_MS,
            CredentialList: credentials,
            dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_PLATFORM,
            dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
            ..Default::default()
        };
        let mut assertion = std::ptr::null_mut();
        let hr = unsafe {
            WebAuthNAuthenticatorGetAssertion(
                window,
                rp_id.as_ptr(),
                &client_data,
                &options,
                &mut assertion,
            )
        };
        if hr < 0 {
            return Err(error_for(hr, "验证"));
        }
        let valid = !assertion.is_null()
            && unsafe {
                (*assertion).cbAuthenticatorData > 0
                    && (*assertion).cbSignature > 0
                    && (*assertion).Credential.cbId as usize == credential_id.len()
                    && !(*assertion).Credential.pbId.is_null()
                    && std::slice::from_raw_parts(
                        (*assertion).Credential.pbId,
                        (*assertion).Credential.cbId as usize,
                    ) == credential_id
            };
        if !assertion.is_null() {
            unsafe {
                WebAuthNFreeAssertion(assertion);
            }
        }
        if valid {
            Ok(())
        } else {
            Err(RpcFailure::new(
                "hello-native-error",
                "Windows Hello 验证返回了无效断言。",
                true,
            ))
        }
    }

    pub fn revoke(credential_id: &[u8]) -> Result<(), RpcFailure> {
        let hr = unsafe {
            WebAuthNDeletePlatformCredential(credential_id.len() as u32, credential_id.as_ptr())
        };
        if hr < 0 {
            return Err(error_for(hr, "撤销"));
        }
        Ok(())
    }
}

#[cfg(windows)]
fn platform_authenticator_available() -> Result<bool, RpcFailure> {
    windows_platform::available()
}
#[cfg(windows)]
fn platform_enroll(binding_id: &str, display_name: &str) -> Result<Vec<u8>, RpcFailure> {
    windows_platform::enroll(binding_id, display_name)
}
#[cfg(windows)]
fn platform_verify(
    binding_id: &str,
    challenge: &[u8],
    credential_id: &[u8],
) -> Result<(), RpcFailure> {
    windows_platform::verify(binding_id, challenge, credential_id)
}
#[cfg(windows)]
fn platform_revoke(credential_id: &[u8]) -> Result<(), RpcFailure> {
    windows_platform::revoke(credential_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_unknown_and_malformed_parameters_before_platform_calls() {
        let store = WindowsHelloStore::new(tempdir().unwrap().path());
        let error = store
            .verify(json!({ "bindingId": "bad", "challengeBase64Url": "bad" }))
            .unwrap_err();
        assert_eq!(error.code, "params-invalid");
        let error = store
            .revoke(json!({ "bindingId": Uuid::new_v4().to_string(), "confirmed": false }))
            .unwrap_err();
        assert_eq!(error.code, "confirmation-required");
        let error = store
            .enroll(json!({
                "bindingId": Uuid::new_v4().to_string(),
                "confirmed": false
            }))
            .unwrap_err();
        assert_eq!(error.code, "confirmation-required");
    }

    #[test]
    fn status_is_bounded_and_does_not_expose_credential_material() {
        let directory = tempdir().unwrap();
        fs::create_dir_all(directory.path().join("hello")).unwrap();
        let result = WindowsHelloStore::new(directory.path())
            .status(json!({}))
            .unwrap();
        assert_eq!(result["version"], HELLO_PROTOCOL_VERSION);
        assert!(result.get("credentialId").is_none());
        assert!(result.get("privateKey").is_none());
    }

    #[test]
    fn status_reports_a_damaged_binding_and_missing_revoke_is_idempotent() {
        let directory = tempdir().unwrap();
        let binding_id = Uuid::new_v4().to_string();
        let path = directory
            .path()
            .join("hello")
            .join(format!("{binding_id}.json"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, br#"{"version":1,"bindingId":"wrong","rpId":"monica-extension.local","credentialId":"AA","createdAtUnixSecs":1}"#).unwrap();
        let store = WindowsHelloStore::new(directory.path());
        let status = store.status(json!({ "bindingId": binding_id })).unwrap();
        assert_eq!(status["enrolled"], false);
        assert_eq!(status["reason"], "binding-record-invalid");
        fs::remove_file(&path).unwrap();
        let revoked = store
            .revoke(json!({ "bindingId": binding_id, "confirmed": true }))
            .unwrap();
        assert_eq!(revoked["revoked"], true);
    }

    #[test]
    fn replacing_a_binding_record_keeps_the_new_record() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("hello").join("binding.json");
        let first = HelloCredentialRecord {
            version: HELLO_PROTOCOL_VERSION,
            binding_id: Uuid::new_v4().to_string(),
            rp_id: HELLO_RP_ID.to_string(),
            credential_id: URL_SAFE_NO_PAD.encode([1u8; 32]),
            created_at_unix_secs: 1,
            last_verified_at_unix_secs: None,
        };
        let second = HelloCredentialRecord {
            last_verified_at_unix_secs: Some(2),
            ..first.clone()
        };
        write_record(&path, &first).unwrap();
        write_record(&path, &second).unwrap();
        let loaded = read_record(&path).unwrap().unwrap();
        assert_eq!(loaded.last_verified_at_unix_secs, Some(2));
    }
}
