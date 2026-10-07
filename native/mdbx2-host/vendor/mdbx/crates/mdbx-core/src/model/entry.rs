use serde::{Deserialize, Serialize};

use crate::tiga::TigaMode;
use crate::types::*;

/// Entry 是 project 内部的具体类型化记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub entry_id: EntryId,
    /// 父级 project（FK 约束）
    pub project_id: ProjectId,
    /// entry 类型
    pub entry_type: EntryType,
    /// 加密的标题（可选）
    pub title_ct: Option<CipherText>,
    /// 加密的秘密载荷 — 所有敏感字段都在这里
    pub payload_ct: CipherText,
    /// 载荷 schema 版本，用于兼容性
    pub payload_schema_version: u32,
    /// entry 级 Tiga 覆盖
    pub tiga_mode_override: Option<TigaMode>,
    /// 向量时钟
    pub object_clock: ObjectClock,
    /// 当前 head commit
    pub head_commit_id: CommitId,
    /// 软删除标记
    pub deleted: bool,
    /// 创建时间 (ISO 8601)
    pub created_at: String,
    /// 更新时间 (ISO 8601)
    pub updated_at: String,
    /// 创建设备 ID
    pub created_by_device_id: DeviceId,
    /// 更新设备 ID
    pub updated_by_device_id: DeviceId,
}

/// 通用对象的列表摘要。摘要只包含列表和选择界面需要的元数据，不包含对象载荷。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectSummary {
    pub object_id: EntryId,
    pub collection_id: ProjectId,
    pub object_type_id: ObjectTypeId,
    /// 解密后的标题字节。旧数据允许非 UTF-8 标题，因此核心层保留原始字节。
    pub title: Option<Vec<u8>>,
    pub payload_schema_version: u32,
    pub head_commit_id: CommitId,
    pub deleted: bool,
    pub updated_at: String,
}

/// 有界对象摘要页。`next_cursor` 是绑定查询条件的存储层不透明游标。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectSummaryPage {
    pub items: Vec<ObjectSummary>,
    pub next_cursor: Option<String>,
}

/// 通用对象类型标识。旧 EntryType 变体保持兼容，自定义标识精确保留。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ObjectTypeId {
    /// 登录凭据
    Login,
    /// 安全笔记
    Note,
    /// 卡片（信用卡、会员卡等）
    Card,
    /// 身份记录
    Identity,
    /// TOTP 记录
    Totp,
    /// Passkey 记录
    Passkey,
    /// SSH 密钥
    SshKey,
    /// API Token
    ApiToken,
    /// 文档引用
    DocumentRef,
    /// 客户端或扩展定义的对象类型
    Custom(String),
}

/// MDBX1 兼容名称。新代码应优先使用 `ObjectTypeId`。
pub type EntryType = ObjectTypeId;

impl ObjectTypeId {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Login => "login",
            Self::Note => "note",
            Self::Card => "card",
            Self::Identity => "identity",
            Self::Totp => "totp",
            Self::Passkey => "passkey",
            Self::SshKey => "ssh-key",
            Self::ApiToken => "api-token",
            Self::DocumentRef => "document-ref",
            Self::Custom(value) => value,
        }
    }

    pub fn is_legacy(&self) -> bool {
        !matches!(self, Self::Custom(_))
    }

    pub fn is_namespaced(&self) -> bool {
        matches!(self, Self::Custom(value) if value.contains('.'))
    }

    pub fn custom(value: impl Into<String>) -> Result<Self, String> {
        value.into().parse()
    }

    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Custom(value) => {
                validate_extension_id(value)?;
                if matches!(
                    value.as_str(),
                    "login"
                        | "note"
                        | "card"
                        | "identity"
                        | "totp"
                        | "passkey"
                        | "ssh-key"
                        | "api-token"
                        | "document-ref"
                ) {
                    return Err("legacy object type IDs must use their legacy variant".to_string());
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

impl std::fmt::Display for ObjectTypeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for ObjectTypeId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "login" => Ok(Self::Login),
            "note" => Ok(Self::Note),
            "card" => Ok(Self::Card),
            "identity" => Ok(Self::Identity),
            "totp" => Ok(Self::Totp),
            "passkey" => Ok(Self::Passkey),
            "ssh-key" => Ok(Self::SshKey),
            "api-token" => Ok(Self::ApiToken),
            "document-ref" => Ok(Self::DocumentRef),
            value => {
                validate_extension_id(value)?;
                Ok(Self::Custom(value.to_string()))
            }
        }
    }
}

impl Serialize for ObjectTypeId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ObjectTypeId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}

pub(crate) fn validate_extension_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 {
        return Err("object type ID must contain 1 to 128 bytes".to_string());
    }
    let bytes = value.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() || !bytes[bytes.len() - 1].is_ascii_alphanumeric() {
        return Err("object type ID must start and end with an ASCII letter or digit".to_string());
    }
    if !bytes.iter().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
    }) {
        return Err(
            "object type ID may contain lowercase ASCII letters, digits, '.', '-' and '_'"
                .to_string(),
        );
    }
    if value.contains("..") {
        return Err("object type ID contains an empty namespace segment".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_summary_roundtrips_without_payload_field() {
        let summary = ObjectSummary {
            object_id: "object-1".to_string(),
            collection_id: "collection-1".to_string(),
            object_type_id: ObjectTypeId::custom("com.monica.mail.message").unwrap(),
            title: Some(b"message".to_vec()),
            payload_schema_version: 3,
            head_commit_id: "commit-1".to_string(),
            deleted: false,
            updated_at: "2026-07-20T00:00:00Z".to_string(),
        };
        let encoded = serde_json::to_value(&summary).unwrap();
        assert!(encoded.get("payload").is_none());
        assert!(encoded.get("payload_ct").is_none());
        assert_eq!(
            serde_json::from_value::<ObjectSummary>(encoded).unwrap(),
            summary
        );
    }

    #[test]
    fn legacy_entry_types_keep_their_names() {
        for value in [
            ObjectTypeId::Login,
            ObjectTypeId::Note,
            ObjectTypeId::Card,
            ObjectTypeId::Identity,
            ObjectTypeId::Totp,
            ObjectTypeId::Passkey,
            ObjectTypeId::SshKey,
            ObjectTypeId::ApiToken,
            ObjectTypeId::DocumentRef,
        ] {
            let encoded = serde_json::to_string(&value).unwrap();
            let decoded: ObjectTypeId = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded, value);
            assert!(decoded.is_legacy());
        }
    }

    #[test]
    fn namespaced_object_type_roundtrips_exactly() {
        let value: ObjectTypeId = "com.monica.mail.message".parse().unwrap();
        assert_eq!(value.as_str(), "com.monica.mail.message");
        assert!(value.is_namespaced());
        assert_eq!(
            serde_json::from_str::<ObjectTypeId>(&serde_json::to_string(&value).unwrap()).unwrap(),
            value
        );
    }

    #[test]
    fn invalid_object_type_ids_are_rejected() {
        for value in ["", ".mail", "mail.", "Mail", "mail/type", "mail..message"] {
            assert!(value.parse::<ObjectTypeId>().is_err(), "accepted {value}");
        }
    }

    #[test]
    fn manually_constructed_custom_types_are_validated_before_storage() {
        assert!(ObjectTypeId::Custom("Mail".to_string()).validate().is_err());
        assert!(ObjectTypeId::Custom("login".to_string())
            .validate()
            .is_err());
        assert!(ObjectTypeId::Custom("com.monica.bookmark".to_string())
            .validate()
            .is_ok());
    }
}
