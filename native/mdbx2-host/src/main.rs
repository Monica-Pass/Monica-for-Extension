mod cloud_sync;
mod runtime;

use runtime::{HostRuntime, RpcFailure, PROTOCOL_VERSION};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Read, Write};
use zeroize::Zeroize;

const MAX_INPUT_FRAME_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_FRAME_BYTES: usize = 900 * 1024;
const MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_METHOD_BYTES: usize = 128;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostRequest {
    protocol: u32,
    request_id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostResponse {
    protocol: u32,
    request_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<HostError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostError {
    code: &'static str,
    message: String,
    retryable: bool,
}

impl HostResponse {
    fn success(request_id: String, result: Value) -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            request_id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn failure(
        request_id: String,
        code: &'static str,
        message: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            request_id,
            ok: false,
            result: None,
            error: Some(HostError {
                code,
                message: bounded_message(message.into(), 512),
                retryable,
            }),
        }
    }

    fn rpc_failure(request_id: String, error: RpcFailure) -> Self {
        Self::failure(request_id, error.code, error.message, error.retryable)
    }
}

fn main() {
    let mut runtime = match HostRuntime::open_default() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("Monica MDBX2 Host could not initialize private storage: {error}");
            std::process::exit(1);
        }
    };
    let stdin = io::stdin();
    let stdout = io::stdout();
    if let Err(error) = run(stdin.lock(), stdout.lock(), &mut runtime) {
        // Native Messaging reserves stdout for framed protocol messages.
        eprintln!("Monica MDBX2 Host stopped: {error}");
        std::process::exit(1);
    }
}

fn run(mut reader: impl Read, mut writer: impl Write, runtime: &mut HostRuntime) -> io::Result<()> {
    while let Some(mut frame) = read_frame(&mut reader)? {
        let parsed = serde_json::from_slice::<HostRequest>(&frame);
        frame.zeroize();
        let response = match parsed {
            Ok(request) => process_request(request, runtime),
            Err(_) => HostResponse::failure(
                String::new(),
                "invalid-request",
                "Native request is not valid protocol JSON.",
                false,
            ),
        };
        let encoded = serde_json::to_vec(&response)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        write_frame(&mut writer, &encoded)?;
        writer.flush()?;
    }
    Ok(())
}

fn process_request(request: HostRequest, runtime: &mut HostRuntime) -> HostResponse {
    if request.protocol != PROTOCOL_VERSION {
        return HostResponse::failure(
            bounded_request_id(request.request_id),
            "protocol-version-unsupported",
            format!(
                "Native protocol {} is unsupported; expected {}.",
                request.protocol, PROTOCOL_VERSION
            ),
            false,
        );
    }
    if !valid_identifier(&request.request_id, MAX_REQUEST_ID_BYTES) {
        return HostResponse::failure(
            String::new(),
            "request-id-invalid",
            "Native request ID is invalid.",
            false,
        );
    }
    if !valid_identifier(&request.method, MAX_METHOD_BYTES) {
        return HostResponse::failure(
            request.request_id,
            "method-invalid",
            "Native method name is invalid.",
            false,
        );
    }

    let request_id = request.request_id;
    match runtime.handle(&request.method, request.params) {
        Ok(result) => HostResponse::success(request_id, result),
        Err(error) => HostResponse::rpc_failure(request_id, error),
    }
}

fn valid_identifier(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
}

fn bounded_request_id(value: String) -> String {
    if valid_identifier(&value, MAX_REQUEST_ID_BYTES) {
        value
    } else {
        String::new()
    }
}

fn bounded_message(value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut length_bytes = [0_u8; 4];
    let first = reader.read(&mut length_bytes[..1])?;
    if first == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut length_bytes[1..])?;
    let length = u32::from_ne_bytes(length_bytes) as usize;
    if length == 0 || length > MAX_INPUT_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "native input frame exceeds the reviewed limit",
        ));
    }
    let mut frame = Vec::new();
    frame
        .try_reserve_exact(length)
        .map_err(|_| io::Error::new(io::ErrorKind::OutOfMemory, "cannot allocate native frame"))?;
    frame.resize(length, 0);
    reader.read_exact(&mut frame)?;
    Ok(Some(frame))
}

fn write_frame(writer: &mut impl Write, frame: &[u8]) -> io::Result<()> {
    if frame.is_empty() || frame.len() > MAX_OUTPUT_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "native output frame exceeds the Chrome limit",
        ));
    }
    let length = u32::try_from(frame.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "native frame is too large"))?;
    writer.write_all(&length.to_ne_bytes())?;
    writer.write_all(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::io::Cursor;
    use std::path::PathBuf;
    use uuid::Uuid;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "monica-mdbx2-host-protocol-test-{}",
                Uuid::new_v4()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn runtime() -> (TestRoot, HostRuntime) {
        let root = TestRoot::new();
        let runtime = HostRuntime::new(root.0.clone()).unwrap();
        (root, runtime)
    }

    fn request(method: &str) -> HostRequest {
        HostRequest {
            protocol: PROTOCOL_VERSION,
            request_id: "request-123".to_string(),
            method: method.to_string(),
            params: json!({}),
        }
    }

    #[test]
    fn hello_reports_the_pinned_mdbx2_core_and_rejects_mdbx1() {
        let (_root, mut runtime) = runtime();
        let response = process_request(request("host.hello"), &mut runtime);
        assert!(response.ok);
        let result = response.result.expect("hello result");
        assert_eq!(result["mdbxCoreRevision"], runtime::MDBX_CORE_REVISION);
        assert_eq!(result["mdbxFormatVersion"], "MDBX-2");
        assert_eq!(result["supportsMdbx1"], false);
        assert_eq!(
            result["maxVaultHealthIssueKinds"],
            runtime::MAX_VAULT_HEALTH_ISSUE_KINDS
        );
        assert_eq!(result["supportsVaultHealthIssueKinds"], true);
        assert_eq!(result["supportsHistoryRevert"], true);
        assert_eq!(result["maxHistoryRevertItems"], 500);
        assert_eq!(result["supportsDurableCloudSync"], true);
        assert_eq!(result["maxSnapshotPageSize"], 50);
        assert_eq!(result["maxSnapshotStructurePageSize"], 100);
        assert_eq!(result["maxSnapshotResultBytes"], 850 * 1024);
        assert_eq!(result["maxSnapshotNameBytes"], 96);
        assert_eq!(result["maxSnapshotPruneCandidates"], 200);
        assert_eq!(result["maxSnapshotPruneKeepLatest"], 10_000);
        assert_eq!(result["supportsSnapshotStructure"], true);
        assert_eq!(result["supportsSnapshotMutation"], true);
        assert_eq!(result["supportsSnapshotPrune"], true);
        assert_eq!(result["maxAttachmentBytes"], runtime::MAX_ATTACHMENT_BYTES);
        assert_eq!(result["maxAttachmentPageSize"], 50);
        assert_eq!(result["maxAttachmentSessions"], 4);
        assert_eq!(result["maxAttachmentMemoryBytes"], 128 * 1024 * 1024);
        assert_eq!(result["supportsAttachmentManagement"], true);
        assert_eq!(
            result["maxSyncSegmentPageSize"],
            cloud_sync::SEGMENT_PAGE_SIZE
        );
        assert_eq!(
            result["maxBinaryChunkBytes"],
            runtime::MAX_BINARY_CHUNK_BYTES
        );
        assert_eq!(
            result["maxInboundFileBytes"],
            runtime::MAX_INBOUND_FILE_BYTES
        );
        assert!(result["enabledStorageCapabilityIds"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
    }

    #[test]
    fn protocol_and_method_fail_closed() {
        let (_root, mut runtime) = runtime();
        let mut bad_protocol = request("host.hello");
        bad_protocol.protocol = 99;
        let response = process_request(bad_protocol, &mut runtime);
        assert!(!response.ok);
        assert_eq!(
            response.error.expect("protocol error").code,
            "protocol-version-unsupported"
        );

        let response = process_request(request("vault.rawSql"), &mut runtime);
        assert!(!response.ok);
        assert_eq!(
            response.error.expect("method error").code,
            "method-unsupported"
        );
    }

    #[test]
    fn framed_loop_emits_one_bounded_json_response() {
        let (_root, mut runtime) = runtime();
        let body = serde_json::to_vec(&json!({
            "protocol": PROTOCOL_VERSION,
            "requestId": "request-123",
            "method": "host.hello",
            "params": {}
        }))
        .unwrap();
        let mut input = Vec::new();
        write_frame(&mut input, &body).unwrap();
        let mut output = Vec::new();
        run(Cursor::new(input), &mut output, &mut runtime).unwrap();

        let frame = read_frame(&mut Cursor::new(output))
            .unwrap()
            .expect("response frame");
        let response: Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(response["requestId"], "request-123");
        assert_eq!(response["ok"], true);
    }

    #[test]
    fn frame_limits_reject_empty_oversized_and_truncated_lengths() {
        let mut empty = Cursor::new(0_u32.to_ne_bytes().to_vec());
        assert_eq!(
            read_frame(&mut empty).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        let oversized = u32::try_from(MAX_INPUT_FRAME_BYTES + 1).unwrap();
        let mut input = Cursor::new(oversized.to_ne_bytes().to_vec());
        assert_eq!(
            read_frame(&mut input).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );

        let mut truncated = Cursor::new(vec![1_u8, 2_u8]);
        assert_eq!(
            read_frame(&mut truncated).unwrap_err().kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn error_truncation_preserves_utf8_boundaries() {
        let message = "密".repeat(300);
        let bounded = bounded_message(message, 512);
        assert!(bounded.len() <= 512);
        assert!(bounded.is_char_boundary(bounded.len()));
    }
}
