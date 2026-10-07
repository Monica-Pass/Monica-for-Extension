use std::collections::HashMap;

use mdbx_crypto::aead;
use mdbx_crypto::kdf::{self, Argon2Params};
use mdbx_crypto::keyring::Keyring;
use uuid::Uuid;
use zeroize::Zeroizing;

use mdbx_core::model::{KdfParams, UnlockMethod, UnlockMethodType, VaultSession};
use mdbx_core::tiga::{TigaMode, TigaOperation, TigaScope};

use crate::connection::VaultConnection;
use crate::error::{StorageError, StorageResult};
use crate::init::INIT_KEY_EPOCH_PROFILE_ID;
use crate::key_epoch::{random_epoch_wrap_aad, RANDOM_KEY_EPOCH_PROFILE_ID};
use crate::tiga::TigaService;
use crate::tiga_policy::TigaAuthorizationContext;

/// AEAD 包装 vault 密钥时使用的 AAD。
const VAULT_KEY_WRAP_AAD: &[u8] = b"mdbx-vault-key-wrap";
const ACTIVE_KEY_EPOCH_AAD: &[u8] = b"mdbx-active-key-epoch-wrap";
const ACTIVE_KEY_EPOCH_PROFILE_ID: &str = "mdbx-active-key-epoch-v1";

/// 保管库解锁服务。
///
/// 支持三种用户可见的解锁方式：PIN、密码、安全密钥。
///
/// 密钥层级：
/// ```text
/// 用户凭据 ──[Argon2id]──► unlock_key ──[AEAD 解包]──► vault_key
///                                                          │
///                                ┌─────────────────────────┤
///                                ▼               ▼         ▼
///                           记录子密钥      附件子密钥   元数据子密钥
/// ```
///
/// - **setup**: 生成随机 vault_key → 用派生密钥 AEAD 包裹 → 存储 wrapped_vault_key_ct
/// - **unlock**: 派生密钥 → AEAD 解包 vault_key → 构建 Keyring → 附加到连接
/// - **change**: 验证旧凭据 → 解包 vault_key → 用新凭据重新包裹
pub struct UnlockService;

/// 当前 vault 解锁方式相对某个 Tiga 模式的策略评估。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TigaUnlockAssessment {
    pub mode: TigaMode,
    pub configured_methods: Vec<UnlockMethodType>,
    pub has_portable_unlock: bool,
    pub has_security_key_unlock: bool,
    pub has_combined_password_security_key: bool,
    pub has_required_combined_strength: bool,
    pub satisfies_policy: bool,
    pub warnings: Vec<String>,
}

impl UnlockService {
    // -----------------------------------------------------------------------
    // SETUP — 配置解锁方式
    // -----------------------------------------------------------------------

    /// 配置 PIN 解锁方式。
    ///
    /// PIN 至少需要 4 位数字。PIN 派生的密钥用于包装 vault 密钥材料。
    pub fn setup_pin(conn: &mut VaultConnection, pin: &str) -> StorageResult<UnlockMethod> {
        Self::ensure_bootstrap_available(conn)?;
        Self::setup_pin_raw(conn, pin)
    }

    fn setup_pin_raw(conn: &mut VaultConnection, pin: &str) -> StorageResult<UnlockMethod> {
        Self::validate_pin(pin)?;

        let normalized = pin.trim();
        let mut kdf_params = KdfParams::for_pin();
        kdf_params.salt = kdf::generate_salt(16).map_err(|e| {
            StorageError::Crypto(mdbx_crypto::error::CryptoError::RngError(e.to_string()))
        })?;
        let unlock_key = Self::derive_key(normalized.as_bytes(), &kdf_params)?;

        let vault_key = Self::get_or_generate_vault_key(conn)?;
        let wrapped = Self::wrap_vault_key(unlock_key.as_slice(), vault_key.as_slice())?;
        let active_epoch_wrapped = Self::wrap_active_key_epoch(vault_key.as_slice())?;

        Self::attach_verified_keyring(conn, vault_key.as_slice())?;

        let method = Self::store_method(
            conn,
            UnlockMethodType::Pin,
            &kdf_params,
            &wrapped,
            &active_epoch_wrapped,
        )?;
        Self::create_and_attach_session(conn, UnlockMethodType::Pin)?;
        Self::refresh_tiga_compliance(conn)?;
        Ok(method)
    }

    /// 配置密码解锁方式（默认 Multi 模式）。
    ///
    /// 密码在进入 KDF 前进行 Unicode NFC 规范化，确保跨平台一致性。
    pub fn setup_password(
        conn: &mut VaultConnection,
        password: &str,
    ) -> StorageResult<UnlockMethod> {
        Self::setup_password_with_mode(conn, password, TigaMode::Multi)
    }

    /// 配置密码解锁方式，指定 Tiga 安全等级。
    ///
    /// Power → 最高防护 (256 MiB, 10 iterations)
    /// Multi → 平衡默认  (64 MiB, 3 iterations)
    /// Sky   → 快速轻便  (8 MiB, 1 iterations)
    pub fn setup_password_with_mode(
        conn: &mut VaultConnection,
        password: &str,
        mode: TigaMode,
    ) -> StorageResult<UnlockMethod> {
        Self::ensure_bootstrap_available(conn)?;
        Self::setup_password_with_mode_raw(conn, password, mode)
    }

    fn setup_password_with_mode_raw(
        conn: &mut VaultConnection,
        password: &str,
        mode: TigaMode,
    ) -> StorageResult<UnlockMethod> {
        Self::validate_password(password)?;

        let normalized = Self::normalize_unicode(password);
        let mut kdf_params = KdfParams::for_password_with_mode(mode);
        kdf_params.salt = kdf::generate_salt(16).map_err(|e| {
            StorageError::Crypto(mdbx_crypto::error::CryptoError::RngError(e.to_string()))
        })?;
        let unlock_key = Self::derive_key(normalized.as_bytes(), &kdf_params)?;

        let vault_key = Self::get_or_generate_vault_key(conn)?;
        let wrapped = Self::wrap_vault_key(unlock_key.as_slice(), vault_key.as_slice())?;
        let active_epoch_wrapped = Self::wrap_active_key_epoch(vault_key.as_slice())?;

        Self::attach_verified_keyring(conn, vault_key.as_slice())?;

        let method = Self::store_method(
            conn,
            UnlockMethodType::Password,
            &kdf_params,
            &wrapped,
            &active_epoch_wrapped,
        )?;
        Self::create_and_attach_session(conn, UnlockMethodType::Password)?;
        Self::refresh_tiga_compliance(conn)?;
        Ok(method)
    }

    /// 配置安全密钥解锁方式。
    pub fn setup_security_key(
        conn: &mut VaultConnection,
        key_data: &[u8],
    ) -> StorageResult<UnlockMethod> {
        Self::ensure_bootstrap_available(conn)?;
        Self::setup_security_key_raw(conn, key_data)
    }

    fn setup_security_key_raw(
        conn: &mut VaultConnection,
        key_data: &[u8],
    ) -> StorageResult<UnlockMethod> {
        if key_data.is_empty() {
            return Err(StorageError::Validation(
                "security key data must not be empty".to_string(),
            ));
        }

        let mut kdf_params = KdfParams::for_security_key();
        kdf_params.salt = kdf::generate_salt(16).map_err(|e| {
            StorageError::Crypto(mdbx_crypto::error::CryptoError::RngError(e.to_string()))
        })?;
        let unlock_key = Self::derive_key(key_data, &kdf_params)?;

        let vault_key = Self::get_or_generate_vault_key(conn)?;
        let wrapped = Self::wrap_vault_key(unlock_key.as_slice(), vault_key.as_slice())?;
        let active_epoch_wrapped = Self::wrap_active_key_epoch(vault_key.as_slice())?;

        Self::attach_verified_keyring(conn, vault_key.as_slice())?;

        let method = Self::store_method(
            conn,
            UnlockMethodType::SecurityKey,
            &kdf_params,
            &wrapped,
            &active_epoch_wrapped,
        )?;
        Self::create_and_attach_session(conn, UnlockMethodType::SecurityKey)?;
        Self::refresh_tiga_compliance(conn)?;
        Ok(method)
    }

    /// 配置密码 + 安全密钥组合解锁方式。
    ///
    /// 该方式要求两个材料同时存在才能解包 vault key，适合作为 Power 模式
    /// 的推荐入口。它不会移除已有便携方式，客户端可通过策略评估引导用户
    /// 是否保留恢复路径。
    pub fn setup_password_security_key(
        conn: &mut VaultConnection,
        password: &str,
        key_data: &[u8],
        mode: TigaMode,
    ) -> StorageResult<UnlockMethod> {
        Self::ensure_bootstrap_available(conn)?;
        Self::setup_password_security_key_raw(conn, password, key_data, mode)
    }

    fn setup_password_security_key_raw(
        conn: &mut VaultConnection,
        password: &str,
        key_data: &[u8],
        mode: TigaMode,
    ) -> StorageResult<UnlockMethod> {
        Self::validate_password(password)?;
        Self::validate_security_key_data(key_data)?;

        let normalized = Self::normalize_unicode(password);
        let combined = Zeroizing::new(Self::combine_password_and_security_key(
            normalized.as_bytes(),
            key_data,
        ));
        let mut kdf_params = KdfParams::for_password_with_mode(mode);
        kdf_params.salt = kdf::generate_salt(16).map_err(|e| {
            StorageError::Crypto(mdbx_crypto::error::CryptoError::RngError(e.to_string()))
        })?;
        let unlock_key = Self::derive_key(combined.as_slice(), &kdf_params)?;

        let vault_key = Self::get_or_generate_vault_key(conn)?;
        let wrapped = Self::wrap_vault_key(unlock_key.as_slice(), vault_key.as_slice())?;
        let active_epoch_wrapped = Self::wrap_active_key_epoch(vault_key.as_slice())?;

        Self::attach_verified_keyring(conn, vault_key.as_slice())?;

        let method = Self::store_method(
            conn,
            UnlockMethodType::PasswordSecurityKey,
            &kdf_params,
            &wrapped,
            &active_epoch_wrapped,
        )?;
        Self::create_and_attach_session(conn, UnlockMethodType::PasswordSecurityKey)?;
        Self::refresh_tiga_compliance(conn)?;
        Ok(method)
    }

    pub fn setup_pin_authorized(
        conn: &mut VaultConnection,
        pin: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<UnlockMethod> {
        TigaService::execute_authorized_mut(
            conn,
            &TigaScope::Vault,
            TigaOperation::ChangeUnlockMethods,
            context,
            |conn| Self::setup_pin_raw(conn, pin),
        )
        .map(|(method, _)| method)
    }

    pub fn setup_password_authorized(
        conn: &mut VaultConnection,
        password: &str,
        mode: TigaMode,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<UnlockMethod> {
        TigaService::execute_authorized_mut(
            conn,
            &TigaScope::Vault,
            TigaOperation::ChangeUnlockMethods,
            context,
            |conn| Self::setup_password_with_mode_raw(conn, password, mode),
        )
        .map(|(method, _)| method)
    }

    pub fn setup_security_key_authorized(
        conn: &mut VaultConnection,
        key_data: &[u8],
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<UnlockMethod> {
        TigaService::execute_authorized_mut(
            conn,
            &TigaScope::Vault,
            TigaOperation::ChangeUnlockMethods,
            context,
            |conn| Self::setup_security_key_raw(conn, key_data),
        )
        .map(|(method, _)| method)
    }

    pub fn setup_password_security_key_authorized(
        conn: &mut VaultConnection,
        password: &str,
        key_data: &[u8],
        mode: TigaMode,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<UnlockMethod> {
        TigaService::execute_authorized_mut(
            conn,
            &TigaScope::Vault,
            TigaOperation::ChangeUnlockMethods,
            context,
            |conn| Self::setup_password_security_key_raw(conn, password, key_data, mode),
        )
        .map(|(method, _)| method)
    }

    // -----------------------------------------------------------------------
    // UNLOCK — 解锁
    // -----------------------------------------------------------------------

    /// 使用 PIN 解锁 vault。
    pub fn unlock_with_pin(conn: &mut VaultConnection, pin: &str) -> StorageResult<VaultSession> {
        let method = Self::find_method_by_type(conn, UnlockMethodType::Pin)?.ok_or_else(|| {
            StorageError::Validation("no PIN unlock method configured".to_string())
        })?;

        let normalized = pin.trim();
        let kdf_params = KdfParams::from_json_bytes(&method.kdf_params_ct)
            .map_err(|e| StorageError::SchemaCreation(format!("invalid KDF params: {}", e)))?;
        let unlock_key = Self::derive_key(normalized.as_bytes(), &kdf_params)?;

        let vault_key =
            Self::unwrap_vault_key(unlock_key.as_slice(), &method.wrapped_vault_key_ct)?;

        Self::attach_verified_keyring(conn, vault_key.as_slice())?;

        Self::create_and_attach_session(conn, UnlockMethodType::Pin)
    }

    /// 使用密码解锁 vault。
    pub fn unlock_with_password(
        conn: &mut VaultConnection,
        password: &str,
    ) -> StorageResult<VaultSession> {
        let method =
            Self::find_method_by_type(conn, UnlockMethodType::Password)?.ok_or_else(|| {
                StorageError::Validation("no password unlock method configured".to_string())
            })?;

        let normalized = Self::normalize_unicode(password);
        let kdf_params = KdfParams::from_json_bytes(&method.kdf_params_ct)
            .map_err(|e| StorageError::SchemaCreation(format!("invalid KDF params: {}", e)))?;
        let unlock_key = Self::derive_key(normalized.as_bytes(), &kdf_params)?;

        let vault_key =
            Self::unwrap_vault_key(unlock_key.as_slice(), &method.wrapped_vault_key_ct)?;

        Self::attach_verified_keyring(conn, vault_key.as_slice())?;

        Self::create_and_attach_session(conn, UnlockMethodType::Password)
    }

    /// 使用安全密钥解锁 vault。
    pub fn unlock_with_security_key(
        conn: &mut VaultConnection,
        key_data: &[u8],
    ) -> StorageResult<VaultSession> {
        let method =
            Self::find_method_by_type(conn, UnlockMethodType::SecurityKey)?.ok_or_else(|| {
                StorageError::Validation("no security key unlock method configured".to_string())
            })?;

        let kdf_params = KdfParams::from_json_bytes(&method.kdf_params_ct)
            .map_err(|e| StorageError::SchemaCreation(format!("invalid KDF params: {}", e)))?;
        let unlock_key = Self::derive_key(key_data, &kdf_params)?;

        let vault_key =
            Self::unwrap_vault_key(unlock_key.as_slice(), &method.wrapped_vault_key_ct)?;

        Self::attach_verified_keyring(conn, vault_key.as_slice())?;

        Self::create_and_attach_session(conn, UnlockMethodType::SecurityKey)
    }

    /// 使用密码 + 安全密钥组合方式解锁 vault。
    pub fn unlock_with_password_security_key(
        conn: &mut VaultConnection,
        password: &str,
        key_data: &[u8],
    ) -> StorageResult<VaultSession> {
        let method = Self::find_method_by_type(conn, UnlockMethodType::PasswordSecurityKey)?
            .ok_or_else(|| {
                StorageError::Validation(
                    "no password + security key unlock method configured".to_string(),
                )
            })?;

        Self::validate_security_key_data(key_data)?;
        let normalized = Self::normalize_unicode(password);
        let combined = Zeroizing::new(Self::combine_password_and_security_key(
            normalized.as_bytes(),
            key_data,
        ));
        let kdf_params = KdfParams::from_json_bytes(&method.kdf_params_ct)
            .map_err(|e| StorageError::SchemaCreation(format!("invalid KDF params: {}", e)))?;
        let unlock_key = Self::derive_key(combined.as_slice(), &kdf_params)?;

        let vault_key =
            Self::unwrap_vault_key(unlock_key.as_slice(), &method.wrapped_vault_key_ct)?;

        Self::attach_verified_keyring(conn, vault_key.as_slice())?;

        Self::create_and_attach_session(conn, UnlockMethodType::PasswordSecurityKey)
    }

    // -----------------------------------------------------------------------
    // CHANGE — 修改凭据
    // -----------------------------------------------------------------------

    /// 修改 PIN。
    ///
    /// 用旧 PIN 解包 vault_key，再用新 PIN 重新包裹。
    pub(crate) fn change_pin(
        conn: &mut VaultConnection,
        old_pin: &str,
        new_pin: &str,
    ) -> StorageResult<()> {
        // 用旧凭据解包 vault_key
        let method = Self::find_method_by_type(conn, UnlockMethodType::Pin)?
            .ok_or_else(|| StorageError::Validation("no PIN configured".to_string()))?;

        let old_normalized = old_pin.trim();
        let old_kdf_params = KdfParams::from_json_bytes(&method.kdf_params_ct)
            .map_err(|e| StorageError::SchemaCreation(format!("invalid KDF params: {}", e)))?;
        let old_unlock_key = Self::derive_key(old_normalized.as_bytes(), &old_kdf_params)?;
        let vault_key =
            Self::unwrap_vault_key(old_unlock_key.as_slice(), &method.wrapped_vault_key_ct)?;

        // 用新凭据重新包裹
        Self::validate_pin(new_pin)?;
        let new_normalized = new_pin.trim();
        let mut new_kdf_params = KdfParams::for_pin();
        new_kdf_params.salt = kdf::generate_salt(16).map_err(|e| {
            StorageError::Crypto(mdbx_crypto::error::CryptoError::RngError(e.to_string()))
        })?;
        let new_unlock_key = Self::derive_key(new_normalized.as_bytes(), &new_kdf_params)?;
        let new_wrapped = Self::wrap_vault_key(new_unlock_key.as_slice(), vault_key.as_slice())?;
        let active_epoch_wrapped = Self::wrap_active_key_epoch(vault_key.as_slice())?;

        // 更新密钥环（vault_key 不变，但派生密钥变了）
        Self::attach_verified_keyring(conn, vault_key.as_slice())?;

        Self::update_method_key(
            conn,
            UnlockMethodType::Pin,
            &new_kdf_params,
            &new_wrapped,
            &active_epoch_wrapped,
        )?;
        Self::refresh_tiga_compliance(conn)
    }

    pub fn change_pin_authorized(
        conn: &mut VaultConnection,
        old_pin: &str,
        new_pin: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<()> {
        TigaService::execute_authorized_mut(
            conn,
            &TigaScope::Vault,
            TigaOperation::ChangeUnlockMethods,
            context,
            |conn| Self::change_pin(conn, old_pin, new_pin),
        )
        .map(|_| ())
    }

    /// 修改密码（保持原有 Tiga 安全等级）。
    ///
    /// 用旧密码解包 vault_key，再用新密码重新包裹。
    pub(crate) fn change_password(
        conn: &mut VaultConnection,
        old_password: &str,
        new_password: &str,
    ) -> StorageResult<()> {
        let method = Self::find_method_by_type(conn, UnlockMethodType::Password)?
            .ok_or_else(|| StorageError::Validation("no password configured".to_string()))?;

        let old_normalized = Self::normalize_unicode(old_password);
        let old_kdf_params = KdfParams::from_json_bytes(&method.kdf_params_ct)
            .map_err(|e| StorageError::SchemaCreation(format!("invalid KDF params: {}", e)))?;
        let old_unlock_key = Self::derive_key(old_normalized.as_bytes(), &old_kdf_params)?;
        let vault_key =
            Self::unwrap_vault_key(old_unlock_key.as_slice(), &method.wrapped_vault_key_ct)?;

        let mode = old_kdf_params.infer_tiga_mode();
        Self::validate_password(new_password)?;
        let new_normalized = Self::normalize_unicode(new_password);
        let mut new_kdf_params = KdfParams::for_password_with_mode(mode);
        new_kdf_params.salt = kdf::generate_salt(16).map_err(|e| {
            StorageError::Crypto(mdbx_crypto::error::CryptoError::RngError(e.to_string()))
        })?;
        let new_unlock_key = Self::derive_key(new_normalized.as_bytes(), &new_kdf_params)?;
        let new_wrapped = Self::wrap_vault_key(new_unlock_key.as_slice(), vault_key.as_slice())?;
        let active_epoch_wrapped = Self::wrap_active_key_epoch(vault_key.as_slice())?;

        Self::attach_verified_keyring(conn, vault_key.as_slice())?;

        Self::update_method_key(
            conn,
            UnlockMethodType::Password,
            &new_kdf_params,
            &new_wrapped,
            &active_epoch_wrapped,
        )?;
        Self::refresh_tiga_compliance(conn)
    }

    pub fn change_password_authorized(
        conn: &mut VaultConnection,
        old_password: &str,
        new_password: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<()> {
        TigaService::execute_authorized_mut(
            conn,
            &TigaScope::Vault,
            TigaOperation::ChangeUnlockMethods,
            context,
            |conn| Self::change_password(conn, old_password, new_password),
        )
        .map(|_| ())
    }

    /// 重设密码。
    ///
    /// 仅允许在已经解锁的连接上调用。该路径不需要旧密码明文，而是复用当前
    /// keyring 中的 vault_key，用新密码重新包裹同一个 vault key。
    pub(crate) fn reset_password_with_mode(
        conn: &mut VaultConnection,
        new_password: &str,
        mode: TigaMode,
    ) -> StorageResult<()> {
        Self::find_method_by_type(conn, UnlockMethodType::Password)?
            .ok_or_else(|| StorageError::Validation("no password configured".to_string()))?;

        let vault_key = conn
            .keyring()
            .map(|keyring| keyring.vault_key.clone())
            .ok_or_else(|| {
                StorageError::Validation(
                    "vault must be unlocked before resetting password".to_string(),
                )
            })?;

        Self::validate_password(new_password)?;
        let normalized = Self::normalize_unicode(new_password);
        let mut new_kdf_params = KdfParams::for_password_with_mode(mode);
        new_kdf_params.salt = kdf::generate_salt(16).map_err(|e| {
            StorageError::Crypto(mdbx_crypto::error::CryptoError::RngError(e.to_string()))
        })?;
        let new_unlock_key = Self::derive_key(normalized.as_bytes(), &new_kdf_params)?;
        let new_wrapped = Self::wrap_vault_key(new_unlock_key.as_slice(), &vault_key)?;
        let active_epoch_wrapped = Self::wrap_active_key_epoch(&vault_key)?;

        Self::update_method_key(
            conn,
            UnlockMethodType::Password,
            &new_kdf_params,
            &new_wrapped,
            &active_epoch_wrapped,
        )?;

        Self::attach_verified_keyring(conn, &vault_key)?;
        Self::refresh_tiga_compliance(conn)
    }

    pub fn reset_password_authorized(
        conn: &mut VaultConnection,
        new_password: &str,
        mode: TigaMode,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<()> {
        TigaService::execute_authorized_mut(
            conn,
            &TigaScope::Vault,
            TigaOperation::ChangeUnlockMethods,
            context,
            |conn| Self::reset_password_with_mode(conn, new_password, mode),
        )
        .map(|_| ())
    }

    // -----------------------------------------------------------------------
    // LIST — 查询
    // -----------------------------------------------------------------------

    /// 列出所有已配置的解锁方式。
    pub fn list_methods(conn: &VaultConnection) -> StorageResult<Vec<UnlockMethod>> {
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT method_id, method_type, kdf_profile_id, kdf_params_ct,
                        wrapped_vault_key_ct, created_at, updated_at
                 FROM unlock_methods
                 ORDER BY created_at",
            )
            .map_err(StorageError::Database)?;

        let methods = stmt
            .query_map([], |row| {
                Ok(UnlockMethod {
                    method_id: row.get(0)?,
                    method_type: {
                        let s: String = row.get(1)?;
                        UnlockMethodType::parse(&s).unwrap()
                    },
                    kdf_profile_id: row.get(2)?,
                    kdf_params_ct: row.get(3)?,
                    wrapped_vault_key_ct: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            })
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        Ok(methods)
    }

    /// 检查是否已配置指定类型的解锁方式。
    pub fn has_method_of_type(
        conn: &VaultConnection,
        method_type: UnlockMethodType,
    ) -> StorageResult<bool> {
        Self::find_method_by_type(conn, method_type).map(|m| m.is_some())
    }

    /// 评估当前已配置解锁方式是否符合指定 Tiga 模式的 vault 解锁策略。
    pub fn assess_tiga_unlock_policy(
        conn: &VaultConnection,
        mode: TigaMode,
    ) -> StorageResult<TigaUnlockAssessment> {
        let methods = Self::list_methods(conn)?;
        let configured_methods: Vec<UnlockMethodType> =
            methods.iter().map(|m| m.method_type).collect();
        let has_portable_unlock = configured_methods.iter().any(|m| m.is_portable());
        let has_security_key_unlock = configured_methods.iter().any(|m| m.uses_security_key());
        let has_combined_password_security_key = configured_methods
            .iter()
            .any(|m| m.is_combined_password_security_key());
        let has_required_combined_strength = methods.iter().any(|m| {
            m.method_type.is_combined_password_security_key()
                && KdfParams::from_json_bytes(&m.kdf_params_ct)
                    .map(|params| params.infer_tiga_mode() >= mode)
                    .unwrap_or(false)
        });
        let policy = mode.unlock_policy();

        let mut warnings = Vec::new();
        if !methods.is_empty() && !has_portable_unlock && mode != TigaMode::Power {
            warnings.push(
                "cloud-synced vault has no portable unlock method; another device will need security-key material".to_string(),
            );
        }
        if policy.recommends_security_key && !has_security_key_unlock {
            warnings.push(format!(
                "{mode} mode recommends adding a security key unlock path"
            ));
        }
        if policy.requires_combined_password_security_key && !has_combined_password_security_key {
            warnings.push(
                "power mode requires a password + security key combined unlock method".to_string(),
            );
        }
        if policy.requires_combined_password_security_key
            && has_combined_password_security_key
            && !has_required_combined_strength
        {
            warnings.push(
                "password + security key unlock method uses a weaker KDF profile than power mode"
                    .to_string(),
            );
        }
        if !policy.allows_portable_unlock && has_portable_unlock {
            warnings.push(
                "power mode is strongest after removing standalone portable unlock methods"
                    .to_string(),
            );
        }

        let satisfies_policy = if methods.is_empty() {
            false
        } else if policy.requires_combined_password_security_key {
            has_required_combined_strength && !has_portable_unlock
        } else {
            has_portable_unlock
        };

        Ok(TigaUnlockAssessment {
            mode,
            configured_methods,
            has_portable_unlock,
            has_security_key_unlock,
            has_combined_password_security_key,
            has_required_combined_strength,
            satisfies_policy,
            warnings,
        })
    }

    fn refresh_tiga_compliance(conn: &VaultConnection) -> StorageResult<()> {
        let mode = TigaService::get_global_default(conn)?;
        let assessment = Self::assess_tiga_unlock_policy(conn, mode)?;
        let current: String =
            conn.inner()
                .query_row("SELECT tiga_compliance_status FROM vault_meta", [], |row| {
                    row.get(0)
                })?;
        let status = if assessment.satisfies_policy {
            if current == "exception" {
                "exception"
            } else {
                "compliant"
            }
        } else {
            "remediation-required"
        };
        conn.inner().execute(
            "UPDATE vault_meta SET tiga_compliance_status = ?1, updated_at = ?2",
            rusqlite::params![status, chrono::Utc::now().to_rfc3339()],
        )?;
        crate::vault_header_integrity::refresh_after_mutation(conn)
    }

    /// 删除指定类型的解锁方式。
    ///
    /// 至少需要保留一种解锁方式。
    pub(crate) fn remove_method(conn: &VaultConnection, method_id: &str) -> StorageResult<()> {
        let methods = Self::list_methods(conn)?;
        if methods.len() <= 1 {
            return Err(StorageError::Validation(
                "cannot remove the last unlock method".to_string(),
            ));
        }

        let affected = conn
            .inner()
            .execute(
                "DELETE FROM unlock_methods WHERE method_id = ?1",
                rusqlite::params![method_id],
            )
            .map_err(StorageError::Database)?;

        if affected == 0 {
            return Err(StorageError::NotFound(method_id.to_string()));
        }
        Self::refresh_tiga_compliance(conn)
    }

    pub fn remove_method_authorized(
        conn: &mut VaultConnection,
        method_id: &str,
        context: TigaAuthorizationContext<'_>,
    ) -> StorageResult<()> {
        TigaService::execute_authorized_mut(
            conn,
            &TigaScope::Vault,
            TigaOperation::ChangeUnlockMethods,
            context,
            |conn| Self::remove_method(conn, method_id),
        )
        .map(|_| ())
    }

    /// Validate that vault_meta.active_key_epoch_id points at exactly one active
    /// key epoch and that its material is either the initialization marker or a
    /// real active epoch wrapping written by unlock setup/change.
    pub fn validate_active_key_epoch(conn: &VaultConnection) -> StorageResult<()> {
        let vault_key = conn.keyring().map(|keyring| keyring.vault_key.as_slice());
        Self::validate_active_key_epoch_with_vault_key(conn, vault_key).map(|_| ())
    }

    fn validate_active_key_epoch_with_vault_key(
        conn: &VaultConnection,
        vault_key: Option<&[u8]>,
    ) -> StorageResult<String> {
        let active_key_epoch_id: String = conn
            .inner()
            .query_row(
                "SELECT active_key_epoch_id FROM vault_meta LIMIT 1",
                [],
                |row| row.get(0),
            )
            .map_err(StorageError::Database)?;

        let active_count: i64 = conn
            .inner()
            .query_row(
                "SELECT COUNT(*) FROM key_epochs WHERE status = 'active'",
                [],
                |row| row.get(0),
            )
            .map_err(StorageError::Database)?;
        if active_count != 1 {
            return Err(StorageError::Validation(format!(
                "expected exactly one active key epoch, found {}",
                active_count
            )));
        }

        let (status, wrapped_epoch_key_ct, kdf_profile_id, activated_at): (
            String,
            Vec<u8>,
            String,
            Option<String>,
        ) = conn
            .inner()
            .query_row(
                "SELECT status, wrapped_epoch_key_ct, kdf_profile_id, activated_at
                 FROM key_epochs WHERE key_epoch_id = ?1",
                rusqlite::params![active_key_epoch_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(StorageError::Database)?;

        if status != "active" {
            return Err(StorageError::Validation(format!(
                "active_key_epoch_id points at {} epoch",
                status
            )));
        }
        if activated_at.is_none() {
            return Err(StorageError::Validation(
                "active key epoch is missing activated_at".to_string(),
            ));
        }

        match kdf_profile_id.as_str() {
            INIT_KEY_EPOCH_PROFILE_ID => {
                if wrapped_epoch_key_ct.len() != 32 || wrapped_epoch_key_ct == vec![0; 32] {
                    return Err(StorageError::Validation(
                        "initial key epoch marker must be a nonzero 32-byte random marker"
                            .to_string(),
                    ));
                }
            }
            ACTIVE_KEY_EPOCH_PROFILE_ID => {
                if wrapped_epoch_key_ct.len() < 72 {
                    return Err(StorageError::Validation(
                        "active key epoch wrapping is too short".to_string(),
                    ));
                }
                if let Some(vault_key) = vault_key {
                    let unwrapped = Zeroizing::new(
                        aead::decrypt(vault_key, &wrapped_epoch_key_ct, ACTIVE_KEY_EPOCH_AAD)
                            .map_err(|_| {
                                StorageError::Validation(
                                    "active key epoch wrapper authentication failed".to_string(),
                                )
                            })?,
                    );
                    if unwrapped.as_slice() != vault_key {
                        return Err(StorageError::Validation(
                            "active key epoch wrapper does not match the unlocked vault key"
                                .to_string(),
                        ));
                    }
                }
            }
            RANDOM_KEY_EPOCH_PROFILE_ID => {
                if wrapped_epoch_key_ct.len() < 72 {
                    return Err(StorageError::Validation(
                        "random key epoch wrapping is too short".to_string(),
                    ));
                }
                if let Some(vault_key) = vault_key {
                    let vault_ctx = Self::read_vault_context(conn)?;
                    let epoch_key = Zeroizing::new(
                        aead::decrypt(
                            vault_key,
                            &wrapped_epoch_key_ct,
                            &random_epoch_wrap_aad(&vault_ctx, &active_key_epoch_id),
                        )
                        .map_err(|_| {
                            StorageError::Validation(
                                "random key epoch wrapper authentication failed".to_string(),
                            )
                        })?,
                    );
                    if epoch_key.len() != 32 {
                        return Err(StorageError::Validation(
                            "random key epoch material must be 32 bytes".to_string(),
                        ));
                    }
                }
            }
            other => {
                return Err(StorageError::Validation(format!(
                    "unsupported active key epoch profile: {}",
                    other
                )));
            }
        }

        Ok(active_key_epoch_id)
    }

    // -----------------------------------------------------------------------
    // PRIVATE HELPERS — 密钥操作
    // -----------------------------------------------------------------------

    /// 获取已有的 vault_key，若无则生成新的。
    ///
    /// 首次设置解锁方式时生成新的随机 vault_key。
    /// 后续设置的解锁方式复用同一个 vault_key，
    /// 确保无论用哪种方式解锁都能解密同一批数据。
    fn get_or_generate_vault_key(conn: &VaultConnection) -> StorageResult<Zeroizing<Vec<u8>>> {
        match conn.keyring() {
            Some(kr) => Ok(kr.vault_key.clone()),
            None => aead::generate_key()
                .map(Zeroizing::new)
                .map_err(StorageError::Crypto),
        }
    }

    /// 用 unlock_key 包裹 vault_key。
    fn wrap_vault_key(unlock_key: &[u8], vault_key: &[u8]) -> StorageResult<Vec<u8>> {
        aead::encrypt(unlock_key, vault_key, VAULT_KEY_WRAP_AAD).map_err(StorageError::Crypto)
    }

    fn wrap_active_key_epoch(vault_key: &[u8]) -> StorageResult<Vec<u8>> {
        aead::encrypt(vault_key, vault_key, ACTIVE_KEY_EPOCH_AAD).map_err(StorageError::Crypto)
    }

    fn build_keyring(
        conn: &VaultConnection,
        vault_key: &[u8],
    ) -> StorageResult<(Keyring, String, HashMap<String, Keyring>)> {
        let active_key_epoch_id =
            Self::validate_active_key_epoch_with_vault_key(conn, Some(vault_key))?;
        let vault_ctx = Self::read_vault_context(conn)?;
        let keyring = Keyring::from_vault_key(vault_key, &vault_ctx)?;
        let epoch_keyrings = Self::load_epoch_keyrings(conn, vault_key, &vault_ctx)?;
        Ok((keyring, active_key_epoch_id, epoch_keyrings))
    }

    fn attach_verified_keyring(conn: &mut VaultConnection, vault_key: &[u8]) -> StorageResult<()> {
        let (keyring, active_key_epoch_id, epoch_keyrings) = Self::build_keyring(conn, vault_key)?;
        crate::vault_header_integrity::verify_or_initialize(conn, &keyring)?;
        conn.attach_verified_keyring(keyring, active_key_epoch_id, epoch_keyrings);
        if let Err(error) = crate::integrity_root::verify_if_established(conn) {
            conn.clear_session();
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn refresh_verified_keyring(conn: &mut VaultConnection) -> StorageResult<()> {
        let vault_key = conn
            .keyring()
            .map(|keyring| keyring.vault_key.clone())
            .ok_or_else(|| {
                StorageError::Validation(
                    "vault must be unlocked before refreshing key epochs".to_string(),
                )
            })?;
        Self::attach_verified_keyring(conn, vault_key.as_slice())
    }

    pub(crate) fn verify_key_epoch_state(conn: &VaultConnection) -> StorageResult<()> {
        let vault_key = conn
            .keyring()
            .map(|keyring| keyring.vault_key.clone())
            .ok_or_else(|| {
                StorageError::Validation(
                    "vault must be unlocked before verifying key epochs".to_string(),
                )
            })?;
        Self::build_keyring(conn, vault_key.as_slice()).map(|_| ())
    }

    fn load_epoch_keyrings(
        conn: &VaultConnection,
        vault_key: &[u8],
        vault_ctx: &[u8],
    ) -> StorageResult<HashMap<String, Keyring>> {
        let mut stmt = conn
            .inner()
            .prepare(
                "SELECT key_epoch_id, status, wrapped_epoch_key_ct, kdf_profile_id
                 FROM key_epochs WHERE status IN ('active', 'retired')",
            )
            .map_err(StorageError::Database)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(StorageError::Database)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::Database)?;

        let mut epoch_keyrings = HashMap::new();
        for (key_epoch_id, status, wrapped_epoch_key_ct, profile) in rows {
            let epoch_key = match profile.as_str() {
                INIT_KEY_EPOCH_PROFILE_ID if status == "active" => {
                    Zeroizing::new(vault_key.to_vec())
                }
                ACTIVE_KEY_EPOCH_PROFILE_ID => {
                    let unwrapped = Zeroizing::new(
                        aead::decrypt(vault_key, &wrapped_epoch_key_ct, ACTIVE_KEY_EPOCH_AAD)
                            .map_err(|_| {
                                StorageError::Validation(format!(
                                    "key epoch {} wrapper authentication failed",
                                    key_epoch_id
                                ))
                            })?,
                    );
                    if unwrapped.as_slice() != vault_key {
                        return Err(StorageError::Validation(format!(
                            "key epoch {} does not match the unlocked vault key",
                            key_epoch_id
                        )));
                    }
                    unwrapped
                }
                RANDOM_KEY_EPOCH_PROFILE_ID => {
                    let epoch_key = Zeroizing::new(
                        aead::decrypt(
                            vault_key,
                            &wrapped_epoch_key_ct,
                            &random_epoch_wrap_aad(vault_ctx, &key_epoch_id),
                        )
                        .map_err(|_| {
                            StorageError::Validation(format!(
                                "random key epoch {} wrapper authentication failed",
                                key_epoch_id
                            ))
                        })?,
                    );
                    if epoch_key.len() != 32 {
                        return Err(StorageError::Validation(format!(
                            "random key epoch {} material must be 32 bytes",
                            key_epoch_id
                        )));
                    }
                    epoch_key
                }
                INIT_KEY_EPOCH_PROFILE_ID => {
                    return Err(StorageError::Validation(format!(
                        "initial marker profile is invalid for {} key epoch {}",
                        status, key_epoch_id
                    )));
                }
                other => {
                    return Err(StorageError::Validation(format!(
                        "unsupported key epoch profile {} for {}",
                        other, key_epoch_id
                    )));
                }
            };
            epoch_keyrings.insert(
                key_epoch_id,
                Keyring::from_vault_key(&epoch_key, vault_ctx)?,
            );
        }
        Ok(epoch_keyrings)
    }

    /// 用 unlock_key 解包得到 vault_key。
    fn unwrap_vault_key(unlock_key: &[u8], wrapped: &[u8]) -> StorageResult<Zeroizing<Vec<u8>>> {
        aead::decrypt(unlock_key, wrapped, VAULT_KEY_WRAP_AAD)
            .map(Zeroizing::new)
            .map_err(|e| match e {
                mdbx_crypto::error::CryptoError::AuthenticationFailed => {
                    StorageError::Validation("incorrect credential".to_string())
                }
                other => StorageError::Crypto(other),
            })
    }

    /// 从 vault_meta 读取 vault_id 作为 Keyring 的派生上下文。
    fn read_vault_context(conn: &VaultConnection) -> StorageResult<Vec<u8>> {
        let vault_id: String = conn
            .inner()
            .query_row("SELECT vault_id FROM vault_meta LIMIT 1", [], |row| {
                row.get(0)
            })
            .map_err(StorageError::Database)?;
        Ok(vault_id.into_bytes())
    }

    /// 从凭据和 KDF 参数派生密钥（使用 Argon2id）。
    fn derive_key(credential: &[u8], kdf_params: &KdfParams) -> StorageResult<Zeroizing<Vec<u8>>> {
        let argon2_params = Argon2Params {
            memory_kib: kdf_params.mem_limit_kib,
            iterations: kdf_params.ops_limit,
            parallelism: kdf_params.parallelism,
            output_len: kdf_params.output_len as usize,
        };
        kdf::derive_key(credential, &kdf_params.salt, &argon2_params).map_err(StorageError::Crypto)
    }

    fn combine_password_and_security_key(password: &[u8], key_data: &[u8]) -> Vec<u8> {
        let mut combined = Vec::with_capacity(16 + password.len() + key_data.len());
        combined.extend_from_slice(&(password.len() as u64).to_le_bytes());
        combined.extend_from_slice(password);
        combined.extend_from_slice(&(key_data.len() as u64).to_le_bytes());
        combined.extend_from_slice(key_data);
        combined
    }

    // -----------------------------------------------------------------------
    // PRIVATE HELPERS — 存储
    // -----------------------------------------------------------------------

    /// 存储一种解锁方式。
    fn store_method(
        conn: &VaultConnection,
        method_type: UnlockMethodType,
        kdf_params: &KdfParams,
        wrapped_vault_key_ct: &[u8],
        active_epoch_wrapped_ct: &[u8],
    ) -> StorageResult<UnlockMethod> {
        let method_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let kdf_params_ct = kdf_params.to_json_bytes();

        conn.with_immediate_transaction(|| {
            conn.inner().execute(
                "INSERT INTO unlock_methods (method_id, method_type, kdf_profile_id,
                 kdf_params_ct, wrapped_vault_key_ct, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                rusqlite::params![
                    method_id,
                    method_type.to_string(),
                    "mdbx-default-v1",
                    kdf_params_ct,
                    wrapped_vault_key_ct,
                    now,
                ],
            )?;
            Self::bind_active_key_epoch(conn, active_epoch_wrapped_ct, &now)?;
            Self::validate_active_key_epoch(conn)?;
            Ok(())
        })?;

        Ok(UnlockMethod {
            method_id,
            method_type,
            kdf_profile_id: "mdbx-default-v1".to_string(),
            kdf_params_ct,
            wrapped_vault_key_ct: wrapped_vault_key_ct.to_vec(),
            created_at: now.clone(),
            updated_at: now,
        })
    }

    /// 更新已有方法的密钥。
    fn update_method_key(
        conn: &VaultConnection,
        method_type: UnlockMethodType,
        kdf_params: &KdfParams,
        wrapped_vault_key_ct: &[u8],
        active_epoch_wrapped_ct: &[u8],
    ) -> StorageResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        conn.with_immediate_transaction(|| {
            let affected = conn.inner().execute(
                "UPDATE unlock_methods
                 SET kdf_params_ct = ?1, wrapped_vault_key_ct = ?2, updated_at = ?3
                 WHERE method_type = ?4",
                rusqlite::params![
                    kdf_params.to_json_bytes(),
                    wrapped_vault_key_ct,
                    now,
                    method_type.to_string(),
                ],
            )?;

            if affected == 0 {
                return Err(StorageError::Validation(format!(
                    "no {:?} unlock method configured",
                    method_type
                )));
            }
            Self::bind_active_key_epoch(conn, active_epoch_wrapped_ct, &now)?;
            Self::validate_active_key_epoch(conn)?;
            Ok(())
        })
    }

    fn bind_active_key_epoch(
        conn: &VaultConnection,
        wrapped_epoch_key_ct: &[u8],
        now: &str,
    ) -> StorageResult<()> {
        let affected = conn.inner().execute(
            "UPDATE key_epochs
             SET status = 'active',
                 wrapped_epoch_key_ct = ?1,
                 kdf_profile_id = ?2,
                 activated_at = COALESCE(activated_at, ?3),
                 retired_at = NULL
             WHERE key_epoch_id = (SELECT active_key_epoch_id FROM vault_meta LIMIT 1)",
            rusqlite::params![wrapped_epoch_key_ct, ACTIVE_KEY_EPOCH_PROFILE_ID, now],
        )?;

        if affected == 0 {
            return Err(StorageError::Validation(
                "vault_meta.active_key_epoch_id does not reference a key epoch".to_string(),
            ));
        }
        Ok(())
    }

    /// 按类型查找已配置的解锁方式。
    fn find_method_by_type(
        conn: &VaultConnection,
        method_type: UnlockMethodType,
    ) -> StorageResult<Option<UnlockMethod>> {
        let result = conn.inner().query_row(
            "SELECT method_id, method_type, kdf_profile_id, kdf_params_ct,
                        wrapped_vault_key_ct, created_at, updated_at
                 FROM unlock_methods
                 WHERE method_type = ?1",
            rusqlite::params![method_type.to_string()],
            |row| {
                Ok(UnlockMethod {
                    method_id: row.get(0)?,
                    method_type: {
                        let s: String = row.get(1)?;
                        UnlockMethodType::parse(&s).unwrap()
                    },
                    kdf_profile_id: row.get(2)?,
                    kdf_params_ct: row.get(3)?,
                    wrapped_vault_key_ct: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        );

        match result {
            Ok(method) => Ok(Some(method)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::Database(e)),
        }
    }

    // -----------------------------------------------------------------------
    // PRIVATE HELPERS — 工具
    // -----------------------------------------------------------------------

    /// 对字符串进行 Unicode NFC 规范化。
    fn normalize_unicode(s: &str) -> String {
        use unicode_normalization::UnicodeNormalization;
        s.trim().nfc().collect()
    }

    /// 创建解锁会话。
    fn create_session(method: UnlockMethodType) -> StorageResult<VaultSession> {
        let now = chrono::Utc::now();
        Ok(VaultSession {
            session_id: Uuid::new_v4().to_string(),
            unlock_method: method,
            created_at: now.to_rfc3339(),
            assurance: mdbx_core::tiga::SessionAssurance::from_unlock_method(
                method,
                now.timestamp(),
            ),
        })
    }

    fn create_and_attach_session(
        conn: &mut VaultConnection,
        method: UnlockMethodType,
    ) -> StorageResult<VaultSession> {
        let session = Self::create_session(method)?;
        conn.attach_session(session.clone());
        Ok(session)
    }

    // -----------------------------------------------------------------------
    // VALIDATION
    // -----------------------------------------------------------------------

    fn ensure_bootstrap_available(conn: &VaultConnection) -> StorageResult<()> {
        if Self::list_methods(conn)?.is_empty() {
            Ok(())
        } else {
            Err(StorageError::Validation(
                "unlock bootstrap is only available before the first method; use an authorized unlock-method mutation"
                    .to_string(),
            ))
        }
    }

    fn validate_pin(pin: &str) -> StorageResult<()> {
        let trimmed = pin.trim();
        if trimmed.len() < 4 {
            return Err(StorageError::Validation(
                "PIN must be at least 4 digits".to_string(),
            ));
        }
        if !trimmed.chars().all(|c| c.is_ascii_digit()) {
            return Err(StorageError::Validation(
                "PIN must contain only digits".to_string(),
            ));
        }
        Ok(())
    }

    fn validate_password(password: &str) -> StorageResult<()> {
        let trimmed = password.trim();
        if trimmed.is_empty() {
            return Err(StorageError::Validation(
                "password must not be empty".to_string(),
            ));
        }
        Ok(())
    }

    fn validate_security_key_data(key_data: &[u8]) -> StorageResult<()> {
        if key_data.is_empty() {
            return Err(StorageError::Validation(
                "security key data must not be empty".to_string(),
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init::{initialize_vault, VaultInitParams};
    use mdbx_core::tiga::{AuthorizationOutcome, DeviceAssurance, DeviceContext};

    fn setup() -> VaultConnection {
        let conn = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams::default();
        initialize_vault(&conn, &params).unwrap();
        conn
    }

    fn standard_device() -> DeviceContext {
        DeviceContext {
            device_id: Some("test-device".to_string()),
            assurance: DeviceAssurance::Standard,
            secure_clipboard_available: true,
            screen_capture_protection_available: true,
            secure_temp_files_available: true,
        }
    }

    #[test]
    fn bootstrap_api_rejects_a_second_unlock_method() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "password").unwrap();
        let error = UnlockService::setup_pin(&mut conn, "123456").unwrap_err();
        assert!(error.to_string().contains("bootstrap is only available"));
        assert_eq!(UnlockService::list_methods(&conn).unwrap().len(), 1);
    }

    #[test]
    fn authorized_unlock_method_addition_is_audited() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "password").unwrap();
        let session = conn.active_session().unwrap().clone();
        let device = standard_device();
        UnlockService::setup_pin_authorized(
            &mut conn,
            "123456",
            TigaAuthorizationContext {
                session: Some(&session),
                device: &device,
                now_unix_secs: session.assurance.authenticated_at_unix_secs + 1,
            },
        )
        .unwrap();
        assert_eq!(UnlockService::list_methods(&conn).unwrap().len(), 2);
        let events = TigaService::list_security_audit_events(&conn, 10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].operation, TigaOperation::ChangeUnlockMethods);
        assert_eq!(events[0].outcome, AuthorizationOutcome::Allow);
    }

    #[test]
    fn power_remediation_can_add_combined_method_then_become_compliant() {
        let mut conn = setup();
        conn.inner()
            .execute("UPDATE vault_meta SET default_tiga_mode = 'power'", [])
            .unwrap();
        UnlockService::setup_password_with_mode(&mut conn, "password", TigaMode::Power).unwrap();
        assert_eq!(
            TigaService::get_policy_state(&conn).unwrap().compliance,
            mdbx_core::tiga::PolicyCompliance::RemediationRequired
        );

        let password_session = conn.active_session().unwrap().clone();
        let device = standard_device();
        UnlockService::setup_password_security_key_authorized(
            &mut conn,
            "password",
            b"hardware-key-material-32bytes!!!",
            TigaMode::Power,
            TigaAuthorizationContext {
                session: Some(&password_session),
                device: &device,
                now_unix_secs: password_session.assurance.authenticated_at_unix_secs + 1,
            },
        )
        .unwrap();
        assert_eq!(
            TigaService::get_policy_state(&conn).unwrap().compliance,
            mdbx_core::tiga::PolicyCompliance::RemediationRequired
        );

        let password_method = UnlockService::list_methods(&conn)
            .unwrap()
            .into_iter()
            .find(|method| method.method_type == UnlockMethodType::Password)
            .unwrap();
        let combined_session = conn.active_session().unwrap().clone();
        UnlockService::remove_method_authorized(
            &mut conn,
            &password_method.method_id,
            TigaAuthorizationContext {
                session: Some(&combined_session),
                device: &device,
                now_unix_secs: combined_session.assurance.authenticated_at_unix_secs + 1,
            },
        )
        .unwrap();
        assert_eq!(
            TigaService::get_policy_state(&conn).unwrap().compliance,
            mdbx_core::tiga::PolicyCompliance::Compliant
        );
    }

    // -----------------------------------------------------------------------
    // PIN
    // -----------------------------------------------------------------------

    #[test]
    fn test_setup_and_unlock_pin() {
        let mut conn = setup();
        UnlockService::setup_pin(&mut conn, "123456").unwrap();

        let session = UnlockService::unlock_with_pin(&mut conn, "123456").unwrap();
        assert_eq!(session.unlock_method, UnlockMethodType::Pin);
    }

    #[test]
    fn test_wrong_pin_rejected() {
        let mut conn = setup();
        UnlockService::setup_pin(&mut conn, "9999").unwrap();

        let result = UnlockService::unlock_with_pin(&mut conn, "0000");
        assert!(result.is_err());
    }

    #[test]
    fn test_pin_too_short_rejected() {
        let mut conn = setup();
        let result = UnlockService::setup_pin(&mut conn, "123");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("at least 4 digits"));
    }

    #[test]
    fn test_pin_non_digit_rejected() {
        let mut conn = setup();
        let result = UnlockService::setup_pin(&mut conn, "12ab");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("only digits"));
    }

    #[test]
    fn test_pin_whitespace_trimmed() {
        let mut conn = setup();
        UnlockService::setup_pin(&mut conn, "  7777  ").unwrap();
        assert!(UnlockService::unlock_with_pin(&mut conn, "7777").is_ok());
    }

    #[test]
    fn test_change_pin() {
        let mut conn = setup();
        UnlockService::setup_pin(&mut conn, "111111").unwrap();

        UnlockService::change_pin(&mut conn, "111111", "222222").unwrap();

        assert!(UnlockService::unlock_with_pin(&mut conn, "111111").is_err());
        assert!(UnlockService::unlock_with_pin(&mut conn, "222222").is_ok());
    }

    #[test]
    fn test_unlock_without_setup_pin() {
        let mut conn = setup();
        let result = UnlockService::unlock_with_pin(&mut conn, "123456");
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // PASSWORD
    // -----------------------------------------------------------------------

    #[test]
    fn test_setup_and_unlock_password() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "my-secret-password").unwrap();

        let session = UnlockService::unlock_with_password(&mut conn, "my-secret-password").unwrap();
        assert_eq!(session.unlock_method, UnlockMethodType::Password);
    }

    #[test]
    fn test_wrong_password_rejected() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "correct-horse-battery-staple").unwrap();

        let result = UnlockService::unlock_with_password(&mut conn, "wrong-horse-battery-staple");
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_password_rejected() {
        let mut conn = setup();
        let result = UnlockService::setup_password(&mut conn, "");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("must not be empty"));
    }

    #[test]
    fn test_password_whitespace_trimmed() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "  my-password  ").unwrap();
        assert!(UnlockService::unlock_with_password(&mut conn, "my-password").is_ok());
    }

    #[test]
    fn test_change_password() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "old-password").unwrap();

        UnlockService::change_password(&mut conn, "old-password", "new-password").unwrap();

        assert!(UnlockService::unlock_with_password(&mut conn, "old-password").is_err());
        assert!(UnlockService::unlock_with_password(&mut conn, "new-password").is_ok());
    }

    #[test]
    fn test_reset_password_uses_unlocked_vault_key() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "old-password").unwrap();
        let vault_key = conn.keyring().unwrap().vault_key.clone();

        UnlockService::reset_password_with_mode(&mut conn, "new-password", TigaMode::Multi)
            .unwrap();

        assert!(UnlockService::unlock_with_password(&mut conn, "old-password").is_err());
        assert!(UnlockService::unlock_with_password(&mut conn, "new-password").is_ok());
        assert_eq!(conn.keyring().unwrap().vault_key, vault_key);
    }

    #[test]
    fn test_reset_password_requires_unlocked_vault() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "old-password").unwrap();
        conn.keyring = None;

        let result =
            UnlockService::reset_password_with_mode(&mut conn, "new-password", TigaMode::Multi);

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("vault must be unlocked before resetting password"));
    }

    #[test]
    fn test_reset_password_requires_configured_password_method() {
        let mut conn = setup();
        UnlockService::setup_pin(&mut conn, "123456").unwrap();

        let result =
            UnlockService::reset_password_with_mode(&mut conn, "new-password", TigaMode::Multi);

        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("no password configured"));
    }

    #[test]
    fn test_chinese_password() {
        let mut conn = setup();
        let password = "我的密码是安全的123";
        UnlockService::setup_password(&mut conn, password).unwrap();

        let session = UnlockService::unlock_with_password(&mut conn, password).unwrap();
        assert_eq!(session.unlock_method, UnlockMethodType::Password);
    }

    #[test]
    fn test_chinese_password_rejected_with_different_chars() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "中文密码").unwrap();

        let result = UnlockService::unlock_with_password(&mut conn, "日文密码");
        assert!(result.is_err());
    }

    #[test]
    fn test_unicode_emoji_password() {
        let mut conn = setup();
        let password = "password🔐with🚀emoji";
        UnlockService::setup_password(&mut conn, password).unwrap();

        let session = UnlockService::unlock_with_password(&mut conn, password).unwrap();
        assert_eq!(session.unlock_method, UnlockMethodType::Password);
    }

    #[test]
    fn test_mixed_script_password() {
        let mut conn = setup();
        let password = "パスワード mot de passe 密码 пароль";
        UnlockService::setup_password(&mut conn, password).unwrap();

        assert!(UnlockService::unlock_with_password(&mut conn, password).is_ok());
    }

    #[test]
    fn test_unlock_without_setup_password() {
        let mut conn = setup();
        let result = UnlockService::unlock_with_password(&mut conn, "some-password");
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // SECURITY KEY
    // -----------------------------------------------------------------------

    #[test]
    fn test_setup_and_unlock_security_key() {
        let mut conn = setup();
        let key_data = b"hardware-key-material-32bytes!!!";
        UnlockService::setup_security_key(&mut conn, key_data).unwrap();

        let session = UnlockService::unlock_with_security_key(&mut conn, key_data).unwrap();
        assert_eq!(session.unlock_method, UnlockMethodType::SecurityKey);
    }

    #[test]
    fn test_wrong_security_key_rejected() {
        let mut conn = setup();
        UnlockService::setup_security_key(&mut conn, b"original-key-data").unwrap();

        let result = UnlockService::unlock_with_security_key(&mut conn, b"wrong-key-data");
        assert!(result.is_err());
    }

    #[test]
    fn test_empty_security_key_rejected() {
        let mut conn = setup();
        let result = UnlockService::setup_security_key(&mut conn, b"");
        assert!(result.is_err());
    }

    #[test]
    fn test_unlock_without_setup_security_key() {
        let mut conn = setup();
        let result = UnlockService::unlock_with_security_key(&mut conn, b"some-key-data");
        assert!(result.is_err());
    }

    #[test]
    fn test_setup_and_unlock_password_security_key() {
        let mut conn = setup();
        let key_data = b"hardware-key-material-32bytes!!!";
        UnlockService::setup_password_security_key(
            &mut conn,
            "my-secret-password",
            key_data,
            TigaMode::Sky,
        )
        .unwrap();

        let session = UnlockService::unlock_with_password_security_key(
            &mut conn,
            "my-secret-password",
            key_data,
        )
        .unwrap();
        assert_eq!(session.unlock_method, UnlockMethodType::PasswordSecurityKey);
    }

    #[test]
    fn test_password_security_key_requires_both_factors() {
        let mut conn = setup();
        let key_data = b"hardware-key-material-32bytes!!!";
        UnlockService::setup_password_security_key(
            &mut conn,
            "my-secret-password",
            key_data,
            TigaMode::Sky,
        )
        .unwrap();

        assert!(UnlockService::unlock_with_password_security_key(
            &mut conn,
            "wrong-password",
            key_data
        )
        .is_err());
        assert!(UnlockService::unlock_with_password_security_key(
            &mut conn,
            "my-secret-password",
            b"wrong-key-data"
        )
        .is_err());
    }

    // -----------------------------------------------------------------------
    // TIGA UNLOCK POLICY
    // -----------------------------------------------------------------------

    #[test]
    fn test_tiga_sky_policy_accepts_portable_unlock() {
        let mut conn = setup();
        UnlockService::setup_password_with_mode(&mut conn, "password", TigaMode::Sky).unwrap();

        let assessment = UnlockService::assess_tiga_unlock_policy(&conn, TigaMode::Sky).unwrap();
        assert!(assessment.satisfies_policy);
        assert!(assessment.has_portable_unlock);
        assert!(!assessment.has_security_key_unlock);
    }

    #[test]
    fn test_tiga_multi_policy_warns_without_security_key_but_remains_usable() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "password").unwrap();

        let assessment = UnlockService::assess_tiga_unlock_policy(&conn, TigaMode::Multi).unwrap();
        assert!(assessment.satisfies_policy);
        assert!(assessment.has_portable_unlock);
        assert!(!assessment.has_security_key_unlock);
        assert!(assessment
            .warnings
            .iter()
            .any(|warning| warning.contains("recommends adding a security key")));
    }

    #[test]
    fn test_tiga_multi_policy_requires_portable_recovery_path() {
        let mut conn = setup();
        UnlockService::setup_security_key(&mut conn, b"hardware-key-material-32bytes!!!").unwrap();

        let assessment = UnlockService::assess_tiga_unlock_policy(&conn, TigaMode::Multi).unwrap();
        assert!(!assessment.satisfies_policy);
        assert!(!assessment.has_portable_unlock);
        assert!(assessment.has_security_key_unlock);
        assert!(assessment
            .warnings
            .iter()
            .any(|warning| warning.contains("no portable unlock method")));
    }

    #[test]
    fn test_tiga_power_policy_requires_combined_factor_without_portable_fallback() {
        let mut conn = setup();
        UnlockService::setup_password_security_key(
            &mut conn,
            "password",
            b"hardware-key-material-32bytes!!!",
            TigaMode::Power,
        )
        .unwrap();

        let assessment = UnlockService::assess_tiga_unlock_policy(&conn, TigaMode::Power).unwrap();
        assert!(assessment.satisfies_policy);
        assert!(assessment.has_combined_password_security_key);
        assert!(assessment.has_required_combined_strength);
        assert!(!assessment.has_portable_unlock);
    }

    #[test]
    fn test_tiga_power_policy_rejects_standalone_password_fallback() {
        let mut conn = setup();
        UnlockService::setup_password_security_key(
            &mut conn,
            "password",
            b"hardware-key-material-32bytes!!!",
            TigaMode::Power,
        )
        .unwrap();
        UnlockService::setup_password_with_mode_raw(
            &mut conn,
            "fallback-password",
            TigaMode::Multi,
        )
        .unwrap();

        let assessment = UnlockService::assess_tiga_unlock_policy(&conn, TigaMode::Power).unwrap();
        assert!(!assessment.satisfies_policy);
        assert!(assessment.has_combined_password_security_key);
        assert!(assessment.has_portable_unlock);
        assert!(assessment
            .warnings
            .iter()
            .any(|warning| warning.contains("standalone portable")));
    }

    #[test]
    fn test_tiga_power_policy_rejects_weak_combined_kdf() {
        let mut conn = setup();
        UnlockService::setup_password_security_key(
            &mut conn,
            "password",
            b"hardware-key-material-32bytes!!!",
            TigaMode::Sky,
        )
        .unwrap();

        let assessment = UnlockService::assess_tiga_unlock_policy(&conn, TigaMode::Power).unwrap();
        assert!(!assessment.satisfies_policy);
        assert!(assessment.has_combined_password_security_key);
        assert!(!assessment.has_required_combined_strength);
        assert!(assessment
            .warnings
            .iter()
            .any(|warning| warning.contains("weaker KDF")));
    }

    // -----------------------------------------------------------------------
    // LIST & REMOVE
    // -----------------------------------------------------------------------

    #[test]
    fn test_list_methods() {
        let mut conn = setup();
        UnlockService::setup_pin(&mut conn, "123456").unwrap();
        UnlockService::setup_password_with_mode_raw(&mut conn, "password", TigaMode::Multi)
            .unwrap();

        let methods = UnlockService::list_methods(&conn).unwrap();
        assert_eq!(methods.len(), 2);

        let has_pin = methods
            .iter()
            .any(|m| m.method_type == UnlockMethodType::Pin);
        let has_password = methods
            .iter()
            .any(|m| m.method_type == UnlockMethodType::Password);
        assert!(has_pin);
        assert!(has_password);
    }

    #[test]
    fn test_has_method_of_type() {
        let mut conn = setup();
        assert!(!UnlockService::has_method_of_type(&conn, UnlockMethodType::Pin).unwrap());

        UnlockService::setup_pin(&mut conn, "123456").unwrap();
        assert!(UnlockService::has_method_of_type(&conn, UnlockMethodType::Pin).unwrap());
    }

    #[test]
    fn test_remove_method() {
        let mut conn = setup();
        UnlockService::setup_pin(&mut conn, "123456").unwrap();
        let pw =
            UnlockService::setup_password_with_mode_raw(&mut conn, "password", TigaMode::Multi)
                .unwrap();

        let methods = UnlockService::list_methods(&conn).unwrap();
        assert_eq!(methods.len(), 2);

        UnlockService::remove_method(&conn, &pw.method_id).unwrap();

        let methods = UnlockService::list_methods(&conn).unwrap();
        assert_eq!(methods.len(), 1);
        assert_eq!(methods[0].method_type, UnlockMethodType::Pin);
    }

    #[test]
    fn test_cannot_remove_last_method() {
        let mut conn = setup();
        let pin = UnlockService::setup_pin(&mut conn, "123456").unwrap();

        let result = UnlockService::remove_method(&conn, &pin.method_id);
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("last unlock method"));
    }

    #[test]
    fn test_remove_nonexistent_method() {
        let conn = setup();
        let result = UnlockService::remove_method(&conn, "nonexistent-id");
        assert!(result.is_err());
    }

    // -----------------------------------------------------------------------
    // UNLOCK WITH UNCONFIGURED METHOD
    // -----------------------------------------------------------------------

    #[test]
    fn test_unlock_with_wrong_method_type() {
        let mut conn = setup();
        UnlockService::setup_pin(&mut conn, "123456").unwrap();

        let result = UnlockService::unlock_with_password(&mut conn, "some-password");
        assert!(result.is_err());
    }

    #[test]
    fn test_initial_active_key_epoch_marker_is_validated() {
        let conn = setup();
        UnlockService::validate_active_key_epoch(&conn).unwrap();

        let (profile, wrapped_len): (String, i64) = conn
            .inner()
            .query_row(
                "SELECT kdf_profile_id, length(wrapped_epoch_key_ct)
                 FROM key_epochs
                 WHERE key_epoch_id = (SELECT active_key_epoch_id FROM vault_meta LIMIT 1)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(profile, INIT_KEY_EPOCH_PROFILE_ID);
        assert_eq!(wrapped_len, 32);
    }

    #[test]
    fn test_unlock_setup_binds_real_active_key_epoch_wrapping() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "password").unwrap();
        UnlockService::validate_active_key_epoch(&conn).unwrap();

        let (epoch_id, profile, wrapped_len): (String, String, i64) = conn
            .inner()
            .query_row(
                "SELECT key_epoch_id, kdf_profile_id, length(wrapped_epoch_key_ct)
                 FROM key_epochs
                 WHERE key_epoch_id = (SELECT active_key_epoch_id FROM vault_meta LIMIT 1)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(profile, ACTIVE_KEY_EPOCH_PROFILE_ID);
        assert!(wrapped_len >= 72);
        assert_eq!(conn.active_key_epoch_id(), Some(epoch_id.as_str()));
    }

    #[test]
    fn unlock_rejects_tampered_active_key_epoch_wrapper() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "password").unwrap();
        conn.clear_session();

        let mut wrapped: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT wrapped_epoch_key_ct FROM key_epochs
                 WHERE key_epoch_id = (SELECT active_key_epoch_id FROM vault_meta LIMIT 1)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        *wrapped.last_mut().unwrap() ^= 0x01;
        conn.inner()
            .execute(
                "UPDATE key_epochs SET wrapped_epoch_key_ct = ?1
                 WHERE key_epoch_id = (SELECT active_key_epoch_id FROM vault_meta LIMIT 1)",
                rusqlite::params![wrapped],
            )
            .unwrap();

        let error = UnlockService::unlock_with_password(&mut conn, "password").unwrap_err();
        assert!(error
            .to_string()
            .contains("active key epoch wrapper authentication failed"));
        assert!(conn.keyring().is_none());
        assert!(conn.active_session().is_none());
    }

    #[test]
    fn unlock_rejects_substituted_active_key_epoch_wrapper() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "password").unwrap();
        let vault_key = conn.keyring().unwrap().vault_key.clone();
        conn.clear_session();

        let other_vault_key = aead::generate_key().unwrap();
        let substituted =
            aead::encrypt(&vault_key, &other_vault_key, ACTIVE_KEY_EPOCH_AAD).unwrap();
        conn.inner()
            .execute(
                "UPDATE key_epochs SET wrapped_epoch_key_ct = ?1
                 WHERE key_epoch_id = (SELECT active_key_epoch_id FROM vault_meta LIMIT 1)",
                rusqlite::params![substituted],
            )
            .unwrap();

        let error = UnlockService::unlock_with_password(&mut conn, "password").unwrap_err();
        assert!(error
            .to_string()
            .contains("active key epoch wrapper does not match the unlocked vault key"));
        assert!(conn.keyring().is_none());
        assert!(conn.active_session().is_none());
    }

    #[test]
    fn test_active_key_epoch_validation_rejects_duplicate_active_epochs() {
        let conn = setup();
        conn.inner()
            .execute(
                "INSERT INTO key_epochs (key_epoch_id, status, wrapped_epoch_key_ct,
                 kdf_profile_id, created_at, activated_at)
                 VALUES ('extra-active', 'active', X'01020304', 'mdbx-active-key-epoch-v1',
                 '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z')",
                [],
            )
            .unwrap();

        let err = UnlockService::validate_active_key_epoch(&conn).unwrap_err();
        assert!(err.to_string().contains("exactly one active key epoch"));
    }

    // -----------------------------------------------------------------------
    // UNLOCK SESSION
    // -----------------------------------------------------------------------

    #[test]
    fn test_session_contains_method_and_timestamp() {
        let mut conn = setup();
        UnlockService::setup_pin(&mut conn, "123456").unwrap();

        let session = UnlockService::unlock_with_pin(&mut conn, "123456").unwrap();
        assert!(!session.session_id.is_empty());
        assert_eq!(session.unlock_method, UnlockMethodType::Pin);
        assert!(!session.created_at.is_empty());
    }

    #[test]
    fn test_multiple_sessions_unique() {
        let mut conn = setup();
        UnlockService::setup_pin(&mut conn, "123456").unwrap();

        let s1 = UnlockService::unlock_with_pin(&mut conn, "123456").unwrap();
        let s2 = UnlockService::unlock_with_pin(&mut conn, "123456").unwrap();
        assert_ne!(s1.session_id, s2.session_id);
    }

    // -----------------------------------------------------------------------
    // KDF PARAMETER ROUNDTRIP
    // -----------------------------------------------------------------------

    #[test]
    fn test_kdf_params_roundtrip() {
        let params = KdfParams::for_password();
        let bytes = params.to_json_bytes();
        let restored = KdfParams::from_json_bytes(&bytes).unwrap();
        assert_eq!(restored.algorithm, params.algorithm);
        assert_eq!(restored.ops_limit, params.ops_limit);
        assert_eq!(restored.mem_limit_kib, params.mem_limit_kib);
        assert_eq!(restored.parallelism, params.parallelism);
        assert_eq!(restored.output_len, params.output_len);
    }

    #[test]
    fn test_kdf_params_per_method_different() {
        let pin_params = KdfParams::for_pin();
        let pw_params = KdfParams::for_password();
        let sk_params = KdfParams::for_security_key();

        assert!(pin_params.ops_limit < pw_params.ops_limit);
        assert!(pin_params.mem_limit_kib < pw_params.mem_limit_kib);
        assert!(sk_params.ops_limit < pw_params.ops_limit);
    }

    // -----------------------------------------------------------------------
    // PIN VALIDATION EDGE CASES
    // -----------------------------------------------------------------------

    #[test]
    fn test_pin_exactly_4_digits_ok() {
        let mut conn = setup();
        assert!(UnlockService::setup_pin(&mut conn, "0000").is_ok());
    }

    #[test]
    fn test_pin_spaces_around_digits() {
        let mut conn = setup();
        UnlockService::setup_pin(&mut conn, "  888888  ").unwrap();
        assert!(UnlockService::unlock_with_pin(&mut conn, "888888").is_ok());
    }

    // -----------------------------------------------------------------------
    // UNICODE NFC NORMALIZATION
    // -----------------------------------------------------------------------

    #[test]
    fn test_nfc_normalization_combining_accent() {
        let nfd = "caf\u{0065}\u{0301}";
        let nfc = "caf\u{00E9}";

        let normalized_nfd = UnlockService::normalize_unicode(nfd);
        let normalized_nfc = UnlockService::normalize_unicode(nfc);

        assert_eq!(normalized_nfd, normalized_nfc);
        assert_eq!(normalized_nfd, nfc);
    }

    #[test]
    fn test_nfc_normalization_korean() {
        let nfd = "\u{1112}\u{1161}\u{11AB}";
        let nfc_expected = "\u{D55C}";

        let normalized = UnlockService::normalize_unicode(nfd);
        assert_eq!(normalized, nfc_expected);
    }

    #[test]
    fn test_nfc_noop_for_already_normalized() {
        let s = "我的密码是安全的123";
        let normalized = UnlockService::normalize_unicode(s);
        assert_eq!(normalized, s);
    }

    #[test]
    fn test_unlock_with_nfc_mismatched_input() {
        let mut conn = setup();
        let nfc_password = "caf\u{00E9}";
        UnlockService::setup_password(&mut conn, nfc_password).unwrap();

        let nfd_input = "caf\u{0065}\u{0301}";
        let session = UnlockService::unlock_with_password(&mut conn, nfd_input).unwrap();
        assert_eq!(session.unlock_method, UnlockMethodType::Password);
    }

    #[test]
    fn test_nfc_with_whitespace() {
        let s = "  \u{00E9}  ";
        let normalized = UnlockService::normalize_unicode(s);
        assert_eq!(normalized, "\u{00E9}");
    }

    // -----------------------------------------------------------------------
    // ENCRYPTION — 密钥包装与 Keyring 正确性
    // -----------------------------------------------------------------------

    #[test]
    fn test_derived_key_not_stored_directly() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "test-password").unwrap();

        let method = UnlockService::find_method_by_type(&conn, UnlockMethodType::Password)
            .unwrap()
            .unwrap();
        let kdf_params = KdfParams::from_json_bytes(&method.kdf_params_ct).unwrap();
        let derived = UnlockService::derive_key(b"test-password", &kdf_params).unwrap();

        // wrapped_vault_key_ct 不能等于派生密钥（它是 AEAD 密文，不是原始密钥字节）
        assert_ne!(method.wrapped_vault_key_ct.as_slice(), derived.as_slice());
        // 密文至少 nonce(24) + tag(16) + 加密的 vault_key(32) = 72 字节
        assert!(method.wrapped_vault_key_ct.len() >= 72);
    }

    #[test]
    fn test_setup_attaches_keyring() {
        let mut conn = setup();
        assert!(!conn.is_encrypted());

        UnlockService::setup_password(&mut conn, "my-password").unwrap();
        assert!(conn.is_encrypted());
    }

    #[test]
    fn test_setup_seals_vault_header() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "my-password").unwrap();

        let (profile, tag): (String, Option<Vec<u8>>) = conn
            .inner()
            .query_row(
                "SELECT header_integrity_profile, header_integrity_tag FROM vault_meta",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            profile,
            crate::schema::v16::HEADER_AUTH_HMAC_SHA256_V1_PROFILE
        );
        assert_eq!(tag.unwrap().len(), 32);
        assert_eq!(
            crate::vault_header_integrity::check(&conn).unwrap(),
            crate::vault_header_integrity::VaultHeaderIntegrityStatus::Verified
        );
    }

    #[test]
    fn test_unlock_rejects_tampered_vault_header() {
        let path =
            std::env::temp_dir().join(format!("mdbx-header-tamper-{}.mdbx", uuid::Uuid::new_v4()));
        {
            let mut conn = VaultConnection::create(&path).unwrap();
            initialize_vault(&conn, &VaultInitParams::default()).unwrap();
            UnlockService::setup_password(&mut conn, "my-password").unwrap();
        }
        {
            let raw = rusqlite::Connection::open(&path).unwrap();
            raw.execute("UPDATE vault_meta SET default_tiga_mode = 'power'", [])
                .unwrap();
        }

        let mut conn = VaultConnection::open(&path).unwrap();
        let error = UnlockService::unlock_with_password(&mut conn, "my-password").unwrap_err();
        assert!(error.to_string().contains("header authentication"));
        assert!(!conn.is_encrypted());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn test_unlock_attaches_keyring() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "my-password").unwrap();

        // 读取 vault_id 以创建相同 vault 的第二个连接
        let vault_id: String = conn
            .inner()
            .query_row("SELECT vault_id FROM vault_meta", [], |row| row.get(0))
            .unwrap();

        // 重新创建连接（模拟重新打开 vault）
        let mut conn2 = VaultConnection::open_in_memory().unwrap();
        let params = VaultInitParams {
            vault_id: Some(vault_id),
            ..VaultInitParams::default()
        };
        initialize_vault(&conn2, &params).unwrap();
        // 把 unlock_methods 复制过去（模拟持久化数据）
        let methods = UnlockService::list_methods(&conn).unwrap();
        for m in &methods {
            conn2
                .inner()
                .execute(
                    "INSERT INTO unlock_methods (method_id, method_type, kdf_profile_id,
                 kdf_params_ct, wrapped_vault_key_ct, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    rusqlite::params![
                        m.method_id,
                        m.method_type.to_string(),
                        m.kdf_profile_id,
                        m.kdf_params_ct,
                        m.wrapped_vault_key_ct,
                        m.created_at,
                        m.updated_at,
                    ],
                )
                .unwrap();
        }

        assert!(!conn2.is_encrypted());
        UnlockService::unlock_with_password(&mut conn2, "my-password").unwrap();
        assert!(conn2.is_encrypted());
    }

    #[test]
    fn test_unlock_then_setup_second_method_reuses_vault_key() {
        let mut conn = setup();
        // 先设置密码
        UnlockService::setup_password(&mut conn, "password1").unwrap();
        let vault_key_1 = conn.keyring().unwrap().vault_key.clone();

        // 再设置 PIN — 应复用同一个 vault_key
        UnlockService::setup_pin_raw(&mut conn, "123456").unwrap();
        let vault_key_2 = conn.keyring().unwrap().vault_key.clone();

        assert_eq!(vault_key_1, vault_key_2);
    }

    #[test]
    fn test_both_methods_unlock_to_same_keyring() {
        let mut conn = setup();
        UnlockService::setup_password(&mut conn, "password").unwrap();
        UnlockService::setup_pin_raw(&mut conn, "123456").unwrap();

        let vault_id: String = conn
            .inner()
            .query_row("SELECT vault_id FROM vault_meta", [], |row| row.get(0))
            .unwrap();
        let methods = UnlockService::list_methods(&conn).unwrap();

        // 用 PIN 解锁
        let mut conn_a = VaultConnection::open_in_memory().unwrap();
        initialize_vault(
            &conn_a,
            &VaultInitParams {
                vault_id: Some(vault_id.clone()),
                ..VaultInitParams::default()
            },
        )
        .unwrap();
        for m in &methods {
            conn_a
                .inner()
                .execute(
                    "INSERT INTO unlock_methods VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    rusqlite::params![
                        m.method_id,
                        m.method_type.to_string(),
                        m.kdf_profile_id,
                        m.kdf_params_ct,
                        m.wrapped_vault_key_ct,
                        m.created_at,
                        m.updated_at
                    ],
                )
                .unwrap();
        }
        UnlockService::unlock_with_pin(&mut conn_a, "123456").unwrap();
        let subkeys_from_pin = (
            conn_a.keyring().unwrap().record_subkey.clone(),
            conn_a.keyring().unwrap().attachment_subkey.clone(),
        );

        // 用密码解锁 — 子密钥应相同
        let mut conn_b = VaultConnection::open_in_memory().unwrap();
        initialize_vault(
            &conn_b,
            &VaultInitParams {
                vault_id: Some(vault_id),
                ..VaultInitParams::default()
            },
        )
        .unwrap();
        for m in &methods {
            conn_b
                .inner()
                .execute(
                    "INSERT INTO unlock_methods VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    rusqlite::params![
                        m.method_id,
                        m.method_type.to_string(),
                        m.kdf_profile_id,
                        m.kdf_params_ct,
                        m.wrapped_vault_key_ct,
                        m.created_at,
                        m.updated_at
                    ],
                )
                .unwrap();
        }
        UnlockService::unlock_with_password(&mut conn_b, "password").unwrap();
        let subkeys_from_pw = (
            conn_b.keyring().unwrap().record_subkey.clone(),
            conn_b.keyring().unwrap().attachment_subkey.clone(),
        );

        assert_eq!(subkeys_from_pin, subkeys_from_pw);
    }

    /// 完整端到端测试：创建 vault → 设密码 → 写数据 → 关 → 重开 → 解密验证。
    #[test]
    fn test_e2e_full_workflow() {
        use crate::init::{initialize_vault, VaultInitParams};
        use crate::repo::{CommitContext, EntryRepo, ProjectRepo};
        use mdbx_core::model::EntryType;
        use mdbx_core::tiga::TigaMode;

        // ---- Phase 1: 创建 vault + 设置 Power 模式密码 ----
        let mut conn = VaultConnection::open_in_memory().unwrap();
        let vault_id = uuid::Uuid::new_v4().to_string();
        initialize_vault(
            &conn,
            &VaultInitParams {
                vault_id: Some(vault_id.clone()),
                default_tiga_mode: "power".to_string(),
                ..VaultInitParams::default()
            },
        )
        .unwrap();

        UnlockService::setup_password_with_mode(&mut conn, "我的密码123", TigaMode::Power).unwrap();

        // 验证 Tiga 模式写入
        let global_mode = crate::tiga::TigaService::get_global_default(&conn).unwrap();
        assert_eq!(global_mode, TigaMode::Power);

        // 验证 Power 模式的 KDF 参数 (256 MiB)
        let methods = UnlockService::list_methods(&conn).unwrap();
        let kdf = KdfParams::from_json_bytes(&methods[0].kdf_params_ct).unwrap();
        assert_eq!(kdf.mem_limit_kib, 262144);

        // ---- Phase 2: 写入数据 ----
        let ctx = CommitContext::new("device-e2e".to_string());
        let proj = ProjectRepo::create(&conn, &ctx, "我的工作账号", None, None).unwrap();
        let _entry = EntryRepo::create(
            &conn,
            &ctx,
            &proj.project_id,
            EntryType::Login,
            Some("GitHub"),
            &serde_json::json!({"username": "alice@example.com", "password": "s3cret-token"}),
        )
        .unwrap();

        // ---- Phase 3: 验证原始数据库中是密文 ----
        let raw_title: Vec<u8> = conn
            .inner()
            .query_row(
                "SELECT title_ct FROM projects WHERE project_id = ?1",
                rusqlite::params![proj.project_id],
                |row| row.get(0),
            )
            .unwrap();
        let plain_bytes = "我的工作账号".as_bytes().to_vec();
        assert_ne!(raw_title, plain_bytes, "DB 中应存储密文而非明文");

        // ---- Phase 4: 通过 API 读取得到明文 ----
        let projects = ProjectRepo::list_all(&conn).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].title_ct, plain_bytes);

        let entries = EntryRepo::list_by_project(&conn, &proj.project_id).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title_ct.as_deref(), Some(&b"GitHub"[..]));

        // ---- Phase 5: 错误密码被拒绝 ----
        let mut conn2 = VaultConnection::open_in_memory().unwrap();
        initialize_vault(
            &conn2,
            &VaultInitParams {
                vault_id: Some(uuid::Uuid::new_v4().to_string()),
                ..VaultInitParams::default()
            },
        )
        .unwrap();
        for m in &methods {
            conn2
                .inner()
                .execute(
                    "INSERT INTO unlock_methods VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    rusqlite::params![
                        m.method_id,
                        m.method_type.to_string(),
                        m.kdf_profile_id,
                        m.kdf_params_ct,
                        m.wrapped_vault_key_ct,
                        m.created_at,
                        m.updated_at
                    ],
                )
                .unwrap();
        }
        // 错误的密码应导致解锁失败
        assert!(UnlockService::unlock_with_password(&mut conn2, "错误密码").is_err());
    }
}
