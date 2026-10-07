use std::io::{Cursor, Read, Write};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{SyncError, SyncResult};
use crate::message::*;

pub const SYNC_WIRE_MAGIC: &[u8; 8] = b"MDBXWR01";
pub const SYNC_WIRE_VERSION: u16 = 1;
pub const SYNC_WIRE_HEADER_BYTES: usize = 52;
pub const MAX_SYNC_WIRE_PAYLOAD_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SYNC_WIRE_PAYLOAD_BYTES_USIZE: usize = MAX_SYNC_WIRE_PAYLOAD_BYTES as usize;
pub const MAX_SYNC_WIRE_SESSION_ID_BYTES: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncWireLimits {
    pub max_payload_bytes: u64,
}

impl Default for SyncWireLimits {
    fn default() -> Self {
        Self {
            max_payload_bytes: MAX_SYNC_WIRE_PAYLOAD_BYTES,
        }
    }
}

impl SyncWireLimits {
    pub fn new(max_payload_bytes: u64) -> SyncResult<Self> {
        let limits = Self { max_payload_bytes };
        limits.validate()?;
        Ok(limits)
    }

    fn validate(self) -> SyncResult<()> {
        if !(1..=MAX_SYNC_WIRE_PAYLOAD_BYTES).contains(&self.max_payload_bytes) {
            return Err(SyncError::InvalidMessage(format!(
                "sync wire payload limit must be between 1 and {MAX_SYNC_WIRE_PAYLOAD_BYTES} bytes"
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncWireFrame {
    pub session_id: String,
    pub sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<u64>,
    pub message: SyncMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SyncWireResume {
    pub session_id: String,
    pub next_outbound_sequence: u64,
    pub next_inbound_sequence: u64,
}

impl SyncWireResume {
    pub fn new(session_id: String) -> SyncResult<Self> {
        let resume = Self {
            session_id,
            next_outbound_sequence: 1,
            next_inbound_sequence: 1,
        };
        resume.validate()?;
        Ok(resume)
    }

    pub fn validate(&self) -> SyncResult<()> {
        validate_session_id(&self.session_id)?;
        if self.next_outbound_sequence == 0 || self.next_inbound_sequence == 0 {
            return Err(SyncError::InvalidMessage(
                "sync wire resume sequences must be positive".to_string(),
            ));
        }
        Ok(())
    }
}

/// Ordered wire state. Inbound sequence state advances only after an
/// application calls acknowledge_inbound after durable processing.
#[derive(Debug, Clone)]
pub struct SyncWireSession {
    resume: SyncWireResume,
    pending_inbound_sequence: Option<u64>,
}

impl SyncWireSession {
    pub fn new(session_id: String) -> SyncResult<Self> {
        Self::restore(SyncWireResume::new(session_id)?)
    }

    pub fn restore(resume: SyncWireResume) -> SyncResult<Self> {
        resume.validate()?;
        Ok(Self {
            resume,
            pending_inbound_sequence: None,
        })
    }

    pub fn resume(&self) -> &SyncWireResume {
        &self.resume
    }

    pub fn pending_inbound_sequence(&self) -> Option<u64> {
        self.pending_inbound_sequence
    }

    pub fn encode_outbound(
        &mut self,
        message: SyncMessage,
        in_reply_to: Option<u64>,
        limits: SyncWireLimits,
    ) -> SyncResult<Vec<u8>> {
        let frame = SyncWireFrame::new(
            self.resume.session_id.clone(),
            self.resume.next_outbound_sequence,
            in_reply_to,
            message,
        )?;
        let bytes = frame.to_wire_bytes(limits)?;
        self.resume.next_outbound_sequence = self
            .resume
            .next_outbound_sequence
            .checked_add(1)
            .ok_or_else(|| SyncError::InvalidMessage("sync wire sequence overflow".to_string()))?;
        Ok(bytes)
    }

    pub fn accept_inbound_bytes(
        &mut self,
        bytes: &[u8],
        limits: SyncWireLimits,
    ) -> SyncResult<SyncWireFrame> {
        let frame = SyncWireFrame::from_wire_bytes(bytes, limits)?;
        self.accept_inbound_frame(frame)
    }

    pub fn accept_inbound_frame(&mut self, frame: SyncWireFrame) -> SyncResult<SyncWireFrame> {
        frame.validate()?;
        if frame.session_id != self.resume.session_id {
            return Err(SyncError::Protocol(
                "sync wire frame belongs to another session".to_string(),
            ));
        }
        if let Some(pending) = self.pending_inbound_sequence {
            return Err(SyncError::Protocol(format!(
                "sync wire sequence {pending} is awaiting acknowledgement"
            )));
        }
        if frame.sequence < self.resume.next_inbound_sequence {
            return Err(SyncError::Protocol(format!(
                "sync wire sequence {} is a replay; expected {}",
                frame.sequence, self.resume.next_inbound_sequence
            )));
        }
        if frame.sequence > self.resume.next_inbound_sequence {
            return Err(SyncError::Protocol(format!(
                "sync wire sequence {} is out of order; expected {}",
                frame.sequence, self.resume.next_inbound_sequence
            )));
        }
        self.pending_inbound_sequence = Some(frame.sequence);
        Ok(frame)
    }

    pub fn acknowledge_inbound(&mut self, sequence: u64) -> SyncResult<()> {
        if self.pending_inbound_sequence != Some(sequence) {
            return Err(SyncError::Protocol(
                "sync wire acknowledgement does not match the pending frame".to_string(),
            ));
        }
        self.resume.next_inbound_sequence = self
            .resume
            .next_inbound_sequence
            .checked_add(1)
            .ok_or_else(|| SyncError::InvalidMessage("sync wire sequence overflow".to_string()))?;
        self.pending_inbound_sequence = None;
        Ok(())
    }

    pub fn discard_inbound(&mut self, sequence: u64) -> SyncResult<()> {
        if self.pending_inbound_sequence != Some(sequence) {
            return Err(SyncError::Protocol(
                "sync wire discard does not match the pending frame".to_string(),
            ));
        }
        self.pending_inbound_sequence = None;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WirePayload {
    session_id: String,
    sequence: u64,
    in_reply_to: Option<u64>,
    message: WireMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum WireMessage {
    Json(Vec<u8>),
    BlobManifestPageRequest(WireBlobManifestPageRequest),
    BlobManifestPageResponse(WireBlobManifestPageResponse),
    BlobChunkRequest(WireBlobChunkRequest),
    BlobChunkResponse(WireBlobChunkResponse),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WireBlobManifestPageRequest {
    namespace_id: String,
    checkpoint: Option<String>,
    cursor: Option<String>,
    page_size: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WireBlobManifestPageResponse {
    namespace_id: String,
    checkpoint: String,
    items: Vec<WireBlobManifestEntry>,
    next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WireBlobManifestEntry {
    blob_id: String,
    total_size: Option<u64>,
    state: BlobManifestEntryState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WireBlobChunkRequest {
    namespace_id: String,
    blob_id: String,
    total_size: u64,
    offset: u64,
    max_bytes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WireBlobChunkResponse {
    namespace_id: String,
    blob_id: String,
    total_size: u64,
    offset: u64,
    ciphertext: Vec<u8>,
    is_last: bool,
}

impl WireMessage {
    fn from_sync(value: SyncMessage) -> SyncResult<Self> {
        match value {
            SyncMessage::BlobManifestPageRequest(value) => {
                Ok(Self::BlobManifestPageRequest(WireBlobManifestPageRequest {
                    namespace_id: value.namespace_id,
                    checkpoint: value.checkpoint,
                    cursor: value.cursor,
                    page_size: value.page_size,
                }))
            }
            SyncMessage::BlobManifestPageResponse(value) => Ok(Self::BlobManifestPageResponse(
                WireBlobManifestPageResponse {
                    namespace_id: value.namespace_id,
                    checkpoint: value.checkpoint,
                    items: value
                        .items
                        .into_iter()
                        .map(|item| WireBlobManifestEntry {
                            blob_id: item.blob_id,
                            total_size: item.total_size,
                            state: item.state,
                        })
                        .collect(),
                    next_cursor: value.next_cursor,
                },
            )),
            SyncMessage::BlobChunkRequest(value) => {
                Ok(Self::BlobChunkRequest(WireBlobChunkRequest {
                    namespace_id: value.namespace_id,
                    blob_id: value.blob_id,
                    total_size: value.total_size,
                    offset: value.offset,
                    max_bytes: value.max_bytes,
                }))
            }
            SyncMessage::BlobChunkResponse(value) => {
                Ok(Self::BlobChunkResponse(WireBlobChunkResponse {
                    namespace_id: value.namespace_id,
                    blob_id: value.blob_id,
                    total_size: value.total_size,
                    offset: value.offset,
                    ciphertext: value.ciphertext,
                    is_last: value.is_last,
                }))
            }
            other => serde_json::to_vec(&other)
                .map(Self::Json)
                .map_err(|error| SyncError::Serialization(error.to_string())),
        }
    }

    fn into_sync(self) -> SyncResult<SyncMessage> {
        let message = match self {
            Self::Json(bytes) => SyncMessage::from_bytes(&bytes)
                .map_err(|error| SyncError::Serialization(error.to_string()))?,
            Self::BlobManifestPageRequest(value) => {
                SyncMessage::BlobManifestPageRequest(BlobManifestPageRequest {
                    namespace_id: value.namespace_id,
                    checkpoint: value.checkpoint,
                    cursor: value.cursor,
                    page_size: value.page_size,
                })
            }
            Self::BlobManifestPageResponse(value) => {
                SyncMessage::BlobManifestPageResponse(BlobManifestPageResponse {
                    namespace_id: value.namespace_id,
                    checkpoint: value.checkpoint,
                    items: value
                        .items
                        .into_iter()
                        .map(|item| BlobManifestEntry {
                            blob_id: item.blob_id,
                            total_size: item.total_size,
                            state: item.state,
                        })
                        .collect(),
                    next_cursor: value.next_cursor,
                })
            }
            Self::BlobChunkRequest(value) => SyncMessage::BlobChunkRequest(BlobChunkRequest {
                namespace_id: value.namespace_id,
                blob_id: value.blob_id,
                total_size: value.total_size,
                offset: value.offset,
                max_bytes: value.max_bytes,
            }),
            Self::BlobChunkResponse(value) => SyncMessage::BlobChunkResponse(BlobChunkResponse {
                namespace_id: value.namespace_id,
                blob_id: value.blob_id,
                total_size: value.total_size,
                offset: value.offset,
                ciphertext: value.ciphertext,
                is_last: value.is_last,
            }),
        };
        message.validate()?;
        Ok(message)
    }
}

impl SyncWireFrame {
    pub fn new(
        session_id: String,
        sequence: u64,
        in_reply_to: Option<u64>,
        message: SyncMessage,
    ) -> SyncResult<Self> {
        let frame = Self {
            session_id,
            sequence,
            in_reply_to,
            message,
        };
        frame.validate()?;
        Ok(frame)
    }

    pub fn validate(&self) -> SyncResult<()> {
        validate_session_id(&self.session_id)?;
        if self.sequence == 0 {
            return Err(SyncError::InvalidMessage(
                "sync wire sequence must start at 1".to_string(),
            ));
        }
        if self.in_reply_to == Some(0) {
            return Err(SyncError::InvalidMessage(
                "sync wire reply sequence must be positive".to_string(),
            ));
        }
        self.message.validate()
    }

    pub fn to_wire_bytes(&self, limits: SyncWireLimits) -> SyncResult<Vec<u8>> {
        let mut bytes = Vec::new();
        write_wire_frame(self, &mut bytes, limits)?;
        Ok(bytes)
    }

    pub fn from_wire_bytes(data: &[u8], limits: SyncWireLimits) -> SyncResult<Self> {
        let mut cursor = Cursor::new(data);
        let frame = read_wire_frame(&mut cursor, limits)?;
        if cursor.position() != data.len() as u64 {
            return Err(SyncError::Protocol(
                "sync wire frame contains trailing bytes".to_string(),
            ));
        }
        Ok(frame)
    }
}

pub fn write_wire_frame(
    frame: &SyncWireFrame,
    writer: &mut impl Write,
    limits: SyncWireLimits,
) -> SyncResult<()> {
    limits.validate()?;
    frame.validate()?;
    let payload_limit = usize::try_from(limits.max_payload_bytes).map_err(|_| {
        SyncError::InvalidMessage("sync wire limit cannot be represented locally".to_string())
    })?;
    let mut payload = LimitedVecWriter::new(payload_limit);
    let wire_payload = WirePayload {
        session_id: frame.session_id.clone(),
        sequence: frame.sequence,
        in_reply_to: frame.in_reply_to,
        message: WireMessage::from_sync(frame.message.clone())?,
    };
    bincode::serde::encode_into_std_write(&wire_payload, &mut payload, bincode::config::standard())
        .map_err(|error| payload.map_encode_error(error, limits.max_payload_bytes))?;
    let payload = payload.into_inner();
    let payload_len = payload.len() as u64;
    let version = SYNC_WIRE_VERSION.to_le_bytes();
    let reserved = 0_u16.to_le_bytes();
    let length = payload_len.to_le_bytes();
    let digest = wire_digest(&version, &reserved, &length, &payload);

    writer.write_all(SYNC_WIRE_MAGIC)?;
    writer.write_all(&version)?;
    writer.write_all(&reserved)?;
    writer.write_all(&length)?;
    writer.write_all(&digest)?;
    writer.write_all(&payload)?;
    Ok(())
}

pub fn read_wire_frame(
    reader: &mut impl Read,
    limits: SyncWireLimits,
) -> SyncResult<SyncWireFrame> {
    limits.validate()?;
    let mut magic = [0_u8; 8];
    reader.read_exact(&mut magic)?;
    if &magic != SYNC_WIRE_MAGIC {
        return Err(SyncError::Protocol("invalid sync wire magic".to_string()));
    }
    let mut version = [0_u8; 2];
    reader.read_exact(&mut version)?;
    let decoded_version = u16::from_le_bytes(version);
    if decoded_version != SYNC_WIRE_VERSION {
        return Err(SyncError::Protocol(format!(
            "unsupported sync wire version: {decoded_version}"
        )));
    }
    let mut reserved = [0_u8; 2];
    reader.read_exact(&mut reserved)?;
    if reserved != [0, 0] {
        return Err(SyncError::Protocol(
            "sync wire reserved bits must be zero".to_string(),
        ));
    }
    let mut length = [0_u8; 8];
    reader.read_exact(&mut length)?;
    let payload_len = u64::from_le_bytes(length);
    if payload_len == 0 || payload_len > limits.max_payload_bytes {
        return Err(SyncError::ResourceLimit {
            resource: "sync wire payload".to_string(),
            actual: payload_len,
            limit: limits.max_payload_bytes,
        });
    }
    let mut expected_digest = [0_u8; 32];
    reader.read_exact(&mut expected_digest)?;
    let payload_len_usize = usize::try_from(payload_len).map_err(|_| SyncError::ResourceLimit {
        resource: "sync wire payload".to_string(),
        actual: payload_len,
        limit: usize::MAX as u64,
    })?;
    let mut payload = Vec::new();
    payload
        .try_reserve_exact(payload_len_usize)
        .map_err(|error| {
            SyncError::Serialization(format!("cannot allocate sync wire payload: {error}"))
        })?;
    payload.resize(payload_len_usize, 0);
    reader.read_exact(&mut payload)?;
    let actual_digest = wire_digest(&version, &reserved, &length, &payload);
    if actual_digest != expected_digest {
        return Err(SyncError::Protocol(
            "sync wire payload integrity check failed".to_string(),
        ));
    }
    let payload_bytes = payload;
    let (decoded, consumed): (WirePayload, usize) = bincode::serde::decode_from_slice(
        &payload_bytes,
        bincode::config::standard().with_limit::<MAX_SYNC_WIRE_PAYLOAD_BYTES_USIZE>(),
    )
    .map_err(|error| SyncError::Serialization(error.to_string()))?;
    if consumed != payload_bytes.len() {
        return Err(SyncError::Protocol(
            "sync wire payload contains trailing bytes".to_string(),
        ));
    }
    let frame = SyncWireFrame {
        session_id: decoded.session_id,
        sequence: decoded.sequence,
        in_reply_to: decoded.in_reply_to,
        message: decoded.message.into_sync()?,
    };
    frame.validate()?;
    Ok(frame)
}

fn wire_digest(
    version: &[u8; 2],
    reserved: &[u8; 2],
    length: &[u8; 8],
    payload: &[u8],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(SYNC_WIRE_MAGIC);
    hasher.update(version);
    hasher.update(reserved);
    hasher.update(length);
    hasher.update(payload);
    hasher.finalize().into()
}

fn validate_session_id(session_id: &str) -> SyncResult<()> {
    if session_id.is_empty()
        || session_id.len() > MAX_SYNC_WIRE_SESSION_ID_BYTES
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b':'))
    {
        return Err(SyncError::InvalidMessage(format!(
            "sync wire session ID must contain 1 to {MAX_SYNC_WIRE_SESSION_ID_BYTES} safe ASCII bytes"
        )));
    }
    Ok(())
}

struct LimitedVecWriter {
    bytes: Vec<u8>,
    limit: usize,
    exceeded_at: Option<u64>,
}

impl LimitedVecWriter {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            exceeded_at: None,
        }
    }

    fn into_inner(self) -> Vec<u8> {
        self.bytes
    }

    fn map_encode_error(&self, error: bincode::error::EncodeError, limit: u64) -> SyncError {
        if let Some(actual) = self.exceeded_at {
            SyncError::ResourceLimit {
                resource: "sync wire payload".to_string(),
                actual,
                limit,
            }
        } else {
            match error {
                bincode::error::EncodeError::Io { inner, .. } => SyncError::IoError(inner),
                other => SyncError::Serialization(other.to_string()),
            }
        }
    }
}

impl Write for LimitedVecWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let next = self.bytes.len().saturating_add(buf.len());
        if next > self.limit {
            self.exceeded_at = Some(next as u64);
            return Err(std::io::Error::other("sync wire payload limit exceeded"));
        }
        self.bytes
            .try_reserve(buf.len())
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        self.bytes.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{BlobChunkResponse, MAX_BLOB_ID_BYTES};

    fn blob_frame(chunk_bytes: usize) -> SyncWireFrame {
        SyncWireFrame::new(
            "session-1".to_string(),
            1,
            None,
            SyncMessage::BlobChunkResponse(
                BlobChunkResponse::new(
                    "source".to_string(),
                    "a".repeat(MAX_BLOB_ID_BYTES),
                    chunk_bytes as u64,
                    0,
                    vec![7; chunk_bytes],
                    true,
                )
                .unwrap(),
            ),
        )
        .unwrap()
    }

    #[test]
    fn wire_blob_chunk_roundtrips_compactly() {
        let frame = blob_frame(64 * 1024);
        let bytes = frame.to_wire_bytes(SyncWireLimits::default()).unwrap();
        let json = frame.message.to_bytes().unwrap();
        assert!(bytes.len() < json.len());

        let restored = SyncWireFrame::from_wire_bytes(&bytes, SyncWireLimits::default()).unwrap();
        assert_eq!(restored.session_id, "session-1");
        assert_eq!(restored.sequence, 1);
        match restored.message {
            SyncMessage::BlobChunkResponse(response) => {
                assert_eq!(response.ciphertext, vec![7; 64 * 1024]);
                assert!(response.is_last);
            }
            _ => panic!("expected Blob chunk response"),
        }
    }

    #[test]
    fn wire_rejects_corruption_trailing_data_and_header_tampering() {
        let frame = blob_frame(32);
        let bytes = frame.to_wire_bytes(SyncWireLimits::default()).unwrap();

        let mut corrupted = bytes.clone();
        *corrupted.last_mut().unwrap() ^= 1;
        assert!(SyncWireFrame::from_wire_bytes(&corrupted, SyncWireLimits::default()).is_err());

        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(SyncWireFrame::from_wire_bytes(&trailing, SyncWireLimits::default()).is_err());

        let mut reserved = bytes.clone();
        reserved[10] = 1;
        assert!(SyncWireFrame::from_wire_bytes(&reserved, SyncWireLimits::default()).is_err());

        let mut version = bytes;
        version[8..10].copy_from_slice(&2_u16.to_le_bytes());
        assert!(SyncWireFrame::from_wire_bytes(&version, SyncWireLimits::default()).is_err());
    }

    #[test]
    fn wire_rejects_declared_size_before_payload_allocation() {
        let limits = SyncWireLimits::new(1024).unwrap();
        let mut frame = Vec::new();
        frame.extend_from_slice(SYNC_WIRE_MAGIC);
        frame.extend_from_slice(&SYNC_WIRE_VERSION.to_le_bytes());
        frame.extend_from_slice(&0_u16.to_le_bytes());
        frame.extend_from_slice(&1025_u64.to_le_bytes());
        frame.extend_from_slice(&[0_u8; 32]);
        let error = SyncWireFrame::from_wire_bytes(&frame, limits).unwrap_err();
        assert!(matches!(error, SyncError::ResourceLimit { .. }));

        let oversized = blob_frame(2048);
        assert!(matches!(
            oversized.to_wire_bytes(limits),
            Err(SyncError::ResourceLimit { .. })
        ));
    }

    #[test]
    fn session_requires_ordered_acknowledgement_and_rejects_replays() {
        let mut sender = SyncWireSession::new("session-1".to_string()).unwrap();
        let mut receiver = SyncWireSession::new("session-1".to_string()).unwrap();
        let bytes = sender
            .encode_outbound(
                SyncMessage::Done(SyncDone {
                    device_id: "sender".to_string(),
                    total_commits: 0,
                    final_heads: Vec::new(),
                }),
                None,
                SyncWireLimits::default(),
            )
            .unwrap();
        let frame = receiver
            .accept_inbound_bytes(&bytes, SyncWireLimits::default())
            .unwrap();
        assert_eq!(frame.sequence, 1);
        assert_eq!(receiver.pending_inbound_sequence(), Some(1));
        assert!(receiver
            .accept_inbound_bytes(&bytes, SyncWireLimits::default())
            .is_err());
        receiver.acknowledge_inbound(1).unwrap();
        assert!(receiver
            .accept_inbound_bytes(&bytes, SyncWireLimits::default())
            .is_err());

        let mut wrong_session = frame;
        wrong_session.session_id = "other-session".to_string();
        assert!(receiver.accept_inbound_frame(wrong_session).is_err());

        let resume = receiver.resume().clone();
        let encoded = serde_json::to_vec(&resume).unwrap();
        let restored: SyncWireResume = serde_json::from_slice(&encoded).unwrap();
        let restored = SyncWireSession::restore(restored).unwrap();
        assert_eq!(restored.resume().next_inbound_sequence, 2);
    }

    #[test]
    fn session_rejects_out_of_order_without_advancing_resume() {
        let mut receiver = SyncWireSession::new("session-1".to_string()).unwrap();
        let frame = SyncWireFrame::new(
            "session-1".to_string(),
            2,
            None,
            SyncMessage::Done(SyncDone {
                device_id: "sender".to_string(),
                total_commits: 0,
                final_heads: Vec::new(),
            }),
        )
        .unwrap();
        assert!(receiver.accept_inbound_frame(frame).is_err());
        assert_eq!(receiver.resume().next_inbound_sequence, 1);
        assert_eq!(receiver.pending_inbound_sequence(), None);
    }
}
