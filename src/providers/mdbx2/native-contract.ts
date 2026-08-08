export const MDBX2_NATIVE_HOST_NAME = "com.monica_pass.mdbx2";
export const MDBX2_NATIVE_PROTOCOL_VERSION = 2;
export const MDBX2_CORE_REVISION = "974c517465e7b6cac0947d2d59875aa4211fa16b";
export const MDBX2_ENGINE_VERSION = "0.2.0";
export const MDBX2_FORMAT_VERSION = "MDBX-2";
export const MDBX2_SYNC_PROTOCOL_VERSION = 2;
export const MDBX2_MAX_BINARY_CHUNK_BYTES = 256 * 1024;
export const MDBX2_MAX_INBOUND_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const MDBX2_MAX_ACTIVE_TRANSFERS = 4;
export const MDBX2_MAX_OBJECT_PAYLOAD_BYTES = 512 * 1024;
export const MDBX2_MAX_SUMMARY_PAGE_SIZE = 200;
export const MDBX2_MAX_COLLECTION_TITLE_BYTES = 4096;
export const MDBX2_MAX_COLLECTION_RESULT_BYTES = 850 * 1024;
export const MDBX2_MAX_VAULT_DIAGNOSTIC_CATEGORIES = 14;
export const MDBX2_MAX_VAULT_HEALTH_ISSUE_KINDS = 20;
export const MDBX2_MAX_VAULT_DIAGNOSTICS_RESULT_BYTES = 64 * 1024;
export const MDBX2_MAX_HEALTH_REPAIR_ITEMS = 500;
export const MDBX2_MAX_HEALTH_REPAIR_CONFLICTS = 500;
export const MDBX2_MAX_HEALTH_REPAIR_RESULT_BYTES = 64 * 1024;
export const MDBX2_MAX_VAULT_TIGA_RESULT_BYTES = 16 * 1024;
export const MDBX2_MAX_VAULT_TIGA_UNLOCK_METHODS = 4;
export const MDBX2_MAX_VAULT_TIGA_BROWSER_LIMITATIONS = 3;
export const MDBX2_VAULT_DIAGNOSTIC_CATEGORIES = [
  "integrity",
  "vault-header-integrity",
  "incremental-integrity-root",
  "commit-chain",
  "commit-integrity",
  "attachment-chunks",
  "snapshots",
  "orphans",
  "collection-profiles",
  "tombstones",
  "tombstone-acknowledgements",
  "purge-receipts",
  "stale-heads",
  "other"
] as const;
export const MDBX2_VAULT_HEALTH_ISSUE_KINDS = [
  "basic-integrity",
  "header-verification-pending",
  "header-authentication-failed",
  "integrity-root-pending",
  "integrity-root-stale",
  "commit-reference-missing",
  "commit-authentication-pending",
  "commit-authentication-failed",
  "attachment-structure",
  "snapshot-invalid",
  "orphan-record",
  "collection-profile",
  "tombstone-duplicate",
  "tombstone-missing",
  "tombstone-stale",
  "tombstone-acknowledgement",
  "purge-record",
  "device-reference",
  "inactive-device",
  "unknown"
] as const;
export const MDBX2_HEALTH_REPAIR_KINDS = [
  "missing-tombstone",
  "duplicate-tombstones",
  "active-object-tombstone-conflict"
] as const;
export const MDBX2_HEALTH_REPAIR_OBJECT_TYPES = [
  "project",
  "entry",
  "attachment",
  "object-relation",
  "object-label",
  "object-label-assignment",
  "other"
] as const;
export const MDBX2_MAX_OBJECT_BATCH_MUTATIONS = 50;
export const MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES = 384 * 1024;
export const MDBX2_MAX_HISTORY_PAGE_SIZE = 50;
export const MDBX2_MAX_HISTORY_DIFF_ITEMS = 500;
export const MDBX2_MAX_HISTORY_RESULT_BYTES = 850 * 1024;
export const MDBX2_MAX_HISTORY_REVERT_ITEMS = 500;
export const MDBX2_MAX_SNAPSHOT_PAGE_SIZE = 50;
export const MDBX2_MAX_SNAPSHOT_STRUCTURE_PAGE_SIZE = 100;
export const MDBX2_MAX_SNAPSHOT_STRUCTURE_NODES = 10_000;
export const MDBX2_MAX_SNAPSHOT_RESULT_BYTES = 850 * 1024;
export const MDBX2_MAX_SNAPSHOT_NAME_BYTES = 96;
export const MDBX2_MAX_SNAPSHOT_PRUNE_CANDIDATES = 200;
export const MDBX2_MAX_SNAPSHOT_PRUNE_KEEP_LATEST = 10_000;
export const MDBX2_MAX_CONFLICT_PAGE_SIZE = 50;
export const MDBX2_MAX_CONFLICT_RESULT_BYTES = 850 * 1024;
export const MDBX2_MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const MDBX2_MAX_ATTACHMENT_PAGE_SIZE = 50;
export const MDBX2_MAX_ATTACHMENT_SESSIONS = 4;
export const MDBX2_MAX_ATTACHMENT_MEMORY_BYTES = 128 * 1024 * 1024;
export const MDBX2_SYNC_SEGMENT_PAGE_SIZE = 128;
export const MDBX2_BLOB_REFERENCE_PAGE_SIZE = 256;
export const MDBX2_MAX_REMOTE_BLOB_BYTES = 64 * 1024 * 1024 + 128 * 1024;
export const MDBX2_WINDOWS_HELLO_PROTOCOL_VERSION = 1;
export const MDBX2_WINDOWS_HELLO_RP_ID = "monica-extension.local";

export type Mdbx2NativeMethod =
  | "host.hello"
  | "transfer.begin"
  | "transfer.chunk"
  | "transfer.finish"
  | "transfer.abort"
  | "vault.inspect"
  | "vault.open"
  | "vault.status"
  | "vault.diagnostics"
  | "vault.tiga"
  | "health.repair.plan"
  | "health.repair.apply"
  | "vault.lock"
  | "collection.list"
  | "collection.create"
  | "collection.rename"
  | "collection.move"
  | "collection.delete"
  | "collection.restore"
  | "object.list"
  | "object.reveal"
  | "object.upsert"
  | "object.delete"
  | "object.batch"
  | "object.operation.status"
  | "object.operation.resolve"
  | "history.list"
  | "history.diff"
  | "history.revert"
  | "snapshot.list"
  | "snapshot.structure"
  | "snapshot.prune.plan"
  | "snapshot.prune.execute"
  | "snapshot.create"
  | "snapshot.delete"
  | "snapshot.restore"
  | "conflict.list"
  | "conflict.resolve"
  | "attachment.list"
  | "attachment.read.begin"
  | "attachment.read.chunk"
  | "attachment.read.release"
  | "attachment.upload.begin"
  | "attachment.upload.chunk"
  | "attachment.upload.finish"
  | "attachment.upload.abort"
  | "attachment.delete"
  | "hello.status"
  | "hello.enroll"
  | "hello.verify"
  | "hello.revoke"
  | "transfer.read"
  | "transfer.release"
  | "sync.state.register"
  | "sync.state.status"
  | "sync.bootstrap.prepare"
  | "sync.bootstrap.commit"
  | "sync.segment.prepare"
  | "sync.segment.commit"
  | "sync.stream.list"
  | "sync.stream.block"
  | "sync.segment.inspect"
  | "sync.segment.apply"
  | "sync.segment.acknowledge"
  | "sync.blob.list"
  | "sync.blob.read"
  | "sync.blob.remote.verify"
  | "sync.blob.receive.begin"
  | "sync.blob.receive.chunk"
  | "sync.blob.receive.abort";

export type Mdbx2InboundTransferPurpose = "vault-bootstrap" | "sync-segment";
export type Mdbx2OutputFilePurpose = "sync-bootstrap" | "sync-segment";

export type Mdbx2UnlockMethod = "password" | "security-key" | "password-security-key";

export type Mdbx2VaultCredential =
  | { method: "password"; password: string }
  | { method: "security-key"; keyMaterialBase64: string }
  | { method: "password-security-key"; password: string; keyMaterialBase64: string };

export interface Mdbx2VaultSource {
  kind: "file" | "vault";
  handle: string;
}

export interface Mdbx2TransferBeginResult {
  transferId: string;
  nextOffset: number;
  maxChunkBytes: typeof MDBX2_MAX_BINARY_CHUNK_BYTES;
}

export interface Mdbx2TransferChunkResult {
  nextOffset: number;
  acceptedBytes: number;
  repeated: boolean;
}

export interface Mdbx2TransferFinishResult {
  fileHandle: string;
  purpose: Mdbx2InboundTransferPurpose;
  sizeBytes: number;
  sha256: string;
}

export interface Mdbx2OutputFileDescriptor {
  fileHandle: string;
  purpose: Mdbx2OutputFilePurpose;
  sizeBytes: number;
  sha256: string;
}

export interface Mdbx2TransferReadResult extends Mdbx2OutputFileDescriptor {
  offset: number;
  dataBase64: string;
  nextOffset: number;
  eof: boolean;
}

export interface Mdbx2SyncStateStatus {
  stateHandle: string;
  vaultHandle: string;
  vaultId: string;
  deviceId: string;
  initialized: boolean;
  hasLocalChanges: boolean;
  pendingBootstrap: boolean;
  pendingSegment: boolean;
  pendingRemoteAcknowledgement: boolean;
  remoteStreamCount: number;
  blockedStreamCount: number;
  blobTransferCount: number;
  verifiedRemoteBlobCount: number;
}

export interface Mdbx2SyncBootstrapPrepareResult {
  stateHandle: string;
  vaultId: string;
  deviceId: string;
  file: Mdbx2OutputFileDescriptor;
}

export interface Mdbx2SyncSegmentDescriptor {
  file: Mdbx2OutputFileDescriptor;
  vaultId: string;
  sourceDeviceId: string;
  transferId: string;
  segmentIndex: number;
  isLast: boolean;
  commitCount: number;
  deltaCount: number;
  payloadSha256: string;
}

export type Mdbx2SyncSegmentPrepareResult =
  | { hasSegment: false; stateHandle: string }
  | ({ hasSegment: true; stateHandle: string } & Mdbx2SyncSegmentDescriptor);

export interface Mdbx2RemoteStreamSummary {
  streamId: string;
  deviceId: string;
  generationId: string;
  nextSequence: number;
  lastAppliedDigest?: string;
  blockedReason?: string;
}

export interface Mdbx2SyncSegmentApplyResult {
  status: "applied" | "duplicate" | "blocked";
  appliedCommits: number;
  skippedCommits: number;
  conflictCount: number;
  missingParentCount: number;
  pendingAcknowledgement: boolean;
  blockedReason?: string;
}

export type Mdbx2ExternalBlobState = "available" | "missing" | "size-mismatch";

export interface Mdbx2ExternalBlobReference {
  blobId: string;
  totalSize?: number;
  state: Mdbx2ExternalBlobState;
  remoteVerified: boolean;
}

export interface Mdbx2ExternalBlobReferencePage {
  rawReferenceCount: number;
  uniqueReferenceCount: number;
  items: Mdbx2ExternalBlobReference[];
  nextCursor?: string;
}

export interface Mdbx2ExternalBlobChunk {
  blobId: string;
  totalSize: number;
  offset: number;
  dataBase64: string;
  nextOffset: number;
  isLast: boolean;
}

export interface Mdbx2ExternalBlobReceiveState {
  blobId: string;
  totalSize: number;
  nextOffset: number;
  complete: boolean;
}

export interface Mdbx2VaultInspection {
  source: Mdbx2VaultSource;
  initialized: true;
  formatVersion: typeof MDBX2_FORMAT_VERSION;
  schemaVersion?: number;
  minReaderVersion?: string;
  minWriterVersion?: string;
  requiresUpgrade: boolean;
  unknownCriticalExtensions: false;
  targetFormatVersion: typeof MDBX2_FORMAT_VERSION;
  targetSchemaVersion: number;
}

export interface Mdbx2VaultDiagnosticsSummary {
  commitCount: number;
  tombstoneCount: number;
  branchCount: number;
  deviceCount: number;
  snapshotCount: number;
  unresolvedConflictCount: number;
  projectCount: number;
  folderCount: number;
  deletedProjectCount: number;
  entryCount: number;
  deletedEntryCount: number;
  attachmentCount: number;
  deletedAttachmentCount: number;
  externalAttachmentCount: number;
  originalAttachmentBytes: number;
  storedAttachmentBytes: number;
}

export type Mdbx2VaultHealthSeverity = "info" | "warning" | "error" | "critical";
export type Mdbx2VaultHealthCategory = typeof MDBX2_VAULT_DIAGNOSTIC_CATEGORIES[number];
export type Mdbx2VaultHealthIssueKind = typeof MDBX2_VAULT_HEALTH_ISSUE_KINDS[number];

export interface Mdbx2VaultHealthCategorySummary {
  category: Mdbx2VaultHealthCategory;
  count: number;
  highestSeverity: Mdbx2VaultHealthSeverity;
}

export interface Mdbx2VaultHealthIssueKindSummary {
  kind: Mdbx2VaultHealthIssueKind;
  count: number;
  highestSeverity: Mdbx2VaultHealthSeverity;
}

export interface Mdbx2VaultHealthSummary {
  healthy: boolean;
  issueCount: number;
  infoCount: number;
  warningCount: number;
  errorCount: number;
  criticalCount: number;
  categories: Mdbx2VaultHealthCategorySummary[];
  issueKinds: Mdbx2VaultHealthIssueKindSummary[];
}

export interface Mdbx2VaultDiagnosticsReport {
  checkedAtUnixSeconds: number;
  fileSizeBytes: number;
  formatVersion: typeof MDBX2_FORMAT_VERSION;
  schemaVersion: number;
  health: Mdbx2VaultHealthSummary;
  diagnostics: Mdbx2VaultDiagnosticsSummary;
}

export type Mdbx2HealthRepairKind = typeof MDBX2_HEALTH_REPAIR_KINDS[number];
export type Mdbx2HealthRepairObjectType = typeof MDBX2_HEALTH_REPAIR_OBJECT_TYPES[number];
export type Mdbx2HealthRepairChoice = "keep-content" | "delete-object";

export interface Mdbx2HealthRepairAutomaticSummary {
  kind: Exclude<Mdbx2HealthRepairKind, "active-object-tombstone-conflict">;
  objectType: Mdbx2HealthRepairObjectType;
  itemCount: number;
  tombstoneCount: number;
}

export interface Mdbx2HealthRepairConflict {
  itemHandle: string;
  kind: "active-object-tombstone-conflict";
  objectType: Mdbx2HealthRepairObjectType;
  tombstoneCount: number;
}

export interface Mdbx2HealthRepairBlockerSummary {
  category: Mdbx2VaultHealthCategory;
  count: number;
}

export interface Mdbx2HealthRepairPlan {
  planHandle?: string;
  canApply: boolean;
  itemCount: number;
  automaticCount: number;
  conflictCount: number;
  blockerCount: number;
  automatic: Mdbx2HealthRepairAutomaticSummary[];
  conflicts: Mdbx2HealthRepairConflict[];
  blockers: Mdbx2HealthRepairBlockerSummary[];
}

export interface Mdbx2HealthRepairDecision {
  itemHandle: string;
  choice: Mdbx2HealthRepairChoice;
}

export interface Mdbx2HealthRepairApplyResult {
  status: "applied";
  repairedCount: number;
  alreadyApplied: boolean;
  recoveryPointCreated: true;
  health: Mdbx2VaultHealthSummary;
}

export type Mdbx2TigaProfile = "sky" | "multi" | "power";
export type Mdbx2TigaCompliance = "compliant" | "exception" | "remediation-required";
export type Mdbx2TigaUnlockMethod = "pin" | "password" | "security-key" | "password-security-key";
export type Mdbx2TigaDeviceAssurance = "unknown" | "standard" | "trusted-hardware";
export type Mdbx2TigaAuditLevel = "security-changes" | "sensitive-operations" | "all-decisions";
export type Mdbx2TigaBrowserLimitation =
  | "device-assurance-insufficient"
  | "secure-clipboard-unavailable"
  | "screen-capture-protection-unavailable";

export interface Mdbx2TigaUnlockPosture {
  mode: Mdbx2TigaProfile;
  configuredMethods: Mdbx2TigaUnlockMethod[];
  hasPortableUnlock: boolean;
  hasSecurityKeyUnlock: boolean;
  hasCombinedPasswordSecurityKey: boolean;
  hasRequiredCombinedStrength: boolean;
  satisfiesPolicy: boolean;
  warningCount: number;
}

export interface Mdbx2TigaPolicySummary {
  policyVersion: number;
  portableUnlockAllowed: boolean;
  minimumAuthFactors: number;
  securityKeyRequired: boolean;
  securityKeyRecommended: boolean;
  idleTimeoutSeconds: number;
  maxLifetimeSeconds: number;
  lockOnBackground: boolean;
  freshAuthWindowSeconds: number;
  revealRequiresFreshAuth: boolean;
  clipboardAllowed: boolean;
  clipboardTtlSeconds: number;
  copyRequiresFreshAuth: boolean;
  secureClipboardRequired: boolean;
  screenCaptureProtectionRequired: boolean;
  exportAllowed: boolean;
  printAllowed: boolean;
  egressRequiresFreshAuth: boolean;
  egressMinimumAuthFactors: number;
  persistentPlaintextCacheAllowed: boolean;
  attachmentTemporaryFilesAllowed: boolean;
  lockedCiphertextSyncAllowed: boolean;
  minimumRecoveryMethods: number;
  portableRecoveryRequired: boolean;
  administrationRequiresFreshAuth: boolean;
  administrationMinimumAuthFactors: number;
  auditDeletionAllowed: boolean;
  minimumDeviceAssurance: Mdbx2TigaDeviceAssurance;
  auditLevel: Mdbx2TigaAuditLevel;
}

export interface Mdbx2TigaBrowserPosture {
  deviceAssurance: Mdbx2TigaDeviceAssurance;
  secureClipboardAvailable: boolean;
  screenCaptureProtectionAvailable: boolean;
  secureTemporaryFilesAvailable: boolean;
  limitations: Mdbx2TigaBrowserLimitation[];
}

export interface Mdbx2VaultTigaPosture {
  checkedAtUnixSeconds: number;
  profile: Mdbx2TigaProfile;
  compliance: Mdbx2TigaCompliance;
  hasException: boolean;
  warningCount: number;
  unlock: Mdbx2TigaUnlockPosture;
  policy: Mdbx2TigaPolicySummary;
  browser: Mdbx2TigaBrowserPosture;
}

export interface Mdbx2VaultSessionSummary extends Mdbx2VaultDiagnosticsReport {
  vaultHandle: string;
  vaultId: string;
  deviceId: string;
  migrated: boolean;
  preUpgradeBackupCreated: boolean;
}

export interface Mdbx2VaultRuntimeStatus {
  vaultHandle: string;
  open: boolean;
  available: boolean;
}

export interface Mdbx2CollectionSummary {
  collectionId: string;
  title: string;
  collectionTypeId?: string;
  profileSchemaVersion?: number;
  groupId?: string;
  iconRef?: string;
  favorite: boolean;
  archived: boolean;
  attachmentCount: number;
  headCommitId: string;
  deleted: boolean;
  updatedAt: string;
}

export interface Mdbx2CollectionSummaryPage {
  items: Mdbx2CollectionSummary[];
  nextCursor?: string;
}

export interface Mdbx2CollectionMutationResult {
  operationId: string;
  commitId: string;
  alreadyCommitted: boolean;
  collection: Mdbx2CollectionSummary;
}

export interface Mdbx2ObjectSummary {
  objectId: string;
  collectionId: string;
  objectTypeId: string;
  title: string;
  payloadSchemaVersion: number;
  headCommitId: string;
  deleted: boolean;
  updatedAt: string;
}

export interface Mdbx2ObjectSummaryPage {
  items: Mdbx2ObjectSummary[];
  nextCursor?: string;
}

export interface Mdbx2ObjectRecord {
  objectId: string;
  collectionId: string;
  objectTypeId: string;
  title: string;
  payloadJson: string;
  payloadSchemaVersion: number;
  deleted: boolean;
}

export type Mdbx2AttachmentStorageMode = "embedded-inline" | "embedded-chunked" | "external-hash-ref";

export interface Mdbx2AttachmentSummary {
  attachmentId: string;
  fileName: string;
  mediaType?: string;
  sizeBytes: number;
  storageMode: Mdbx2AttachmentStorageMode;
  protected: true;
  deleted: boolean;
  updatedAt?: string;
}

export interface Mdbx2AttachmentSummaryPage {
  items: Mdbx2AttachmentSummary[];
  nextCursor?: string;
}

export interface Mdbx2AttachmentReadBeginResult {
  readHandle: string;
  attachmentId: string;
  fileName: string;
  mediaType?: string;
  sizeBytes: number;
  maxChunkBytes: typeof MDBX2_MAX_BINARY_CHUNK_BYTES;
}

export interface Mdbx2AttachmentReadChunkResult extends Omit<Mdbx2AttachmentReadBeginResult, "maxChunkBytes"> {
  offset: number;
  dataBase64: string;
  nextOffset: number;
  eof: boolean;
}

export type Mdbx2AttachmentUploadMode = "create" | "replace";

export interface Mdbx2AttachmentUploadBeginInput {
  operationId: string;
  attachmentId: string;
  collectionId: string;
  objectId: string;
  fileName: string;
  mediaType?: string;
  mode: Mdbx2AttachmentUploadMode;
  sizeBytes: number;
  sha256?: string;
}

export interface Mdbx2AttachmentUploadBeginResult {
  transferId: string;
  operationId: string;
  attachmentId: string;
  nextOffset: number;
  maxChunkBytes: typeof MDBX2_MAX_BINARY_CHUNK_BYTES;
  alreadyCommitted: boolean;
}

export interface Mdbx2AttachmentUploadChunkResult {
  transferId: string;
  nextOffset: number;
  acceptedBytes: number;
  repeated: boolean;
}

export interface Mdbx2AttachmentMutationResult {
  transferId?: string;
  operationId?: string;
  attachment: Mdbx2AttachmentSummary;
  commitId: string;
  alreadyCommitted: boolean;
  changed: boolean;
}

export interface Mdbx2ObjectUpsertInput {
  logicalObjectId: string;
  collectionId?: string;
  objectTypeId: string;
  title: string;
  payloadJson: string;
}

export interface Mdbx2ObjectWriteResult {
  commitId: string;
  alreadyCommitted: boolean;
  logicalObjectId: string;
  objectId: string;
  collectionId: string;
  objectTypeId: string;
}

export interface Mdbx2ObjectDeleteResult {
  changed: boolean;
  commitId?: string;
  alreadyCommitted?: boolean;
  logicalObjectId: string;
  objectId: string;
}

export type Mdbx2ObjectMutationInput =
  | ({ kind: "upsert" } & Mdbx2ObjectUpsertInput)
  | { kind: "delete"; logicalObjectId: string };

export interface Mdbx2ObjectMutationResult {
  kind: "upsert" | "delete";
  changed: boolean;
  logicalObjectId: string;
  objectId: string;
  collectionId?: string;
  objectTypeId?: string;
}

export interface Mdbx2ObjectBatchResult {
  changed: boolean;
  operationId: string;
  commitId?: string;
  alreadyCommitted?: boolean;
  items: Mdbx2ObjectMutationResult[];
}

export type Mdbx2ObjectOperationStatus =
  | { known: false; committed: false }
  | { known: true; committed: false }
  | { known: true; committed: true; commitId: string };

export type Mdbx2ObjectOperationResolution =
  | { known: false; committed: false }
  | { known: true; committed: false; operationId: string }
  | { known: true; committed: true; operationId: string; commitId: string };

export interface Mdbx2CommitChangeSummary {
  objectType: string;
  objectId: string;
  action: string;
  fields: string[];
}

export interface Mdbx2CommitHistoryItem {
  commitId: string;
  deviceId: string;
  localSeq: number;
  commitKind: string;
  changeScope: string;
  createdAt: string;
  operationId?: string;
  operationKind?: string;
  branchName?: string;
  message?: string;
  changes: Mdbx2CommitChangeSummary[];
  parentIds: string[];
  legacy: boolean;
}

export interface Mdbx2CommitHistoryPage {
  items: Mdbx2CommitHistoryItem[];
  nextCursor?: string;
}

export interface Mdbx2CommitDiffItem {
  commitId: string;
  objectType: string;
  objectId: string;
  collectionId?: string;
  previousTitle?: string;
  currentTitle?: string;
  previousDeleted?: boolean;
  currentDeleted: boolean;
  changedFields: string[];
  payloadChanged: boolean;
  contentType?: string;
  createdAt: string;
}

export interface Mdbx2CommitDiffResult {
  items: Mdbx2CommitDiffItem[];
}

export interface Mdbx2CommitRevertResult {
  operationId: string;
  commitId: string;
  revertedObjectCount: number;
}

export type Mdbx2SnapshotKind = "manual" | "automatic";
export type Mdbx2SnapshotStructureSide = "current" | "snapshot";
export type Mdbx2SnapshotNodeType = "folder" | "entry";
export type Mdbx2SnapshotNodeStatus = "unchanged" | "added" | "removed" | "modified";

export interface Mdbx2ManagedSnapshotSummary {
  snapshotId: string;
  baseCommitId: string;
  name: string;
  kind: Mdbx2SnapshotKind;
  isFull: boolean;
  payloadBytes: number;
  createdAt: string;
  createdByDeviceId: string;
  autoPrune: boolean;
  integrityOk: boolean;
}

export interface Mdbx2ManagedSnapshotPage {
  items: Mdbx2ManagedSnapshotSummary[];
  nextCursor?: string;
}

export interface Mdbx2SnapshotStructureNode {
  nodeId: string;
  parentNodeId?: string;
  name: string;
  nodeType: Mdbx2SnapshotNodeType;
  path: string;
  status: Mdbx2SnapshotNodeStatus;
  childCount: number;
}

export interface Mdbx2SnapshotStructurePage {
  snapshotId: string;
  side: Mdbx2SnapshotStructureSide;
  currentItemCount: number;
  snapshotItemCount: number;
  totalNodes: number;
  items: Mdbx2SnapshotStructureNode[];
  nextCursor?: string;
}

export interface Mdbx2SnapshotPrunePlan {
  planToken: string;
  keepLatest: number;
  candidateCount: number;
  hasMore: boolean;
  totalCiphertextBytes: number;
}

export interface Mdbx2SnapshotPruneResult {
  planToken: string;
  commitId: string;
  deletedSnapshotCount: number;
}

export interface Mdbx2SnapshotCreateResult {
  operationId: string;
  snapshotId: string;
  commitId: string;
  alreadyCompleted: boolean;
}

export interface Mdbx2SnapshotDeleteResult {
  operationId: string;
  snapshotId: string;
  commitId?: string;
  alreadyCompleted: boolean;
}

export interface Mdbx2SnapshotRestoreResult {
  operationId: string;
  snapshotId: string;
  commitId: string;
  affectedObjectCount: number;
  alreadyCompleted: boolean;
}

export type Mdbx2ConflictResolutionChoice = "local-wins" | "incoming-wins";

export interface Mdbx2ConflictSummary {
  conflictId: string;
  objectType: string;
  objectId: string;
  displayTitle?: string;
  contentType?: string;
  conflictingFields: string[];
  createdAt: string;
}

export interface Mdbx2ConflictSummaryPage {
  items: Mdbx2ConflictSummary[];
  nextCursor?: string;
}

export interface Mdbx2ConflictResolutionResult {
  resolved: true;
  alreadyResolved: boolean;
  conflictId: string;
  objectType: string;
  objectId: string;
  choice: Mdbx2ConflictResolutionChoice;
  resolvedAt?: string;
}

export interface Mdbx2NativeRequest<M extends Mdbx2NativeMethod = Mdbx2NativeMethod> {
  protocol: typeof MDBX2_NATIVE_PROTOCOL_VERSION;
  requestId: string;
  method: M;
  params: Record<string, unknown>;
}

export interface Mdbx2NativeErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

export type Mdbx2NativeResponse<T = unknown> =
  | { protocol: typeof MDBX2_NATIVE_PROTOCOL_VERSION; requestId: string; ok: true; result: T }
  | { protocol: typeof MDBX2_NATIVE_PROTOCOL_VERSION; requestId: string; ok: false; error: Mdbx2NativeErrorPayload };

export interface Mdbx2HostCapabilities {
  hostName: typeof MDBX2_NATIVE_HOST_NAME;
  hostVersion: string;
  protocolVersion: typeof MDBX2_NATIVE_PROTOCOL_VERSION;
  mdbxCoreRevision: typeof MDBX2_CORE_REVISION;
  mdbxEngineVersion: typeof MDBX2_ENGINE_VERSION;
  mdbxFormatVersion: typeof MDBX2_FORMAT_VERSION;
  supportsMdbx1: false;
  maxBinaryChunkBytes: typeof MDBX2_MAX_BINARY_CHUNK_BYTES;
  maxInboundFileBytes: typeof MDBX2_MAX_INBOUND_FILE_BYTES;
  maxActiveTransfers: typeof MDBX2_MAX_ACTIVE_TRANSFERS;
  maxObjectPayloadBytes: typeof MDBX2_MAX_OBJECT_PAYLOAD_BYTES;
  maxSummaryPageSize: typeof MDBX2_MAX_SUMMARY_PAGE_SIZE;
  maxCollectionTitleBytes: typeof MDBX2_MAX_COLLECTION_TITLE_BYTES;
  maxCollectionResultBytes: typeof MDBX2_MAX_COLLECTION_RESULT_BYTES;
  supportsCollectionMutation: true;
  maxVaultDiagnosticCategories: typeof MDBX2_MAX_VAULT_DIAGNOSTIC_CATEGORIES;
  maxVaultHealthIssueKinds: typeof MDBX2_MAX_VAULT_HEALTH_ISSUE_KINDS;
  maxVaultDiagnosticsResultBytes: typeof MDBX2_MAX_VAULT_DIAGNOSTICS_RESULT_BYTES;
  supportsVaultDiagnostics: true;
  supportsVaultHealthIssueKinds: true;
  maxHealthRepairItems: typeof MDBX2_MAX_HEALTH_REPAIR_ITEMS;
  maxHealthRepairConflicts: typeof MDBX2_MAX_HEALTH_REPAIR_CONFLICTS;
  maxHealthRepairResultBytes: typeof MDBX2_MAX_HEALTH_REPAIR_RESULT_BYTES;
  supportsHealthRepair: true;
  maxVaultTigaResultBytes: typeof MDBX2_MAX_VAULT_TIGA_RESULT_BYTES;
  maxVaultTigaUnlockMethods: typeof MDBX2_MAX_VAULT_TIGA_UNLOCK_METHODS;
  maxVaultTigaBrowserLimitations: typeof MDBX2_MAX_VAULT_TIGA_BROWSER_LIMITATIONS;
  supportsVaultTigaPosture: true;
  maxObjectBatchMutations: typeof MDBX2_MAX_OBJECT_BATCH_MUTATIONS;
  maxObjectBatchIntentBytes: typeof MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES;
  maxHistoryPageSize: typeof MDBX2_MAX_HISTORY_PAGE_SIZE;
  maxHistoryResultBytes: typeof MDBX2_MAX_HISTORY_RESULT_BYTES;
  supportsHistoryDiff: true;
  maxHistoryRevertItems: typeof MDBX2_MAX_HISTORY_REVERT_ITEMS;
  supportsHistoryRevert: true;
  maxSnapshotPageSize: typeof MDBX2_MAX_SNAPSHOT_PAGE_SIZE;
  maxSnapshotStructurePageSize: typeof MDBX2_MAX_SNAPSHOT_STRUCTURE_PAGE_SIZE;
  maxSnapshotResultBytes: typeof MDBX2_MAX_SNAPSHOT_RESULT_BYTES;
  maxSnapshotNameBytes: typeof MDBX2_MAX_SNAPSHOT_NAME_BYTES;
  maxSnapshotPruneCandidates: typeof MDBX2_MAX_SNAPSHOT_PRUNE_CANDIDATES;
  maxSnapshotPruneKeepLatest: typeof MDBX2_MAX_SNAPSHOT_PRUNE_KEEP_LATEST;
  supportsSnapshotStructure: true;
  supportsSnapshotMutation: true;
  supportsSnapshotPrune: true;
  maxConflictPageSize: typeof MDBX2_MAX_CONFLICT_PAGE_SIZE;
  maxConflictResultBytes: typeof MDBX2_MAX_CONFLICT_RESULT_BYTES;
  supportsConflictResolution: true;
  maxAttachmentBytes: typeof MDBX2_MAX_ATTACHMENT_BYTES;
  maxAttachmentPageSize: typeof MDBX2_MAX_ATTACHMENT_PAGE_SIZE;
  maxAttachmentSessions: typeof MDBX2_MAX_ATTACHMENT_SESSIONS;
  maxAttachmentMemoryBytes: typeof MDBX2_MAX_ATTACHMENT_MEMORY_BYTES;
  supportsAttachmentManagement: true;
  supportsDurableCloudSync: true;
  maxSyncSegmentPageSize: typeof MDBX2_SYNC_SEGMENT_PAGE_SIZE;
  maxBlobReferencePageSize: typeof MDBX2_BLOB_REFERENCE_PAGE_SIZE;
  maxRemoteBlobBytes: typeof MDBX2_MAX_REMOTE_BLOB_BYTES;
  supportedUnlockMethods: Mdbx2UnlockMethod[];
  storageProfile: string;
  syncProfile: string;
  syncProtocolVersion: typeof MDBX2_SYNC_PROTOCOL_VERSION;
  enabledStorageCapabilityIds: string[];
  enabledSyncCapabilityIds: string[];
  supportsWindowsHello: boolean;
  windowsHelloProtocolVersion: typeof MDBX2_WINDOWS_HELLO_PROTOCOL_VERSION;
  windowsHelloRpId: typeof MDBX2_WINDOWS_HELLO_RP_ID;
}

export type Mdbx2WindowsHelloReason = "windows-only" | "platform-authenticator-unavailable" | "not-enrolled" | "ready";

export interface Mdbx2WindowsHelloStatus {
  version: typeof MDBX2_WINDOWS_HELLO_PROTOCOL_VERSION;
  supported: boolean;
  available: boolean;
  enrolled: boolean;
  bindingIdPresent: boolean;
  rpId: typeof MDBX2_WINDOWS_HELLO_RP_ID;
  reason: Mdbx2WindowsHelloReason;
}

export interface Mdbx2WindowsHelloEnrollment {
  version: typeof MDBX2_WINDOWS_HELLO_PROTOCOL_VERSION;
  bindingId: string;
  rpId: typeof MDBX2_WINDOWS_HELLO_RP_ID;
  enrolledAtUnixSeconds: number;
  verified: true;
}

export interface Mdbx2WindowsHelloVerification {
  version: typeof MDBX2_WINDOWS_HELLO_PROTOCOL_VERSION;
  verified: true;
  bindingId: string;
  proofId: string;
  expiresAtUnixSeconds: number;
}

export type Mdbx2HostAvailability = "ready" | "not-installed" | "incompatible" | "unavailable";

export interface Mdbx2HostStatus {
  availability: Mdbx2HostAvailability;
  hostName: typeof MDBX2_NATIVE_HOST_NAME;
  message: string;
  capabilities?: Mdbx2HostCapabilities;
}

export class Mdbx2NativeHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "Mdbx2NativeHostError";
  }
}

export function parseMdbx2NativeResponse(input: unknown): Mdbx2NativeResponse {
  const response = objectValue(input, "Native Host 返回了无效响应。");
  if (response.protocol !== MDBX2_NATIVE_PROTOCOL_VERSION) {
    throw incompatible("Native Host 协议版本与插件不一致。");
  }
  const requestId = boundedIdentifier(response.requestId, 128, "Native Host 响应缺少有效请求 ID。");
  if (response.ok === true) {
    if (!("result" in response)) throw incompatible("Native Host 成功响应缺少结果。");
    return { protocol: MDBX2_NATIVE_PROTOCOL_VERSION, requestId, ok: true, result: response.result };
  }
  if (response.ok !== false) throw incompatible("Native Host 响应状态无效。");
  const error = objectValue(response.error, "Native Host 错误响应格式无效。");
  return {
    protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: {
      code: boundedIdentifier(error.code, 128, "Native Host 错误代码无效。"),
      message: boundedString(error.message, 512, "Native Host 错误消息无效。"),
      retryable: booleanValue(error.retryable, "Native Host 错误重试标记无效。")
    }
  };
}

export function validateMdbx2HostCapabilities(input: unknown): Mdbx2HostCapabilities {
  const value = objectValue(input, "Native Host 能力清单无效。");
  if (value.hostName !== MDBX2_NATIVE_HOST_NAME) throw incompatible("Native Host 名称与 Monica MDBX2 不匹配。");
  if (value.protocolVersion !== MDBX2_NATIVE_PROTOCOL_VERSION) throw incompatible("Native Host 协议版本与插件不一致。");
  if (value.mdbxCoreRevision !== MDBX2_CORE_REVISION) throw incompatible("Native Host 使用了未经审核的 MDBX2 核心版本。");
  if (value.mdbxEngineVersion !== MDBX2_ENGINE_VERSION) throw incompatible("Native Host MDBX2 引擎版本与插件不一致。");
  if (value.mdbxFormatVersion !== MDBX2_FORMAT_VERSION) throw incompatible("Native Host 未声明 MDBX-2 格式支持。");
  if (value.supportsMdbx1 !== false) throw incompatible("Native Host 错误声明了 MDBX1 支持。");
  if (value.maxBinaryChunkBytes !== MDBX2_MAX_BINARY_CHUNK_BYTES) throw incompatible("Native Host 二进制分块限制与插件不一致。");
  if (value.maxInboundFileBytes !== MDBX2_MAX_INBOUND_FILE_BYTES) throw incompatible("Native Host 文件大小限制与插件不一致。");
  if (value.maxActiveTransfers !== MDBX2_MAX_ACTIVE_TRANSFERS) throw incompatible("Native Host 并发传输限制与插件不一致。");
  if (value.maxObjectPayloadBytes !== MDBX2_MAX_OBJECT_PAYLOAD_BYTES) throw incompatible("Native Host Object 载荷限制与插件不一致。");
  if (value.maxSummaryPageSize !== MDBX2_MAX_SUMMARY_PAGE_SIZE) throw incompatible("Native Host 摘要分页限制与插件不一致。");
  if (value.maxCollectionTitleBytes !== MDBX2_MAX_COLLECTION_TITLE_BYTES) throw incompatible("Native Host Collection 标题限制与插件不一致。");
  if (value.maxCollectionResultBytes !== MDBX2_MAX_COLLECTION_RESULT_BYTES) throw incompatible("Native Host Collection 响应限制与插件不一致。");
  if (value.supportsCollectionMutation !== true) throw incompatible("Native Host 未启用 MDBX2 Collection 管理能力。");
  if (value.maxVaultDiagnosticCategories !== MDBX2_MAX_VAULT_DIAGNOSTIC_CATEGORIES) throw incompatible("Native Host 诊断类别限制与插件不一致。");
  if (value.maxVaultHealthIssueKinds !== MDBX2_MAX_VAULT_HEALTH_ISSUE_KINDS) throw incompatible("Native Host 诊断原因限制与插件不一致。");
  if (value.maxVaultDiagnosticsResultBytes !== MDBX2_MAX_VAULT_DIAGNOSTICS_RESULT_BYTES) throw incompatible("Native Host 诊断响应限制与插件不一致。");
  if (value.supportsVaultDiagnostics !== true) throw incompatible("Native Host 未启用 MDBX2 诊断刷新能力。");
  if (value.supportsVaultHealthIssueKinds !== true) throw incompatible("Native Host 未启用 MDBX2 脱敏诊断原因能力。");
  if (value.maxHealthRepairItems !== MDBX2_MAX_HEALTH_REPAIR_ITEMS) throw incompatible("Native Host 健康修复数量限制与插件不一致。");
  if (value.maxHealthRepairConflicts !== MDBX2_MAX_HEALTH_REPAIR_CONFLICTS) throw incompatible("Native Host 健康修复冲突限制与插件不一致。");
  if (value.maxHealthRepairResultBytes !== MDBX2_MAX_HEALTH_REPAIR_RESULT_BYTES) throw incompatible("Native Host 健康修复响应限制与插件不一致。");
  if (value.supportsHealthRepair !== true) throw incompatible("Native Host 未启用 MDBX2 健康修复能力。");
  if (value.maxVaultTigaResultBytes !== MDBX2_MAX_VAULT_TIGA_RESULT_BYTES) throw incompatible("Native Host Tiga 响应限制与插件不一致。");
  if (value.maxVaultTigaUnlockMethods !== MDBX2_MAX_VAULT_TIGA_UNLOCK_METHODS) throw incompatible("Native Host Tiga 解锁方式限制与插件不一致。");
  if (value.maxVaultTigaBrowserLimitations !== MDBX2_MAX_VAULT_TIGA_BROWSER_LIMITATIONS) throw incompatible("Native Host Tiga 浏览器限制数量与插件不一致。");
  if (value.supportsVaultTigaPosture !== true) throw incompatible("Native Host 未启用 MDBX2 Tiga 安全态势能力。");
  if (value.maxObjectBatchMutations !== MDBX2_MAX_OBJECT_BATCH_MUTATIONS) throw incompatible("Native Host Object 批量数量限制与插件不一致。");
  if (value.maxObjectBatchIntentBytes !== MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES) throw incompatible("Native Host Object 批量大小限制与插件不一致。");
  if (value.maxHistoryPageSize !== MDBX2_MAX_HISTORY_PAGE_SIZE) throw incompatible("Native Host 历史分页限制与插件不一致。");
  if (value.maxHistoryResultBytes !== MDBX2_MAX_HISTORY_RESULT_BYTES) throw incompatible("Native Host 历史响应限制与插件不一致。");
  if (value.supportsHistoryDiff !== true) throw incompatible("Native Host 未启用 MDBX2 历史差异能力。");
  if (value.maxHistoryRevertItems !== MDBX2_MAX_HISTORY_REVERT_ITEMS) throw incompatible("Native Host 历史恢复数量限制与插件不一致。");
  if (value.supportsHistoryRevert !== true) throw incompatible("Native Host 未启用 MDBX2 历史恢复能力。");
  if (value.maxSnapshotPageSize !== MDBX2_MAX_SNAPSHOT_PAGE_SIZE) throw incompatible("Native Host 快照分页限制与插件不一致。");
  if (value.maxSnapshotStructurePageSize !== MDBX2_MAX_SNAPSHOT_STRUCTURE_PAGE_SIZE) throw incompatible("Native Host 快照结构分页限制与插件不一致。");
  if (value.maxSnapshotResultBytes !== MDBX2_MAX_SNAPSHOT_RESULT_BYTES) throw incompatible("Native Host 快照响应限制与插件不一致。");
  if (value.maxSnapshotNameBytes !== MDBX2_MAX_SNAPSHOT_NAME_BYTES) throw incompatible("Native Host 快照名称限制与插件不一致。");
  if (value.maxSnapshotPruneCandidates !== MDBX2_MAX_SNAPSHOT_PRUNE_CANDIDATES) throw incompatible("Native Host 自动快照清理数量限制与插件不一致。");
  if (value.maxSnapshotPruneKeepLatest !== MDBX2_MAX_SNAPSHOT_PRUNE_KEEP_LATEST) throw incompatible("Native Host 自动快照保留限制与插件不一致。");
  if (value.supportsSnapshotStructure !== true) throw incompatible("Native Host 未启用 MDBX2 快照结构能力。");
  if (value.supportsSnapshotMutation !== true) throw incompatible("Native Host 未启用 MDBX2 快照管理能力。");
  if (value.supportsSnapshotPrune !== true) throw incompatible("Native Host 未启用 MDBX2 自动快照清理能力。");
  if (value.maxConflictPageSize !== MDBX2_MAX_CONFLICT_PAGE_SIZE) throw incompatible("Native Host 冲突分页限制与插件不一致。");
  if (value.maxConflictResultBytes !== MDBX2_MAX_CONFLICT_RESULT_BYTES) throw incompatible("Native Host 冲突响应限制与插件不一致。");
  if (value.supportsConflictResolution !== true) throw incompatible("Native Host 未启用 MDBX2 冲突解决能力。");
  if (value.maxAttachmentBytes !== MDBX2_MAX_ATTACHMENT_BYTES) throw incompatible("Native Host 附件大小限制与插件不一致。");
  if (value.maxAttachmentPageSize !== MDBX2_MAX_ATTACHMENT_PAGE_SIZE) throw incompatible("Native Host 附件分页限制与插件不一致。");
  if (value.maxAttachmentSessions !== MDBX2_MAX_ATTACHMENT_SESSIONS) throw incompatible("Native Host 附件会话限制与插件不一致。");
  if (value.maxAttachmentMemoryBytes !== MDBX2_MAX_ATTACHMENT_MEMORY_BYTES) throw incompatible("Native Host 附件内存限制与插件不一致。");
  if (value.supportsAttachmentManagement !== true) throw incompatible("Native Host 未启用 MDBX2 附件管理能力。");
  if (value.supportsDurableCloudSync !== true) throw incompatible("Native Host 未启用 MDBX2 持久增量同步。");
  if (value.maxSyncSegmentPageSize !== MDBX2_SYNC_SEGMENT_PAGE_SIZE) throw incompatible("Native Host 增量段分页限制与插件不一致。");
  if (value.maxBlobReferencePageSize !== MDBX2_BLOB_REFERENCE_PAGE_SIZE) throw incompatible("Native Host Blob 分页限制与插件不一致。");
  if (value.maxRemoteBlobBytes !== MDBX2_MAX_REMOTE_BLOB_BYTES) throw incompatible("Native Host Blob 大小限制与插件不一致。");
  if (value.syncProtocolVersion !== MDBX2_SYNC_PROTOCOL_VERSION) throw incompatible("Native Host 同步协议版本与插件不一致。");
  if (typeof value.supportsWindowsHello !== "boolean") throw incompatible("Native Host Windows Hello 能力标记无效。");
  if (value.windowsHelloProtocolVersion !== MDBX2_WINDOWS_HELLO_PROTOCOL_VERSION) throw incompatible("Native Host Windows Hello 协议版本不匹配。");
  if (value.windowsHelloRpId !== MDBX2_WINDOWS_HELLO_RP_ID) throw incompatible("Native Host Windows Hello RP ID 不匹配。");
  const supportedUnlockMethods = stringArray(value.supportedUnlockMethods, 8, 64, "Native Host 解锁方式列表无效。") as Mdbx2UnlockMethod[];
  if (JSON.stringify(supportedUnlockMethods) !== JSON.stringify(["password", "security-key", "password-security-key"])) {
    throw incompatible("Native Host 解锁方式与插件不一致。");
  }
  return {
    hostName: MDBX2_NATIVE_HOST_NAME,
    hostVersion: boundedString(value.hostVersion, 64, "Native Host 版本无效。"),
    protocolVersion: MDBX2_NATIVE_PROTOCOL_VERSION,
    mdbxCoreRevision: MDBX2_CORE_REVISION,
    mdbxEngineVersion: MDBX2_ENGINE_VERSION,
    mdbxFormatVersion: MDBX2_FORMAT_VERSION,
    supportsMdbx1: false,
    maxBinaryChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES,
    maxInboundFileBytes: MDBX2_MAX_INBOUND_FILE_BYTES,
    maxActiveTransfers: MDBX2_MAX_ACTIVE_TRANSFERS,
    maxObjectPayloadBytes: MDBX2_MAX_OBJECT_PAYLOAD_BYTES,
    maxSummaryPageSize: MDBX2_MAX_SUMMARY_PAGE_SIZE,
    maxCollectionTitleBytes: MDBX2_MAX_COLLECTION_TITLE_BYTES,
    maxCollectionResultBytes: MDBX2_MAX_COLLECTION_RESULT_BYTES,
    supportsCollectionMutation: true,
    maxVaultDiagnosticCategories: MDBX2_MAX_VAULT_DIAGNOSTIC_CATEGORIES,
    maxVaultHealthIssueKinds: MDBX2_MAX_VAULT_HEALTH_ISSUE_KINDS,
    maxVaultDiagnosticsResultBytes: MDBX2_MAX_VAULT_DIAGNOSTICS_RESULT_BYTES,
    supportsVaultDiagnostics: true,
    supportsVaultHealthIssueKinds: true,
    maxHealthRepairItems: MDBX2_MAX_HEALTH_REPAIR_ITEMS,
    maxHealthRepairConflicts: MDBX2_MAX_HEALTH_REPAIR_CONFLICTS,
    maxHealthRepairResultBytes: MDBX2_MAX_HEALTH_REPAIR_RESULT_BYTES,
    supportsHealthRepair: true,
    maxVaultTigaResultBytes: MDBX2_MAX_VAULT_TIGA_RESULT_BYTES,
    maxVaultTigaUnlockMethods: MDBX2_MAX_VAULT_TIGA_UNLOCK_METHODS,
    maxVaultTigaBrowserLimitations: MDBX2_MAX_VAULT_TIGA_BROWSER_LIMITATIONS,
    supportsVaultTigaPosture: true,
    maxObjectBatchMutations: MDBX2_MAX_OBJECT_BATCH_MUTATIONS,
    maxObjectBatchIntentBytes: MDBX2_MAX_OBJECT_BATCH_INTENT_BYTES,
    maxHistoryPageSize: MDBX2_MAX_HISTORY_PAGE_SIZE,
    maxHistoryResultBytes: MDBX2_MAX_HISTORY_RESULT_BYTES,
    supportsHistoryDiff: true,
    maxHistoryRevertItems: MDBX2_MAX_HISTORY_REVERT_ITEMS,
    supportsHistoryRevert: true,
    maxSnapshotPageSize: MDBX2_MAX_SNAPSHOT_PAGE_SIZE,
    maxSnapshotStructurePageSize: MDBX2_MAX_SNAPSHOT_STRUCTURE_PAGE_SIZE,
    maxSnapshotResultBytes: MDBX2_MAX_SNAPSHOT_RESULT_BYTES,
    maxSnapshotNameBytes: MDBX2_MAX_SNAPSHOT_NAME_BYTES,
    maxSnapshotPruneCandidates: MDBX2_MAX_SNAPSHOT_PRUNE_CANDIDATES,
    maxSnapshotPruneKeepLatest: MDBX2_MAX_SNAPSHOT_PRUNE_KEEP_LATEST,
    supportsSnapshotStructure: true,
    supportsSnapshotMutation: true,
    supportsSnapshotPrune: true,
    maxConflictPageSize: MDBX2_MAX_CONFLICT_PAGE_SIZE,
    maxConflictResultBytes: MDBX2_MAX_CONFLICT_RESULT_BYTES,
    supportsConflictResolution: true,
    maxAttachmentBytes: MDBX2_MAX_ATTACHMENT_BYTES,
    maxAttachmentPageSize: MDBX2_MAX_ATTACHMENT_PAGE_SIZE,
    maxAttachmentSessions: MDBX2_MAX_ATTACHMENT_SESSIONS,
    maxAttachmentMemoryBytes: MDBX2_MAX_ATTACHMENT_MEMORY_BYTES,
    supportsAttachmentManagement: true,
    supportsDurableCloudSync: true,
    maxSyncSegmentPageSize: MDBX2_SYNC_SEGMENT_PAGE_SIZE,
    maxBlobReferencePageSize: MDBX2_BLOB_REFERENCE_PAGE_SIZE,
    maxRemoteBlobBytes: MDBX2_MAX_REMOTE_BLOB_BYTES,
    supportedUnlockMethods,
    storageProfile: boundedString(value.storageProfile, 128, "Native Host 存储能力配置无效。"),
    syncProfile: boundedString(value.syncProfile, 128, "Native Host 同步能力配置无效。"),
    syncProtocolVersion: MDBX2_SYNC_PROTOCOL_VERSION,
    enabledStorageCapabilityIds: capabilityIds(value.enabledStorageCapabilityIds, "存储"),
    enabledSyncCapabilityIds: capabilityIds(value.enabledSyncCapabilityIds, "同步"),
    supportsWindowsHello: value.supportsWindowsHello,
    windowsHelloProtocolVersion: MDBX2_WINDOWS_HELLO_PROTOCOL_VERSION,
    windowsHelloRpId: MDBX2_WINDOWS_HELLO_RP_ID
  };
}

export function mdbx2NativeConnectionError(error: unknown): Mdbx2NativeHostError {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Native Host 连接失败。";
  const normalized = message.toLocaleLowerCase();
  if (normalized.includes("native messaging host not found") || normalized.includes("specified native messaging host not found")) {
    return new Mdbx2NativeHostError("native-host-not-installed", "尚未安装 Monica MDBX2 Native Host。", false);
  }
  if (normalized.includes("forbidden") || normalized.includes("not allowed")) {
    return new Mdbx2NativeHostError("native-host-forbidden", "Native Host 未授权当前 Monica 插件 ID。", false);
  }
  return new Mdbx2NativeHostError("native-host-disconnected", "Native Host 连接已断开。", true);
}

function incompatible(message: string): Mdbx2NativeHostError {
  return new Mdbx2NativeHostError("native-host-incompatible", message, false);
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw incompatible(message);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maxBytes: number, message: string): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > maxBytes) throw incompatible(message);
  return value;
}

function boundedIdentifier(value: unknown, maxBytes: number, message: string): string {
  const text = boundedString(value, maxBytes, message);
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) throw incompatible(message);
  return text;
}

function booleanValue(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") throw incompatible(message);
  return value;
}

function capabilityIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 128) throw incompatible(`Native Host ${label}能力列表无效。`);
  return value.map((entry) => boundedIdentifier(entry, 128, `Native Host ${label}能力标识无效。`));
}

function stringArray(value: unknown, maxItems: number, maxBytes: number, message: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw incompatible(message);
  return value.map((entry) => boundedString(entry, maxBytes, message));
}
