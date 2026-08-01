use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, Read, Write};

const PROTOCOL_VERSION: u32 = 1;
const HOST_NAME: &str = "com.monica_pass.mdbx2";
const MDBX_CORE_REVISION: &str = "aafa22f195c626a8d8288d712bf42bccea134847";
const MDBX_FORMAT_VERSION: &str = "MDBX-2";
const MAX_INPUT_FRAME_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_FRAME_BYTES: usize = 900 * 1024;
const MAX_BINARY_CHUNK_BYTES: usize = 256 * 1024;
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
        let mut message = message.into();
        message.truncate(512);
        Self {
            protocol: PROTOCOL_VERSION,
            request_id,
            ok: false,
            result: None,
            error: Some(HostError {
                code,
                message,
                retryable,
            }),
        }
    }
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    if let Err(error) = run(stdin.lock(), stdout.lock()) {
        // Native Messaging reserves stdout for framed protocol messages.
        eprintln!("Monica MDBX2 Host stopped: {error}");
        std::process::exit(1);
    }
}

fn run(mut reader: impl Read, mut writer: impl Write) -> io::Result<()> {
    while let Some(frame) = read_frame(&mut reader)? {
        let response = match serde_json::from_slice::<HostRequest>(&frame) {
            Ok(request) => process_request(request),
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

fn process_request(request: HostRequest) -> HostResponse {
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

    match request.method.as_str() {
        "host.hello" => host_hello(request.request_id, request.params),
        _ => HostResponse::failure(
            request.request_id,
            "method-unsupported",
            "Native method is not supported by this Host version.",
            false,
        ),
    }
}

fn host_hello(request_id: String, params: Value) -> HostResponse {
    if !params.is_object() {
        return HostResponse::failure(
            request_id,
            "params-invalid",
            "host.hello params must be an object.",
            false,
        );
    }
    let capabilities = mdbx_ffi::mdbx_build_capability_manifest();
    HostResponse::success(
        request_id,
        json!({
            "hostName": HOST_NAME,
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "protocolVersion": PROTOCOL_VERSION,
            "mdbxCoreRevision": MDBX_CORE_REVISION,
            "mdbxEngineVersion": capabilities.engine_version,
            "mdbxFormatVersion": MDBX_FORMAT_VERSION,
            "supportsMdbx1": false,
            "maxBinaryChunkBytes": MAX_BINARY_CHUNK_BYTES,
            "storageProfile": capabilities.storage_profile,
            "syncProfile": capabilities.sync_profile,
            "syncProtocolVersion": capabilities.sync_protocol_version,
            "enabledStorageCapabilityIds": capabilities.enabled_storage_capability_ids,
            "enabledSyncCapabilityIds": capabilities.enabled_sync_capability_ids,
        }),
    )
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

fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut length_bytes = [0_u8; 4];
    match reader.read_exact(&mut length_bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
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
    use std::io::Cursor;

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
        let response = process_request(request("host.hello"));
        assert!(response.ok);
        let result = response.result.expect("hello result");
        assert_eq!(result["mdbxCoreRevision"], MDBX_CORE_REVISION);
        assert_eq!(result["mdbxFormatVersion"], "MDBX-2");
        assert_eq!(result["supportsMdbx1"], false);
        assert_eq!(result["maxBinaryChunkBytes"], MAX_BINARY_CHUNK_BYTES);
        assert!(result["enabledStorageCapabilityIds"]
            .as_array()
            .is_some_and(|items| !items.is_empty()));
    }

    #[test]
    fn protocol_and_method_fail_closed() {
        let mut bad_protocol = request("host.hello");
        bad_protocol.protocol = 99;
        let response = process_request(bad_protocol);
        assert!(!response.ok);
        assert_eq!(
            response.error.expect("protocol error").code,
            "protocol-version-unsupported"
        );

        let response = process_request(request("vault.rawSql"));
        assert!(!response.ok);
        assert_eq!(
            response.error.expect("method error").code,
            "method-unsupported"
        );
    }

    #[test]
    fn framed_loop_emits_one_bounded_json_response() {
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
        run(Cursor::new(input), &mut output).unwrap();

        let frame = read_frame(&mut Cursor::new(output))
            .unwrap()
            .expect("response frame");
        let response: Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(response["requestId"], "request-123");
        assert_eq!(response["ok"], true);
    }

    #[test]
    fn frame_limits_reject_empty_and_oversized_lengths() {
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
    }
}
