use crate::error::{StorageError, StorageResult};

pub(super) fn merge_value<T: Clone + PartialEq>(base: &T, local: &T, incoming: &T) -> Option<T> {
    if local == incoming || incoming == base {
        Some(local.clone())
    } else if local == base && incoming != base {
        Some(incoming.clone())
    } else {
        None
    }
}

pub(super) fn bump_object_clock(clock: &str) -> String {
    let counter: u64 = serde_json::from_str::<serde_json::Value>(clock)
        .ok()
        .and_then(|value| value.get("counter")?.as_u64())
        .unwrap_or(0);
    format!(r#"{{"counter":{}}}"#, counter + 1)
}

pub(super) fn validate_payload_schema_version(value: u32) -> StorageResult<()> {
    if value == 0 {
        return Err(StorageError::Validation(
            "payload_schema_version must be greater than zero".to_string(),
        ));
    }
    Ok(())
}
