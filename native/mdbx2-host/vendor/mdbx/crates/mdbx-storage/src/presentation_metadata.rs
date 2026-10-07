use crate::error::{StorageError, StorageResult};

/// Maximum plaintext bytes returned for a Collection or Object display title.
pub const MAX_PRESENTATION_TITLE_BYTES: u64 = 64 * 1024;

/// Maximum plaintext bytes returned for an ObjectLabel display name.
pub const MAX_PRESENTATION_LABEL_NAME_BYTES: u64 = 512;

/// Maximum UTF-8 bytes returned for a presentation reference such as group or icon identity.
pub const MAX_PRESENTATION_REFERENCE_BYTES: u64 = 4 * 1024;

/// Maximum UTF-8 bytes returned for an attachment file name.
pub const MAX_PRESENTATION_ATTACHMENT_FILE_NAME_BYTES: u64 = 4 * 1024;

/// Maximum UTF-8 bytes returned for an attachment media type.
pub const MAX_PRESENTATION_ATTACHMENT_MEDIA_TYPE_BYTES: u64 = 512;

/// Reserved space for authenticated-encryption and field-key epoch envelopes.
///
/// Current committed AEAD adds 80 bytes, while the largest representable field-key epoch
/// envelope adds 65,545 bytes. A 128 KiB allowance keeps every bounded field projection
/// compatible with both formats and leaves room for compatible envelope evolution.
pub const FIELD_CIPHERTEXT_OVERHEAD_BYTES: u64 = 128 * 1024;

/// Fixed safety contract used by Collection, Object, and Label presentation APIs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresentationMetadataLimits {
    max_title_bytes: u64,
    max_label_name_bytes: u64,
    max_reference_bytes: u64,
}

impl PresentationMetadataLimits {
    pub fn max_title_bytes(self) -> u64 {
        self.max_title_bytes
    }

    pub fn max_label_name_bytes(self) -> u64 {
        self.max_label_name_bytes
    }

    pub fn max_reference_bytes(self) -> u64 {
        self.max_reference_bytes
    }
}

impl Default for PresentationMetadataLimits {
    fn default() -> Self {
        Self {
            max_title_bytes: MAX_PRESENTATION_TITLE_BYTES,
            max_label_name_bytes: MAX_PRESENTATION_LABEL_NAME_BYTES,
            max_reference_bytes: MAX_PRESENTATION_REFERENCE_BYTES,
        }
    }
}

pub(crate) fn max_field_ciphertext_bytes(max_plaintext_bytes: u64) -> u64 {
    max_plaintext_bytes + FIELD_CIPHERTEXT_OVERHEAD_BYTES
}

pub(crate) fn enforce_stored_ciphertext_length(
    resource: &str,
    actual: u64,
    max_plaintext_bytes: u64,
) -> StorageResult<()> {
    let limit = max_field_ciphertext_bytes(max_plaintext_bytes);
    if actual > limit {
        return Err(StorageError::ResourceLimit {
            resource: resource.to_string(),
            actual,
            limit,
        });
    }
    Ok(())
}

pub(crate) fn bounded_optional_ciphertext(
    resource: &str,
    stored_length: Option<i64>,
    bounded_value: Option<Vec<u8>>,
    max_plaintext_bytes: u64,
) -> StorageResult<Option<Vec<u8>>> {
    let Some(stored_length) = stored_length else {
        if bounded_value.is_some() {
            return Err(StorageError::Validation(format!(
                "{resource} is present without a stored length"
            )));
        }
        return Ok(None);
    };
    let actual = u64::try_from(stored_length).map_err(|_| {
        StorageError::Validation(format!("{resource} has a negative stored length"))
    })?;
    enforce_stored_ciphertext_length(resource, actual, max_plaintext_bytes)?;
    let value = bounded_value.ok_or_else(|| {
        StorageError::Validation(format!(
            "bounded projection omitted {resource} within its accepted limit"
        ))
    })?;
    if value.len() as u64 != actual {
        return Err(StorageError::Validation(format!(
            "bounded projection length mismatch for {resource}"
        )));
    }
    Ok(Some(value))
}

pub(crate) fn bounded_required_ciphertext(
    resource: &str,
    stored_length: i64,
    bounded_value: Option<Vec<u8>>,
    max_plaintext_bytes: u64,
) -> StorageResult<Vec<u8>> {
    bounded_optional_ciphertext(
        resource,
        Some(stored_length),
        bounded_value,
        max_plaintext_bytes,
    )?
    .ok_or_else(|| StorageError::Validation(format!("{resource} is required")))
}

pub(crate) fn enforce_plaintext_length(
    resource: &str,
    actual: u64,
    limit: u64,
) -> StorageResult<()> {
    if actual > limit {
        return Err(StorageError::ResourceLimit {
            resource: resource.to_string(),
            actual,
            limit,
        });
    }
    Ok(())
}

pub(crate) fn bounded_optional_text(
    resource: &str,
    stored_length: Option<i64>,
    bounded_value: Option<String>,
    limit: u64,
) -> StorageResult<Option<String>> {
    let Some(stored_length) = stored_length else {
        if bounded_value.is_some() {
            return Err(StorageError::Validation(format!(
                "{resource} is present without a stored length"
            )));
        }
        return Ok(None);
    };
    let actual = u64::try_from(stored_length).map_err(|_| {
        StorageError::Validation(format!("{resource} has a negative stored length"))
    })?;
    if actual > limit {
        return Err(StorageError::ResourceLimit {
            resource: resource.to_string(),
            actual,
            limit,
        });
    }
    let value = bounded_value.ok_or_else(|| {
        StorageError::Validation(format!(
            "bounded projection omitted {resource} within its accepted limit"
        ))
    })?;
    if value.len() as u64 != actual {
        return Err(StorageError::Validation(format!(
            "bounded projection length mismatch for {resource}"
        )));
    }
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presentation_limits_are_fixed_and_field_envelope_aware() {
        let limits = PresentationMetadataLimits::default();
        assert_eq!(limits.max_title_bytes(), 64 * 1024);
        assert_eq!(limits.max_label_name_bytes(), 512);
        assert_eq!(limits.max_reference_bytes(), 4096);
        assert_eq!(MAX_PRESENTATION_ATTACHMENT_FILE_NAME_BYTES, 4096);
        assert_eq!(MAX_PRESENTATION_ATTACHMENT_MEDIA_TYPE_BYTES, 512);
        assert_eq!(
            max_field_ciphertext_bytes(512),
            512 + FIELD_CIPHERTEXT_OVERHEAD_BYTES
        );
    }

    #[test]
    fn bounded_projection_helpers_reject_omission_and_oversize() {
        assert!(bounded_required_ciphertext("field", 3, Some(vec![1, 2, 3]), 3).is_ok());
        assert!(bounded_required_ciphertext("field", 3, None, 3).is_err());
        assert!(matches!(
            bounded_required_ciphertext(
                "field",
                (max_field_ciphertext_bytes(3) + 1) as i64,
                None,
                3,
            ),
            Err(StorageError::ResourceLimit { .. })
        ));
        assert!(
            bounded_optional_text("reference", Some(3), Some("abc".to_string()), 3)
                .unwrap()
                .is_some()
        );
    }
}
