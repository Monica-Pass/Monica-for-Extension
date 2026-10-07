use std::collections::BTreeSet;
#[cfg(feature = "kdbx-binary-import")]
use std::io::Read;

#[cfg(feature = "kdbx-binary-export")]
use std::io::Write;

#[cfg(feature = "kdbx-binary-import")]
use keepass::config::DatabaseVersion;
use keepass::db::{fields, GroupId};
#[cfg(feature = "kdbx-binary-export")]
use keepass::db::{EntryId, Value};
#[cfg(feature = "kdbx-binary-import")]
use keepass::db::{GroupRef, Icon};
use keepass::{Database, DatabaseKey};

use crate::error::{StorageError, StorageResult};
#[cfg(feature = "kdbx-binary-import")]
use crate::import::KdbxAttachment;
use crate::import::KdbxEntry;

pub const DEFAULT_MAX_KDBX_FILE_BYTES: usize = 128 * 1024 * 1024;
pub const HARD_MAX_KDBX_FILE_BYTES: usize = 512 * 1024 * 1024;
pub const DEFAULT_MAX_KDBX_ENTRIES: usize = 100_000;
pub const HARD_MAX_KDBX_ENTRIES: usize = 1_000_000;
pub const DEFAULT_MAX_KDBX_FIELD_BYTES: usize = 1024 * 1024;
pub const HARD_MAX_KDBX_FIELD_BYTES: usize = 16 * 1024 * 1024;
pub const DEFAULT_MAX_KDBX_ATTACHMENT_BYTES: usize = 96 * 1024 * 1024;
pub const HARD_MAX_KDBX_ATTACHMENT_BYTES: usize = 256 * 1024 * 1024;
pub const DEFAULT_MAX_KDBX_TOTAL_DECODED_BYTES: usize = 256 * 1024 * 1024;
pub const HARD_MAX_KDBX_TOTAL_DECODED_BYTES: usize = 1024 * 1024 * 1024;
pub const MAX_KDBX_FIELDS_PER_ENTRY: usize = 256;
pub const MAX_KDBX_ATTACHMENTS_PER_ENTRY: usize = 256;
pub const MAX_KDBX_GROUP_DEPTH: usize = 64;
pub const DEFAULT_MAX_KDBX_AES_ROUNDS: u64 = 10_000_000;
pub const HARD_MAX_KDBX_AES_ROUNDS: u64 = 1_000_000_000;
pub const DEFAULT_MAX_KDBX_ARGON2_MEMORY_BYTES: u64 = 1024 * 1024 * 1024;
pub const HARD_MAX_KDBX_ARGON2_MEMORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const DEFAULT_MAX_KDBX_ARGON2_ITERATIONS: u64 = 100;
pub const HARD_MAX_KDBX_ARGON2_ITERATIONS: u64 = 10_000;
pub const DEFAULT_MAX_KDBX_ARGON2_PARALLELISM: u32 = 64;
pub const HARD_MAX_KDBX_ARGON2_PARALLELISM: u32 = 256;

#[cfg(feature = "kdbx-binary-import")]
const MAX_KDBX_HEADER_FIELD_BYTES: usize = 1024 * 1024;
#[cfg(feature = "kdbx-binary-import")]
const MAX_KDBX_HEADER_FIELDS: usize = 64;
#[cfg(feature = "kdbx-binary-import")]
const MAX_KDBX_VARIANT_FIELDS: usize = 64;
#[cfg(feature = "kdbx-binary-import")]
const MAX_KDBX_VARIANT_KEY_BYTES: usize = 128;
#[cfg(feature = "kdbx-binary-import")]
const KDBX4_KDF_PARAMETERS_FIELD: u8 = 11;
#[cfg(feature = "kdbx-binary-import")]
const KDBX3_TRANSFORM_ROUNDS_FIELD: u8 = 6;
#[cfg(feature = "kdbx-binary-import")]
const KDBX_HEADER_END: u8 = 0;
#[cfg(feature = "kdbx-binary-import")]
const KDF_AES_KDBX3: [u8; 16] = [
    0xc9, 0xd9, 0xf3, 0x9a, 0x62, 0x8a, 0x44, 0x60, 0xbf, 0x74, 0x0d, 0x08, 0xc1, 0x8a, 0x4f, 0xea,
];
#[cfg(feature = "kdbx-binary-import")]
const KDF_AES_KDBX4: [u8; 16] = [
    0x7c, 0x02, 0xbb, 0x82, 0x79, 0xa7, 0x4a, 0xc0, 0x92, 0x7d, 0x11, 0x4a, 0x00, 0x64, 0x82, 0x38,
];
#[cfg(feature = "kdbx-binary-import")]
const KDF_ARGON2D: [u8; 16] = [
    0xef, 0x63, 0x6d, 0xdf, 0x8c, 0x29, 0x44, 0x4b, 0x91, 0xf7, 0xa9, 0xa4, 0x03, 0xe3, 0x0a, 0x0c,
];
#[cfg(feature = "kdbx-binary-import")]
const KDF_ARGON2ID: [u8; 16] = [
    0x9e, 0x29, 0x8b, 0x19, 0x56, 0xdb, 0x47, 0x73, 0xb2, 0x3d, 0xfc, 0x3e, 0xc6, 0xf0, 0xa1, 0xe6,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdbxBinaryLimits {
    pub max_file_bytes: usize,
    pub max_entries: usize,
    pub max_field_bytes: usize,
    pub max_attachment_bytes: usize,
    pub max_total_decoded_bytes: usize,
    pub max_aes_kdf_rounds: u64,
    pub max_argon2_memory_bytes: u64,
    pub max_argon2_iterations: u64,
    pub max_argon2_parallelism: u32,
}

impl Default for KdbxBinaryLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: DEFAULT_MAX_KDBX_FILE_BYTES,
            max_entries: DEFAULT_MAX_KDBX_ENTRIES,
            max_field_bytes: DEFAULT_MAX_KDBX_FIELD_BYTES,
            max_attachment_bytes: DEFAULT_MAX_KDBX_ATTACHMENT_BYTES,
            max_total_decoded_bytes: DEFAULT_MAX_KDBX_TOTAL_DECODED_BYTES,
            max_aes_kdf_rounds: DEFAULT_MAX_KDBX_AES_ROUNDS,
            max_argon2_memory_bytes: DEFAULT_MAX_KDBX_ARGON2_MEMORY_BYTES,
            max_argon2_iterations: DEFAULT_MAX_KDBX_ARGON2_ITERATIONS,
            max_argon2_parallelism: DEFAULT_MAX_KDBX_ARGON2_PARALLELISM,
        }
    }
}

impl KdbxBinaryLimits {
    pub fn validate(self) -> StorageResult<Self> {
        validate_positive_bound(
            "KDBX file bytes",
            self.max_file_bytes,
            HARD_MAX_KDBX_FILE_BYTES,
        )?;
        validate_positive_bound("KDBX entries", self.max_entries, HARD_MAX_KDBX_ENTRIES)?;
        validate_positive_bound(
            "KDBX field bytes",
            self.max_field_bytes,
            HARD_MAX_KDBX_FIELD_BYTES,
        )?;
        validate_positive_bound(
            "KDBX attachment bytes",
            self.max_attachment_bytes,
            HARD_MAX_KDBX_ATTACHMENT_BYTES,
        )?;
        validate_positive_bound(
            "KDBX decoded bytes",
            self.max_total_decoded_bytes,
            HARD_MAX_KDBX_TOTAL_DECODED_BYTES,
        )?;
        validate_u64_bound(
            "KDBX AES KDF rounds",
            self.max_aes_kdf_rounds,
            HARD_MAX_KDBX_AES_ROUNDS,
        )?;
        validate_u64_bound(
            "KDBX Argon2 memory bytes",
            self.max_argon2_memory_bytes,
            HARD_MAX_KDBX_ARGON2_MEMORY_BYTES,
        )?;
        validate_u64_bound(
            "KDBX Argon2 iterations",
            self.max_argon2_iterations,
            HARD_MAX_KDBX_ARGON2_ITERATIONS,
        )?;
        if self.max_argon2_parallelism == 0
            || self.max_argon2_parallelism > HARD_MAX_KDBX_ARGON2_PARALLELISM
        {
            return Err(StorageError::Validation(format!(
                "KDBX Argon2 parallelism must be between 1 and {HARD_MAX_KDBX_ARGON2_PARALLELISM}"
            )));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone)]
pub struct KdbxBinaryDocument {
    pub format_version: String,
    pub entries: Vec<KdbxEntry>,
}

pub struct KdbxBinaryAdapter;

impl KdbxBinaryAdapter {
    #[cfg(feature = "kdbx-binary-import")]
    pub fn decode(
        source: &mut dyn Read,
        password: &str,
        limits: KdbxBinaryLimits,
    ) -> StorageResult<KdbxBinaryDocument> {
        let limits = limits.validate()?;
        let mut bounded = source.take((limits.max_file_bytes as u64).saturating_add(1));
        let mut bytes = Vec::new();
        bounded.read_to_end(&mut bytes)?;
        if bytes.len() > limits.max_file_bytes {
            return Err(StorageError::Validation(format!(
                "KDBX file exceeds {} bytes",
                limits.max_file_bytes
            )));
        }

        let format_version = preflight_kdbx(&bytes, limits)?;
        let database = Database::parse(&bytes, DatabaseKey::new().with_password(password))
            .map_err(|error| StorageError::Validation(format!("failed to open KDBX: {error}")))?;
        let entries = project_database(&database, limits)?;
        Ok(KdbxBinaryDocument {
            format_version,
            entries,
        })
    }

    #[cfg(feature = "kdbx-binary-export")]
    pub fn encode(
        entries: &[KdbxEntry],
        password: &str,
        limits: KdbxBinaryLimits,
    ) -> StorageResult<Vec<u8>> {
        let limits = limits.validate()?;
        if password.is_empty() {
            return Err(StorageError::Validation(
                "KDBX export password must not be empty".to_string(),
            ));
        }
        validate_projection(entries, limits)?;
        let database = build_database(entries)?;
        let mut writer = BoundedVecWriter::new(limits.max_file_bytes);
        let result = database.save(&mut writer, DatabaseKey::new().with_password(password));
        if writer.exceeded {
            return Err(StorageError::Validation(format!(
                "encoded KDBX exceeds {} bytes",
                limits.max_file_bytes
            )));
        }
        result.map_err(|error| {
            StorageError::Validation(format!("failed to encode KDBX4: {error}"))
        })?;
        Ok(writer.bytes)
    }
}

#[cfg(feature = "kdbx-binary-import")]
fn project_database(
    database: &Database,
    limits: KdbxBinaryLimits,
) -> StorageResult<Vec<KdbxEntry>> {
    let recycle_bin = database.recycle_bin().map(|group| group.id());
    let root = database.root();
    let mut state = ProjectionState {
        entries: Vec::new(),
        decoded_bytes: 0,
        limits,
    };
    project_group(&root, &mut Vec::new(), recycle_bin, true, &mut state)?;
    Ok(state.entries)
}

#[cfg(feature = "kdbx-binary-import")]
struct ProjectionState {
    entries: Vec<KdbxEntry>,
    decoded_bytes: usize,
    limits: KdbxBinaryLimits,
}

#[cfg(feature = "kdbx-binary-import")]
fn project_group(
    group: &GroupRef<'_>,
    path: &mut Vec<String>,
    recycle_bin: Option<GroupId>,
    is_root: bool,
    state: &mut ProjectionState,
) -> StorageResult<()> {
    if path.len() > MAX_KDBX_GROUP_DEPTH {
        return Err(StorageError::Validation(format!(
            "KDBX group depth exceeds {MAX_KDBX_GROUP_DEPTH}"
        )));
    }
    if !is_root {
        add_decoded_bytes(&mut state.decoded_bytes, group.name.len(), state.limits)?;
    }

    for entry in group.entries() {
        if state.entries.len() >= state.limits.max_entries {
            return Err(StorageError::Validation(format!(
                "KDBX entry count exceeds {}",
                state.limits.max_entries
            )));
        }
        let projected = project_entry(&entry, path, state)?;
        state.entries.push(projected);
    }

    for child in group.groups() {
        if recycle_bin == Some(child.id()) {
            continue;
        }
        if child.name.is_empty() {
            return Err(StorageError::Validation(
                "KDBX group names must not be empty".to_string(),
            ));
        }
        path.push(child.name.clone());
        project_group(&child, path, recycle_bin, false, state)?;
        path.pop();
    }
    Ok(())
}

#[cfg(feature = "kdbx-binary-import")]
fn project_entry(
    entry: &keepass::db::EntryRef<'_>,
    path: &[String],
    state: &mut ProjectionState,
) -> StorageResult<KdbxEntry> {
    if entry.fields.len() > MAX_KDBX_FIELDS_PER_ENTRY {
        return Err(StorageError::Validation(format!(
            "KDBX entry {} has more than {MAX_KDBX_FIELDS_PER_ENTRY} fields",
            entry.id()
        )));
    }
    let mut custom_fields = entry
        .fields
        .iter()
        .filter(|(key, _)| !is_known_field(key))
        .map(|(key, value)| (key.clone(), value.get().clone()))
        .collect::<Vec<_>>();
    custom_fields.sort_by(|left, right| left.0.cmp(&right.0));

    let mut attachments = entry
        .attachments_named()
        .map(|(name, attachment)| KdbxAttachment {
            name: name.to_string(),
            data: attachment.data.get().clone(),
        })
        .collect::<Vec<_>>();
    attachments.sort_by(|left, right| left.name.cmp(&right.name));

    let projected = KdbxEntry {
        uuid: entry.id().to_string(),
        title: entry.get_title().unwrap_or_default().to_string(),
        username: entry.get_username().unwrap_or_default().to_string(),
        password: entry.get_password().unwrap_or_default().to_string(),
        url: entry.get_url().unwrap_or_default().to_string(),
        notes: entry.get(fields::NOTES).unwrap_or_default().to_string(),
        totp_seed: entry.get_raw_otp_value().map(str::to_string),
        custom_fields,
        attachments,
        group_path: path.to_vec(),
        icon_id: match entry.icon() {
            Some(Icon::BuiltIn(icon)) => u32::try_from(*icon).ok(),
            _ => None,
        },
        created_at: format_time(entry.times.creation),
        updated_at: format_time(entry.times.last_modification),
    };
    validate_entry_projection(&projected, state.limits, &mut state.decoded_bytes)?;
    Ok(projected)
}

fn is_known_field(key: &str) -> bool {
    matches!(
        key,
        fields::TITLE
            | fields::USERNAME
            | fields::PASSWORD
            | fields::URL
            | fields::NOTES
            | fields::OTP
    )
}

#[cfg(feature = "kdbx-binary-import")]
fn format_time(value: Option<chrono::NaiveDateTime>) -> String {
    value
        .map(|time| {
            time.and_utc()
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        })
        .unwrap_or_default()
}

#[cfg(feature = "kdbx-binary-export")]
fn validate_projection(entries: &[KdbxEntry], limits: KdbxBinaryLimits) -> StorageResult<()> {
    if entries.len() > limits.max_entries {
        return Err(StorageError::Validation(format!(
            "KDBX entry count exceeds {}",
            limits.max_entries
        )));
    }
    let mut decoded_bytes = 0usize;
    let mut ids = BTreeSet::new();
    for entry in entries {
        if !ids.insert(entry.uuid.as_str()) {
            return Err(StorageError::Validation(format!(
                "duplicate KDBX entry UUID {}",
                entry.uuid
            )));
        }
        validate_entry_projection(entry, limits, &mut decoded_bytes)?;
    }
    Ok(())
}

fn validate_entry_projection(
    entry: &KdbxEntry,
    limits: KdbxBinaryLimits,
    decoded_bytes: &mut usize,
) -> StorageResult<()> {
    if entry.group_path.len() > MAX_KDBX_GROUP_DEPTH {
        return Err(StorageError::Validation(format!(
            "KDBX group depth exceeds {MAX_KDBX_GROUP_DEPTH}"
        )));
    }
    if entry.custom_fields.len().saturating_add(6) > MAX_KDBX_FIELDS_PER_ENTRY {
        return Err(StorageError::Validation(format!(
            "KDBX entry {} has too many fields",
            entry.uuid
        )));
    }
    if entry.attachments.len() > MAX_KDBX_ATTACHMENTS_PER_ENTRY {
        return Err(StorageError::Validation(format!(
            "KDBX entry {} has too many attachments",
            entry.uuid
        )));
    }

    let mut custom_keys = BTreeSet::new();
    for (key, value) in &entry.custom_fields {
        if key.is_empty() || is_known_field(key) || !custom_keys.insert(key.as_str()) {
            return Err(StorageError::Validation(format!(
                "KDBX entry {} has an invalid or duplicate custom field",
                entry.uuid
            )));
        }
        validate_field(key, limits)?;
        validate_field(value, limits)?;
        add_decoded_bytes(decoded_bytes, key.len(), limits)?;
        add_decoded_bytes(decoded_bytes, value.len(), limits)?;
    }

    for field in [
        entry.uuid.as_str(),
        entry.title.as_str(),
        entry.username.as_str(),
        entry.password.as_str(),
        entry.url.as_str(),
        entry.notes.as_str(),
        entry.created_at.as_str(),
        entry.updated_at.as_str(),
    ] {
        validate_field(field, limits)?;
        add_decoded_bytes(decoded_bytes, field.len(), limits)?;
    }
    if let Some(otp) = &entry.totp_seed {
        validate_field(otp, limits)?;
        add_decoded_bytes(decoded_bytes, otp.len(), limits)?;
    }
    for component in &entry.group_path {
        if component.is_empty() {
            return Err(StorageError::Validation(
                "KDBX group path components must not be empty".to_string(),
            ));
        }
        validate_field(component, limits)?;
        add_decoded_bytes(decoded_bytes, component.len(), limits)?;
    }

    let mut attachment_names = BTreeSet::new();
    for attachment in &entry.attachments {
        if attachment.name.is_empty() || !attachment_names.insert(attachment.name.as_str()) {
            return Err(StorageError::Validation(format!(
                "KDBX entry {} has an invalid or duplicate attachment name",
                entry.uuid
            )));
        }
        validate_field(&attachment.name, limits)?;
        if attachment.data.len() > limits.max_attachment_bytes {
            return Err(StorageError::Validation(format!(
                "KDBX attachment '{}' exceeds {} bytes",
                attachment.name, limits.max_attachment_bytes
            )));
        }
        add_decoded_bytes(decoded_bytes, attachment.name.len(), limits)?;
        add_decoded_bytes(decoded_bytes, attachment.data.len(), limits)?;
    }
    Ok(())
}

fn validate_field(value: &str, limits: KdbxBinaryLimits) -> StorageResult<()> {
    if value.len() > limits.max_field_bytes {
        return Err(StorageError::Validation(format!(
            "KDBX field exceeds {} bytes",
            limits.max_field_bytes
        )));
    }
    Ok(())
}

fn add_decoded_bytes(
    current: &mut usize,
    additional: usize,
    limits: KdbxBinaryLimits,
) -> StorageResult<()> {
    *current = current
        .checked_add(additional)
        .ok_or_else(|| StorageError::Validation("KDBX decoded byte count overflow".to_string()))?;
    if *current > limits.max_total_decoded_bytes {
        return Err(StorageError::Validation(format!(
            "KDBX decoded data exceeds {} bytes",
            limits.max_total_decoded_bytes
        )));
    }
    Ok(())
}

#[cfg(feature = "kdbx-binary-export")]
fn build_database(entries: &[KdbxEntry]) -> StorageResult<Database> {
    let mut database = Database::new();
    database.root_mut().name = "MDBX Export".to_string();
    database.config.kdf_config = keepass::config::KdfConfig::Argon2id {
        iterations: 3,
        memory: 64 * 1024 * 1024,
        parallelism: 2,
        version: keepass_argon2::Version::Version13,
    };

    for source in entries {
        let group_id = ensure_group_path(&mut database, &source.group_path)?;
        let uuid = uuid::Uuid::parse_str(&source.uuid).map_err(|_| {
            StorageError::Validation(format!("invalid KDBX entry UUID {}", source.uuid))
        })?;
        let mut group = database
            .group_mut(group_id)
            .ok_or_else(|| StorageError::Validation("KDBX target group disappeared".to_string()))?;
        let mut entry = group
            .add_entry_with_id(EntryId::from(uuid))
            .map_err(|error| StorageError::Validation(error.to_string()))?;
        entry.set_unprotected(fields::TITLE, &source.title);
        entry.set_unprotected(fields::USERNAME, &source.username);
        entry.set_protected(fields::PASSWORD, &source.password);
        entry.set_unprotected(fields::URL, &source.url);
        entry.set_unprotected(fields::NOTES, &source.notes);
        if let Some(otp) = &source.totp_seed {
            entry.set_protected(fields::OTP, otp);
        }
        for (key, value) in &source.custom_fields {
            entry.set_protected(key, value);
        }
        for attachment in &source.attachments {
            entry.add_attachment(&attachment.name, Value::protected(attachment.data.clone()));
        }
        if let Some(icon_id) = source.icon_id {
            entry.set_icon_builtin(icon_id as usize);
        }
        entry.times.creation = parse_time(&source.created_at)?;
        entry.times.last_modification = parse_time(&source.updated_at)?;
    }
    Ok(database)
}

#[cfg(feature = "kdbx-binary-export")]
fn ensure_group_path(database: &mut Database, path: &[String]) -> StorageResult<GroupId> {
    let mut current = database.root().id();
    for component in path {
        let existing = database.group(current).and_then(|group| {
            group
                .groups()
                .find_map(|child| (child.name == *component).then(|| child.id()))
        });
        current = if let Some(group_id) = existing {
            group_id
        } else {
            let mut parent = database.group_mut(current).ok_or_else(|| {
                StorageError::Validation("KDBX parent group disappeared".to_string())
            })?;
            let mut child = parent.add_group();
            child.name = component.clone();
            child.id()
        };
    }
    Ok(current)
}

#[cfg(feature = "kdbx-binary-export")]
fn parse_time(value: &str) -> StorageResult<Option<chrono::NaiveDateTime>> {
    if value.is_empty() {
        return Ok(None);
    }
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|time| Some(time.naive_utc()))
        .map_err(|error| StorageError::Validation(format!("invalid KDBX timestamp: {error}")))
}

#[cfg(feature = "kdbx-binary-import")]
fn preflight_kdbx(bytes: &[u8], limits: KdbxBinaryLimits) -> StorageResult<String> {
    let version = DatabaseVersion::parse(bytes)
        .map_err(|error| StorageError::Validation(format!("invalid KDBX header: {error}")))?;
    match version {
        DatabaseVersion::KDB3(_) => preflight_kdbx3(bytes, limits)?,
        DatabaseVersion::KDB4(_) => preflight_kdbx4(bytes, limits)?,
        _ => {
            return Err(StorageError::Validation(
                "binary Adapter supports KDBX3 and KDBX4 only".to_string(),
            ))
        }
    }
    Ok(version.to_string())
}

#[cfg(feature = "kdbx-binary-import")]
fn preflight_kdbx3(bytes: &[u8], limits: KdbxBinaryLimits) -> StorageResult<()> {
    let mut position = 12usize;
    let mut rounds = None;
    let mut fields = 0usize;
    loop {
        fields = fields.saturating_add(1);
        if fields > MAX_KDBX_HEADER_FIELDS {
            return Err(StorageError::Validation(
                "KDBX3 header has too many fields".to_string(),
            ));
        }
        let field_id = read_u8(bytes, &mut position)?;
        let length = read_u16(bytes, &mut position)? as usize;
        let value = read_slice(bytes, &mut position, length)?;
        if length > MAX_KDBX_HEADER_FIELD_BYTES {
            return Err(StorageError::Validation(
                "KDBX3 header field exceeds the supported bound".to_string(),
            ));
        }
        if field_id == KDBX3_TRANSFORM_ROUNDS_FIELD {
            if value.len() != 8 {
                return Err(StorageError::Validation(
                    "KDBX3 transform rounds field has an invalid length".to_string(),
                ));
            }
            rounds = Some(u64::from_le_bytes(value.try_into().map_err(|_| {
                StorageError::Validation("invalid KDBX3 transform rounds".to_string())
            })?));
        }
        if field_id == KDBX_HEADER_END {
            break;
        }
    }
    let rounds = rounds.ok_or_else(|| {
        StorageError::Validation("KDBX3 header is missing transform rounds".to_string())
    })?;
    if rounds == 0 || rounds > limits.max_aes_kdf_rounds {
        return Err(StorageError::Validation(format!(
            "KDBX3 AES KDF rounds {rounds} exceed the configured limit {}",
            limits.max_aes_kdf_rounds
        )));
    }
    Ok(())
}

#[cfg(feature = "kdbx-binary-import")]
fn preflight_kdbx4(bytes: &[u8], limits: KdbxBinaryLimits) -> StorageResult<()> {
    let mut position = 12usize;
    let mut kdf_parameters = None;
    let mut fields = 0usize;
    loop {
        fields = fields.saturating_add(1);
        if fields > MAX_KDBX_HEADER_FIELDS {
            return Err(StorageError::Validation(
                "KDBX4 header has too many fields".to_string(),
            ));
        }
        let field_id = read_u8(bytes, &mut position)?;
        let length = read_u32(bytes, &mut position)? as usize;
        let value = read_slice(bytes, &mut position, length)?;
        if length > MAX_KDBX_HEADER_FIELD_BYTES {
            return Err(StorageError::Validation(
                "KDBX4 header field exceeds the supported bound".to_string(),
            ));
        }
        if field_id == KDBX4_KDF_PARAMETERS_FIELD {
            kdf_parameters = Some(value);
        }
        if field_id == KDBX_HEADER_END {
            break;
        }
    }
    let parameters = kdf_parameters.ok_or_else(|| {
        StorageError::Validation("KDBX4 header is missing KDF parameters".to_string())
    })?;
    validate_kdbx4_kdf(parameters, limits)
}

#[cfg(feature = "kdbx-binary-import")]
fn validate_kdbx4_kdf(bytes: &[u8], limits: KdbxBinaryLimits) -> StorageResult<()> {
    if read_u16_at(bytes, 0)? != 0x0100 {
        return Err(StorageError::Validation(
            "KDBX4 KDF dictionary has an unsupported version".to_string(),
        ));
    }
    let mut position = 2usize;
    let mut fields = 0usize;
    let mut uuid = None;
    let mut memory = None;
    let mut iterations = None;
    let mut parallelism = None;
    let mut rounds = None;
    loop {
        let value_type = read_u8(bytes, &mut position)?;
        if value_type == 0 {
            if position != bytes.len() {
                return Err(StorageError::Validation(
                    "KDBX4 KDF dictionary has trailing bytes".to_string(),
                ));
            }
            break;
        }
        fields = fields.saturating_add(1);
        if fields > MAX_KDBX_VARIANT_FIELDS {
            return Err(StorageError::Validation(
                "KDBX4 KDF dictionary has too many fields".to_string(),
            ));
        }
        let key_length = read_u32(bytes, &mut position)? as usize;
        if key_length == 0 || key_length > MAX_KDBX_VARIANT_KEY_BYTES {
            return Err(StorageError::Validation(
                "KDBX4 KDF dictionary key length is invalid".to_string(),
            ));
        }
        let key = std::str::from_utf8(read_slice(bytes, &mut position, key_length)?)
            .map_err(|_| StorageError::Validation("KDBX4 KDF key is not UTF-8".to_string()))?;
        let value_length = read_u32(bytes, &mut position)? as usize;
        if value_length > MAX_KDBX_HEADER_FIELD_BYTES {
            return Err(StorageError::Validation(
                "KDBX4 KDF value exceeds the supported bound".to_string(),
            ));
        }
        let value = read_slice(bytes, &mut position, value_length)?;
        match key {
            "$UUID" if value_type == 0x42 && value.len() == 16 => {
                uuid =
                    Some(<[u8; 16]>::try_from(value).map_err(|_| {
                        StorageError::Validation("invalid KDBX4 KDF UUID".to_string())
                    })?);
            }
            "M" if value_type == 0x05 && value.len() == 8 => {
                memory = Some(u64::from_le_bytes(value.try_into().map_err(|_| {
                    StorageError::Validation("invalid KDBX4 Argon2 memory".to_string())
                })?));
            }
            "I" if value_type == 0x05 && value.len() == 8 => {
                iterations = Some(u64::from_le_bytes(value.try_into().map_err(|_| {
                    StorageError::Validation("invalid KDBX4 Argon2 iterations".to_string())
                })?));
            }
            "P" if value_type == 0x04 && value.len() == 4 => {
                parallelism = Some(u32::from_le_bytes(value.try_into().map_err(|_| {
                    StorageError::Validation("invalid KDBX4 Argon2 parallelism".to_string())
                })?));
            }
            "R" if value_type == 0x05 && value.len() == 8 => {
                rounds = Some(u64::from_le_bytes(value.try_into().map_err(|_| {
                    StorageError::Validation("invalid KDBX4 AES rounds".to_string())
                })?));
            }
            _ => {}
        }
    }

    match uuid.ok_or_else(|| StorageError::Validation("KDBX4 KDF UUID is missing".to_string()))? {
        KDF_AES_KDBX3 | KDF_AES_KDBX4 => {
            let rounds = rounds.ok_or_else(|| {
                StorageError::Validation("KDBX4 AES KDF rounds are missing".to_string())
            })?;
            if rounds == 0 || rounds > limits.max_aes_kdf_rounds {
                return Err(StorageError::Validation(format!(
                    "KDBX4 AES KDF rounds {rounds} exceed the configured limit {}",
                    limits.max_aes_kdf_rounds
                )));
            }
        }
        KDF_ARGON2D | KDF_ARGON2ID => {
            let memory = memory.ok_or_else(|| {
                StorageError::Validation("KDBX4 Argon2 memory is missing".to_string())
            })?;
            let iterations = iterations.ok_or_else(|| {
                StorageError::Validation("KDBX4 Argon2 iterations are missing".to_string())
            })?;
            let parallelism = parallelism.ok_or_else(|| {
                StorageError::Validation("KDBX4 Argon2 parallelism is missing".to_string())
            })?;
            if memory == 0 || memory > limits.max_argon2_memory_bytes {
                return Err(StorageError::Validation(format!(
                    "KDBX4 Argon2 memory {memory} exceeds the configured limit {}",
                    limits.max_argon2_memory_bytes
                )));
            }
            if iterations == 0 || iterations > limits.max_argon2_iterations {
                return Err(StorageError::Validation(format!(
                    "KDBX4 Argon2 iterations {iterations} exceed the configured limit {}",
                    limits.max_argon2_iterations
                )));
            }
            if parallelism == 0 || parallelism > limits.max_argon2_parallelism {
                return Err(StorageError::Validation(format!(
                    "KDBX4 Argon2 parallelism {parallelism} exceeds the configured limit {}",
                    limits.max_argon2_parallelism
                )));
            }
        }
        _ => {
            return Err(StorageError::Validation(
                "KDBX4 uses an unsupported KDF".to_string(),
            ))
        }
    }
    Ok(())
}

#[cfg(feature = "kdbx-binary-import")]
fn read_u8(bytes: &[u8], position: &mut usize) -> StorageResult<u8> {
    let value = *bytes
        .get(*position)
        .ok_or_else(|| StorageError::Validation("unexpected end of KDBX header".to_string()))?;
    *position = (*position).saturating_add(1);
    Ok(value)
}

#[cfg(feature = "kdbx-binary-import")]
fn read_u16(bytes: &[u8], position: &mut usize) -> StorageResult<u16> {
    let value = read_slice(bytes, position, 2)?;
    Ok(u16::from_le_bytes(value.try_into().map_err(|_| {
        StorageError::Validation("invalid KDBX u16".to_string())
    })?))
}

#[cfg(feature = "kdbx-binary-import")]
fn read_u32(bytes: &[u8], position: &mut usize) -> StorageResult<u32> {
    let value = read_slice(bytes, position, 4)?;
    Ok(u32::from_le_bytes(value.try_into().map_err(|_| {
        StorageError::Validation("invalid KDBX u32".to_string())
    })?))
}

#[cfg(feature = "kdbx-binary-import")]
fn read_u16_at(bytes: &[u8], position: usize) -> StorageResult<u16> {
    let value = bytes
        .get(position..position.saturating_add(2))
        .ok_or_else(|| StorageError::Validation("unexpected end of KDBX data".to_string()))?;
    Ok(u16::from_le_bytes(value.try_into().map_err(|_| {
        StorageError::Validation("invalid KDBX u16".to_string())
    })?))
}

#[cfg(feature = "kdbx-binary-import")]
fn read_slice<'a>(bytes: &'a [u8], position: &mut usize, length: usize) -> StorageResult<&'a [u8]> {
    let end = position
        .checked_add(length)
        .ok_or_else(|| StorageError::Validation("KDBX header length overflow".to_string()))?;
    let value = bytes
        .get(*position..end)
        .ok_or_else(|| StorageError::Validation("unexpected end of KDBX header".to_string()))?;
    *position = end;
    Ok(value)
}

fn validate_positive_bound(name: &str, value: usize, hard_max: usize) -> StorageResult<()> {
    if value == 0 || value > hard_max {
        return Err(StorageError::Validation(format!(
            "{name} must be between 1 and {hard_max}"
        )));
    }
    Ok(())
}

fn validate_u64_bound(name: &str, value: u64, hard_max: u64) -> StorageResult<()> {
    if value == 0 || value > hard_max {
        return Err(StorageError::Validation(format!(
            "{name} must be between 1 and {hard_max}"
        )));
    }
    Ok(())
}

#[cfg(feature = "kdbx-binary-export")]
struct BoundedVecWriter {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

#[cfg(feature = "kdbx-binary-export")]
impl BoundedVecWriter {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            exceeded: false,
        }
    }
}

#[cfg(feature = "kdbx-binary-export")]
impl Write for BoundedVecWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let next = self.bytes.len().checked_add(buffer.len());
        if next.is_none_or(|length| length > self.limit) {
            self.exceeded = true;
            return Err(std::io::Error::other("KDBX output limit exceeded"));
        }
        self.bytes.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry() -> KdbxEntry {
        KdbxEntry {
            uuid: "2f9d3fb2-7552-4da0-8721-0cff28f83cab".to_string(),
            title: "Mail".to_string(),
            username: "alice@example.com".to_string(),
            password: "correct horse".to_string(),
            url: "https://mail.example.com".to_string(),
            notes: "primary mailbox".to_string(),
            totp_seed: Some("otpauth://totp/Mail?secret=JBSWY3DPEHPK3PXP".to_string()),
            custom_fields: vec![("Account ID".to_string(), "42".to_string())],
            attachments: vec![KdbxAttachment {
                name: "recovery.txt".to_string(),
                data: b"recovery material".to_vec(),
            }],
            group_path: vec!["Work".to_string(), "Mail".to_string()],
            icon_id: Some(19),
            created_at: "2026-07-23T00:00:00Z".to_string(),
            updated_at: "2026-07-23T00:01:00Z".to_string(),
        }
    }

    #[cfg(feature = "kdbx-binary-import")]
    #[test]
    fn kdbx_binary_imports_external_kdbx3_fixture() {
        use base64::Engine as _;

        let encoded = include_str!("../../tests/fixtures/kdbx3-demopass.kdbx.b64")
            .split_ascii_whitespace()
            .collect::<String>();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        let document = KdbxBinaryAdapter::decode(
            &mut bytes.as_slice(),
            "demopass",
            KdbxBinaryLimits::default(),
        )
        .unwrap();

        assert_eq!(document.format_version, "KDBX3.1");
        assert_eq!(document.entries.len(), 6);
        assert!(document.entries.iter().all(|entry| !entry.uuid.is_empty()));
    }

    #[cfg(feature = "kdbx-binary-import")]
    #[test]
    fn kdbx_binary_rejects_excessive_outer_header_fields() {
        let mut bytes = vec![0; 12];
        for _ in 0..=MAX_KDBX_HEADER_FIELDS {
            bytes.push(1);
            bytes.extend_from_slice(&0u32.to_le_bytes());
        }

        let error = preflight_kdbx4(&bytes, KdbxBinaryLimits::default()).unwrap_err();
        assert!(error.to_string().contains("too many fields"));
    }

    #[cfg(all(feature = "kdbx-binary-import", feature = "kdbx-binary-export"))]
    #[test]
    fn kdbx_binary_roundtrips_real_encrypted_bytes() {
        let original = sample_entry();
        let bytes = KdbxBinaryAdapter::encode(
            std::slice::from_ref(&original),
            "kdbx-password",
            KdbxBinaryLimits::default(),
        )
        .unwrap();
        assert_eq!(&bytes[..4], &[0x03, 0xd9, 0xa2, 0x9a]);

        let document = KdbxBinaryAdapter::decode(
            &mut bytes.as_slice(),
            "kdbx-password",
            KdbxBinaryLimits::default(),
        )
        .unwrap();
        assert!(document.format_version.starts_with("KDBX4."));
        assert_eq!(document.entries.len(), 1);
        assert_eq!(
            serde_json::to_value(&document.entries[0]).unwrap(),
            serde_json::to_value(original).unwrap()
        );
    }

    #[cfg(all(feature = "kdbx-binary-import", feature = "kdbx-binary-export"))]
    #[test]
    fn kdbx_binary_rejects_wrong_password_malformed_and_resource_limits() {
        let entry = sample_entry();
        let bytes = KdbxBinaryAdapter::encode(
            std::slice::from_ref(&entry),
            "kdbx-password",
            KdbxBinaryLimits::default(),
        )
        .unwrap();
        assert!(KdbxBinaryAdapter::decode(
            &mut bytes.as_slice(),
            "wrong-password",
            KdbxBinaryLimits::default()
        )
        .is_err());
        assert!(KdbxBinaryAdapter::decode(
            &mut b"not-kdbx".as_slice(),
            "password",
            KdbxBinaryLimits::default()
        )
        .is_err());

        let limits = KdbxBinaryLimits {
            max_file_bytes: bytes.len() - 1,
            ..KdbxBinaryLimits::default()
        };
        assert!(KdbxBinaryAdapter::decode(&mut bytes.as_slice(), "kdbx-password", limits).is_err());

        let limits = KdbxBinaryLimits {
            max_entries: 1,
            ..KdbxBinaryLimits::default()
        };
        assert!(KdbxBinaryAdapter::encode(&[entry.clone(), entry], "password", limits).is_err());
    }
}
