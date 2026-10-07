pub mod policy;

pub use policy::*;

/// MDBX Tiga 三安全模式。
///
/// 优先级从低到高: Global < Project < Entry。
/// 更窄范围的覆盖优先于更宽范围的覆盖。
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "kebab-case")]
pub enum TigaMode {
    /// 更快更轻便 — 低风险环境
    Sky,
    /// 平衡默认 — 安全与可用性之间
    Multi,
    /// 最高防护 — 增强暴力破解阻力
    Power,
}

/// Tiga 对 vault 解锁方式的策略描述。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TigaUnlockPolicy {
    /// 是否允许不依赖硬件密钥的便携解锁方式。
    pub allows_portable_unlock: bool,
    /// 是否建议配置硬件密钥作为额外保护或便利入口。
    pub recommends_security_key: bool,
    /// 是否要求存在密码 + 硬件密钥组合解锁方式。
    pub requires_combined_password_security_key: bool,
}

impl TigaMode {
    /// 根据三级层次解析有效的 Tiga 模式。
    ///
    /// 优先级: entry override > project override > global default
    pub fn resolve(
        global_default: TigaMode,
        project_override: Option<TigaMode>,
        entry_override: Option<TigaMode>,
    ) -> TigaMode {
        entry_override
            .or(project_override)
            .unwrap_or(global_default)
    }

    /// 返回当前 Tiga 模式对应的 vault 解锁策略。
    pub fn unlock_policy(&self) -> TigaUnlockPolicy {
        let policy = self.policy();
        TigaUnlockPolicy {
            allows_portable_unlock: policy.unlock.portable_unlock_allowed,
            recommends_security_key: policy.unlock.security_key_recommended,
            requires_combined_password_security_key: policy.unlock.minimum_auth_factors >= 2
                && policy.unlock.security_key_required,
        }
    }
}

impl std::fmt::Display for TigaMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TigaMode::Sky => write!(f, "sky"),
            TigaMode::Multi => write!(f, "multi"),
            TigaMode::Power => write!(f, "power"),
        }
    }
}

impl std::str::FromStr for TigaMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "sky" => Ok(TigaMode::Sky),
            "multi" => Ok(TigaMode::Multi),
            "power" => Ok(TigaMode::Power),
            _ => Err(format!("unknown TigaMode: {}", s)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_global_default() {
        assert_eq!(
            TigaMode::resolve(TigaMode::Multi, None, None),
            TigaMode::Multi
        );
    }

    #[test]
    fn test_resolve_project_override() {
        assert_eq!(
            TigaMode::resolve(TigaMode::Sky, Some(TigaMode::Power), None),
            TigaMode::Power
        );
    }

    #[test]
    fn test_resolve_entry_override_wins() {
        assert_eq!(
            TigaMode::resolve(TigaMode::Sky, Some(TigaMode::Multi), Some(TigaMode::Power)),
            TigaMode::Power
        );
    }

    #[test]
    fn test_display_and_parse_roundtrip() {
        for mode in [TigaMode::Sky, TigaMode::Multi, TigaMode::Power] {
            let s = mode.to_string();
            let parsed: TigaMode = s.parse().unwrap();
            assert_eq!(mode, parsed);
        }
    }

    #[test]
    fn test_unlock_policy_sky_is_portable_not_unsafe() {
        let policy = TigaMode::Sky.unlock_policy();
        assert!(policy.allows_portable_unlock);
        assert!(!policy.requires_combined_password_security_key);
    }

    #[test]
    fn test_unlock_policy_multi_recommends_security_key() {
        let policy = TigaMode::Multi.unlock_policy();
        assert!(policy.allows_portable_unlock);
        assert!(policy.recommends_security_key);
        assert!(!policy.requires_combined_password_security_key);
    }

    #[test]
    fn test_unlock_policy_power_requires_combined_factor() {
        let policy = TigaMode::Power.unlock_policy();
        assert!(!policy.allows_portable_unlock);
        assert!(policy.recommends_security_key);
        assert!(policy.requires_combined_password_security_key);
    }
}
