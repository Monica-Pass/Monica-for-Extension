use mdbx_core::tiga::AuthorizationDecision;
use mdbx_crypto::error::CryptoError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),

    #[error("schema creation failed: {0}")]
    SchemaCreation(String),

    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("constraint violation: {0}")]
    ConstraintViolation(String),

    #[error("validation error: {0}")]
    Validation(String),

    #[error("encrypted blob store error: {0}")]
    BlobStore(String),

    #[error("resource limit exceeded for {resource}: {actual} > {limit}")]
    ResourceLimit {
        resource: String,
        actual: u64,
        limit: u64,
    },

    #[error(
        "collection {collection_id} requires unavailable extension capabilities: {capabilities:?}"
    )]
    MissingExtensionCapabilities {
        collection_id: String,
        capabilities: Vec<String>,
    },

    #[error("attachment {attachment_id} requires an encrypted blob store")]
    EncryptedBlobStoreRequired { attachment_id: String },

    #[error("Tiga authorization did not allow the operation: {0:?}")]
    Authorization(AuthorizationDecision),

    #[error("crypto error: {0}")]
    Crypto(#[from] CryptoError),

    #[error("vault runtime lock is poisoned")]
    RuntimeLockPoisoned,

    #[error("reader generation is stale: expected {expected}, actual {actual}")]
    StaleReaderGeneration { expected: u64, actual: u64 },
}

pub type StorageResult<T> = Result<T, StorageError>;
