#[cfg(feature = "kdbx-import")]
pub mod kdbx;
#[cfg(any(feature = "kdbx-binary-import", feature = "kdbx-binary-export"))]
pub mod kdbx_binary;
#[cfg(feature = "kdbx-export")]
pub mod kdbx_export;
pub mod kdbx_model;

#[cfg(feature = "kdbx-import")]
pub use kdbx::KdbxImporter;
#[cfg(any(feature = "kdbx-binary-import", feature = "kdbx-binary-export"))]
pub use kdbx_binary::{KdbxBinaryAdapter, KdbxBinaryDocument, KdbxBinaryLimits};
#[cfg(feature = "kdbx-export")]
pub use kdbx_export::KdbxExporter;
pub use kdbx_model::{ExportResult, ImportResult, KdbxAttachment, KdbxEntry};
