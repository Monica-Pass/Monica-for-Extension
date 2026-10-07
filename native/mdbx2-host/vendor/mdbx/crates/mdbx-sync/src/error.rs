use thiserror::Error;

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("protocol error: {0}")]
    Protocol(String),

    #[error("serialization error: {0}")]
    Serialization(String),

    #[error("invalid message: {0}")]
    InvalidMessage(String),

    #[error("connection error: {0}")]
    Connection(String),

    #[error("version mismatch: local {local}, remote {remote}")]
    VersionMismatch { local: u32, remote: u32 },

    #[error("sync conflict: {0}")]
    Conflict(String),

    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),

    #[error("bundle format: {0}")]
    BundleFormat(String),

    #[error("bundle integrity: {0}")]
    BundleIntegrity(String),

    #[error("resource limit exceeded for {resource}: {actual} bytes > {limit} bytes")]
    ResourceLimit {
        resource: String,
        actual: u64,
        limit: u64,
    },

    #[error("unsupported feature: {0}")]
    UnsupportedFeature(String),
}

pub type SyncResult<T> = Result<T, SyncError>;
