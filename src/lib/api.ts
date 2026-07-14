import type { MessageKey } from "../i18n";

export type SyncState =
  | "healthy"
  | "attention"
  | "failed"
  | "pending"
  | "syncing"
  | "conflict"
  | "local-only"
  | "remote-changed";

export type EntryType =
  | "login"
  | "note"
  | "card"
  | "identity"
  | "totp"
  | "passkey"
  | "ssh-key"
  | "api-token"
  | "document-ref";

export type ProjectKind = "password" | "secure-note" | "wallet" | "identity" | "totp" | "passkey" | "ssh-key" | "api-token" | "document";
export type TigaMode = "power" | "multi" | "sky";
export type StorageMode = "embedded-inline" | "embedded-chunked" | "external-hash-ref";
export type SendType = "text" | "file";

export interface AccountProfile {
  email: string;
  displayName: string;
  role: "owner" | "admin" | "member";
  serverUrl: string;
  plan: string;
}

export interface ServerMetric {
  labelKey: MessageKey;
  value: string;
  detailKey: MessageKey;
  state: SyncState;
}

export interface CategoryRecord {
  id: string;
  name: string;
  sortOrder: number;
  projectCount: number;
  mdbxDatabaseId?: string;
  mdbxFolderId?: string;
}

export interface VaultProject {
  id: string;
  vaultId: string;
  organizationId?: string;
  collectionId?: string;
  folderId?: string;
  categoryId?: string;
  title: string;
  subtitle: string;
  kind: ProjectKind;
  tags: string[];
  favorite: boolean;
  archived: boolean;
  deleted: boolean;
  syncStatus: SyncState;
  tigaMode: TigaMode;
  entryCount: number;
  attachmentCount: number;
  imageCount: number;
  customFieldCount: number;
  passkeyCount: number;
  updatedAt: string;
  createdAt: string;
  lastOpenedAt?: string;
}

export interface VaultEntry {
  id: string;
  projectId: string;
  type: EntryType;
  label: string;
  valuePreview: string;
  protected: boolean;
  schemaVersion: number;
  syncStatus: SyncState;
  updatedAt: string;
}

export interface AttachmentRecord {
  id: string;
  projectId: string;
  entryId?: string;
  ownerType: "password" | "secure-item" | "project" | "send";
  fileName: string;
  contentType: string;
  sizeBytes: number;
  storageMode: StorageMode;
  contentHash: string;
  isImage: boolean;
  createdAt: string;
  syncStatus: SyncState;
}

export interface SendRecord {
  id: string;
  name: string;
  type: SendType;
  notes: string;
  protected: boolean;
  passwordRequired: boolean;
  disabled: boolean;
  hideEmail: boolean;
  maxAccessCount?: number;
  accessCount: number;
  sizeBytes?: number;
  fileName?: string;
  expirationAt?: string;
  deletionAt: string;
  createdAt: string;
}

export interface OrganizationRecord {
  id: string;
  name: string;
  ownerEmail: string;
  seatsUsed: number;
  seatsLimit: number;
  collections: number;
  projects: number;
  storageBytes: number;
  state: SyncState;
}

export interface CollectionRecord {
  id: string;
  organizationId: string;
  name: string;
  projectCount: number;
  memberCount: number;
  policy: string;
  updatedAt: string;
}

export interface MemberRecord {
  id: string;
  organizationId: string;
  email: string;
  displayName: string;
  role: "owner" | "admin" | "manager" | "member";
  status: "accepted" | "invited" | "pending";
  groups: string[];
  lastActiveAt: string;
}

export interface PolicyRecord {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  enabled: boolean;
  state: SyncState;
}

export interface BackupRecord {
  id: string;
  vaultId: string;
  fileName: string;
  kind: "manual" | "scheduled" | "desktop" | "mobile" | "server";
  format: "encrypted-json" | "mdbx-file" | "sync-bundle" | "snapshot";
  sizeBytes: number;
  createdAt: string;
  deviceName: string;
  state: SyncState;
}

export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  appVersion: string;
  lastSeenAt: string;
  trustState: "trusted" | "pending" | "revoked";
  syncState: SyncState;
  branchHead: string;
  knownCommits: number;
  ipAddress: string;
}

export interface AuditEvent {
  id: string;
  actor: string;
  action: string;
  target: string;
  itemType: string;
  createdAt: string;
  ipAddress: string;
  state: SyncState;
}

export interface TimelineEntry {
  id: string;
  itemType: string;
  itemTitle: string;
  operationType: "CREATE" | "UPDATE" | "ATTACHMENT" | "IMPORT" | "EXPORT" | "SYNC" | "DELETE" | "RESTORE";
  deviceName: string;
  createdAt: string;
  reverted: boolean;
  state: SyncState;
}

export interface SyncJob {
  id: string;
  vaultName: string;
  type: "upload" | "download" | "retention" | "bundle" | "snapshot" | "conflict-scan";
  progress: number;
  queuedAt: string;
  state: SyncState;
}

export interface SyncSource {
  id: string;
  name: string;
  type: "Monica Server" | "WebDAV" | "OneDrive" | "Local";
  rootPath: string;
  enabled: boolean;
  lastSyncAt?: string;
  include: string[];
  state: SyncState;
}

export interface MdbxDatabaseRecord {
  id: string;
  name: string;
  filePath: string;
  storageLocation: "RemoteWebDav" | "Local" | "MonicaServer" | "OneDrive";
  sourceType: "REMOTE_WEBDAV" | "LOCAL_FILE" | "MONICA_SERVER" | "ONEDRIVE";
  tigaMode: TigaMode;
  unlockMethod: "MasterPassword" | "KeyFile" | "PlatformCredential";
  kdfProfile: string;
  projectCount: number;
  branchCount: number;
  snapshotCount: number;
  lastSyncedAt?: string;
  offlineAvailable: boolean;
  state: SyncState;
}

export interface BranchHeadRecord {
  id: string;
  vaultId: string;
  branchName: string;
  headCommitId: string;
  deviceName: string;
  commitsAhead: number;
  commitsBehind: number;
  updatedAt: string;
  state: SyncState;
}

export interface ConflictRecord {
  id: string;
  vaultId: string;
  objectType: "project" | "entry" | "attachment";
  objectTitle: string;
  localDevice: string;
  remoteDevice: string;
  localCommit: string;
  remoteCommit: string;
  detectedAt: string;
  state: SyncState;
}

export interface SnapshotRecord {
  id: string;
  vaultId: string;
  name: string;
  commitId: string;
  projectCount: number;
  entryCount: number;
  attachmentCount: number;
  sizeBytes: number;
  createdAt: string;
  state: SyncState;
}

export interface SecurityIssue {
  id: string;
  type: "weak" | "duplicate" | "stale" | "compromised" | "missing-2fa" | "attachment-risk";
  title: string;
  affectedCount: number;
  severity: "low" | "medium" | "high" | "critical";
  state: SyncState;
}

export interface GeneratorPreset {
  id: string;
  name: string;
  length: number;
  modes: string[];
  updatedAt: string;
}

export interface ImportExportJob {
  id: string;
  direction: "import" | "export";
  format: "Monica JSON" | "CSV" | "Bitwarden JSON" | "KeePass KDBX" | "Aegis JSON" | "Markdown";
  itemScope: string;
  fileName: string;
  progress: number;
  createdAt: string;
  state: SyncState;
}

export interface DiagnosticRecord {
  id: string;
  name: string;
  value: string;
  detail: string;
  state: SyncState;
}

export interface ApiContractRoute {
  method: "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
  path: string;
  description: string;
}

export interface MonicaServerSnapshot {
  profile: AccountProfile;
  metrics: ServerMetric[];
  categories: CategoryRecord[];
  projects: VaultProject[];
  entries: VaultEntry[];
  attachments: AttachmentRecord[];
  sends: SendRecord[];
  organizations: OrganizationRecord[];
  collections: CollectionRecord[];
  members: MemberRecord[];
  policies: PolicyRecord[];
  backups: BackupRecord[];
  devices: DeviceRecord[];
  auditEvents: AuditEvent[];
  timeline: TimelineEntry[];
  syncJobs: SyncJob[];
  syncSources: SyncSource[];
  mdbxDatabases: MdbxDatabaseRecord[];
  branches: BranchHeadRecord[];
  conflicts: ConflictRecord[];
  snapshots: SnapshotRecord[];
  securityIssues: SecurityIssue[];
  generatorPresets: GeneratorPreset[];
  importExportJobs: ImportExportJob[];
  diagnostics: DiagnosticRecord[];
  apiContract: ApiContractRoute[];
}

const now = new Date("2026-06-04T13:38:00.000Z");

const projects: VaultProject[] = [
  {
    id: "project-github",
    vaultId: "vault-main",
    organizationId: "org-personal",
    collectionId: "col-personal-dev",
    folderId: "folder-dev",
    categoryId: "cat-dev",
    title: "GitHub",
    subtitle: "github.com · 密码、Passkey、SSH",
    kind: "password",
    tags: ["developer", "2fa", "passkey"],
    favorite: true,
    archived: false,
    deleted: false,
    syncStatus: "healthy",
    tigaMode: "multi",
    entryCount: 4,
    attachmentCount: 2,
    imageCount: 0,
    customFieldCount: 3,
    passkeyCount: 1,
    updatedAt: minutesAgo(16),
    createdAt: daysAgo(92),
    lastOpenedAt: minutesAgo(40)
  },
  {
    id: "project-router",
    vaultId: "vault-main",
    organizationId: "org-personal",
    collectionId: "col-personal-home",
    folderId: "folder-home",
    categoryId: "cat-home",
    title: "Home Router",
    subtitle: "Wi-Fi、管理员密码、恢复笔记",
    kind: "password",
    tags: ["wifi", "home"],
    favorite: false,
    archived: false,
    deleted: false,
    syncStatus: "attention",
    tigaMode: "sky",
    entryCount: 3,
    attachmentCount: 1,
    imageCount: 1,
    customFieldCount: 2,
    passkeyCount: 0,
    updatedAt: hoursAgo(5),
    createdAt: daysAgo(182)
  },
  {
    id: "project-bank-card",
    vaultId: "vault-main",
    organizationId: "org-personal",
    collectionId: "col-personal-wallet",
    folderId: "folder-wallet",
    categoryId: "cat-wallet",
    title: "Travel Visa",
    subtitle: "银行卡正反面图片",
    kind: "wallet",
    tags: ["card", "travel"],
    favorite: true,
    archived: false,
    deleted: false,
    syncStatus: "healthy",
    tigaMode: "power",
    entryCount: 1,
    attachmentCount: 2,
    imageCount: 2,
    customFieldCount: 1,
    passkeyCount: 0,
    updatedAt: hoursAgo(11),
    createdAt: daysAgo(64)
  },
  {
    id: "project-passport",
    vaultId: "vault-main",
    organizationId: "org-personal",
    collectionId: "col-personal-wallet",
    folderId: "folder-wallet",
    categoryId: "cat-wallet",
    title: "Passport",
    subtitle: "证件信息、扫描件、续期提醒",
    kind: "document",
    tags: ["document", "image"],
    favorite: false,
    archived: false,
    deleted: false,
    syncStatus: "healthy",
    tigaMode: "power",
    entryCount: 2,
    attachmentCount: 3,
    imageCount: 3,
    customFieldCount: 2,
    passkeyCount: 0,
    updatedAt: hoursAgo(23),
    createdAt: daysAgo(300)
  },
  {
    id: "project-seed-note",
    vaultId: "vault-main",
    organizationId: "org-personal",
    collectionId: "col-personal-private",
    folderId: "folder-notes",
    categoryId: "cat-notes",
    title: "Recovery Notes",
    subtitle: "加密笔记和图片",
    kind: "secure-note",
    tags: ["markdown", "recovery"],
    favorite: true,
    archived: false,
    deleted: false,
    syncStatus: "healthy",
    tigaMode: "power",
    entryCount: 1,
    attachmentCount: 2,
    imageCount: 1,
    customFieldCount: 0,
    passkeyCount: 0,
    updatedAt: daysAgo(1),
    createdAt: daysAgo(48)
  },
  {
    id: "project-totp-email",
    vaultId: "vault-main",
    organizationId: "org-personal",
    collectionId: "col-personal-private",
    folderId: "folder-totp",
    categoryId: "cat-dev",
    title: "Email TOTP",
    subtitle: "邮箱验证码",
    kind: "totp",
    tags: ["totp", "email"],
    favorite: false,
    archived: false,
    deleted: false,
    syncStatus: "healthy",
    tigaMode: "multi",
    entryCount: 1,
    attachmentCount: 0,
    imageCount: 0,
    customFieldCount: 0,
    passkeyCount: 0,
    updatedAt: daysAgo(3),
    createdAt: daysAgo(120)
  },
  {
    id: "project-server-ssh",
    vaultId: "vault-main",
    organizationId: "org-personal",
    collectionId: "col-personal-dev",
    folderId: "folder-dev",
    categoryId: "cat-dev",
    title: "Production SSH",
    subtitle: "生产服务器 SSH",
    kind: "ssh-key",
    tags: ["ssh", "server"],
    favorite: false,
    archived: false,
    deleted: false,
    syncStatus: "remote-changed",
    tigaMode: "power",
    entryCount: 2,
    attachmentCount: 1,
    imageCount: 0,
    customFieldCount: 2,
    passkeyCount: 0,
    updatedAt: hoursAgo(7),
    createdAt: daysAgo(88)
  },
  {
    id: "project-api-token",
    vaultId: "vault-main",
    organizationId: "org-personal",
    collectionId: "col-personal-dev",
    folderId: "folder-dev",
    categoryId: "cat-dev",
    title: "CI API Token",
    subtitle: "CI 接口令牌",
    kind: "api-token",
    tags: ["api", "ci"],
    favorite: false,
    archived: false,
    deleted: false,
    syncStatus: "pending",
    tigaMode: "multi",
    entryCount: 1,
    attachmentCount: 0,
    imageCount: 0,
    customFieldCount: 1,
    passkeyCount: 0,
    updatedAt: minutesAgo(52),
    createdAt: daysAgo(22)
  },
  {
    id: "project-family-streaming",
    vaultId: "vault-family",
    organizationId: "org-family",
    collectionId: "col-family-media",
    folderId: "folder-shared",
    categoryId: "cat-family",
    title: "Family Streaming",
    subtitle: "家庭共享账号",
    kind: "password",
    tags: ["family", "shared"],
    favorite: false,
    archived: false,
    deleted: false,
    syncStatus: "conflict",
    tigaMode: "multi",
    entryCount: 2,
    attachmentCount: 0,
    imageCount: 0,
    customFieldCount: 1,
    passkeyCount: 0,
    updatedAt: hoursAgo(3),
    createdAt: daysAgo(74)
  },
  {
    id: "project-old-forum",
    vaultId: "vault-legacy",
    organizationId: "org-personal",
    collectionId: "col-personal-legacy",
    folderId: "folder-archive",
    categoryId: "cat-archive",
    title: "Old Forum",
    subtitle: "已归档的旧账号",
    kind: "password",
    tags: ["legacy"],
    favorite: false,
    archived: true,
    deleted: false,
    syncStatus: "local-only",
    tigaMode: "sky",
    entryCount: 1,
    attachmentCount: 0,
    imageCount: 0,
    customFieldCount: 0,
    passkeyCount: 0,
    updatedAt: daysAgo(21),
    createdAt: daysAgo(1200)
  },
  {
    id: "project-deleted-note",
    vaultId: "vault-main",
    organizationId: "org-personal",
    collectionId: "col-personal-private",
    folderId: "folder-trash",
    categoryId: "cat-notes",
    title: "Old Backup Codes",
    subtitle: "已删除的备用码",
    kind: "secure-note",
    tags: ["deleted"],
    favorite: false,
    archived: false,
    deleted: true,
    syncStatus: "pending",
    tigaMode: "power",
    entryCount: 1,
    attachmentCount: 0,
    imageCount: 0,
    customFieldCount: 0,
    passkeyCount: 0,
    updatedAt: daysAgo(2),
    createdAt: daysAgo(400)
  }
];

const entries: VaultEntry[] = [
  entry("entry-github-login", "project-github", "login", "Username and password", "octo@example.com / ********", true, "healthy", 1, minutesAgo(16)),
  entry("entry-github-passkey", "project-github", "passkey", "Passkey binding", "rpId github.com, discoverable", true, "healthy", 1, minutesAgo(16)),
  entry("entry-github-ssh", "project-github", "ssh-key", "Deploy SSH key", "ed25519 SHA256:uM6...", true, "healthy", 1, daysAgo(9)),
  entry("entry-github-totp", "project-github", "totp", "TOTP seed", "30s / SHA-1 / 6 digits", true, "healthy", 1, daysAgo(9)),
  entry("entry-router-wifi", "project-router", "login", "Wi-Fi password", "SSID HomeLab / ********", true, "attention", 1, hoursAgo(5)),
  entry("entry-router-note", "project-router", "note", "Recovery note", "ISP reset procedure", true, "attention", 1, hoursAgo(5)),
  entry("entry-router-admin", "project-router", "login", "Admin portal", "192.168.1.1 / admin", true, "attention", 1, daysAgo(10)),
  entry("entry-card", "project-bank-card", "card", "银行卡信息", "Visa 尾号 4242", true, "healthy", 1, hoursAgo(11)),
  entry("entry-passport", "project-passport", "document-ref", "护照信息", "证件号 ********", true, "healthy", 1, hoursAgo(23)),
  entry("entry-passport-note", "project-passport", "note", "Renewal note", "Appointment and checklist", true, "healthy", 1, hoursAgo(23)),
  entry("entry-seed-note", "project-seed-note", "note", "恢复笔记", "已加密", true, "healthy", 1, daysAgo(1)),
  entry("entry-email-totp", "project-totp-email", "totp", "Email authenticator", "30s / SHA-1 / 6 digits", true, "healthy", 1, daysAgo(3)),
  entry("entry-prod-ssh", "project-server-ssh", "ssh-key", "Private key", "ed25519 encrypted", true, "remote-changed", 1, hoursAgo(7)),
  entry("entry-prod-bastion", "project-server-ssh", "login", "Bastion login", "deploy / ********", true, "remote-changed", 1, hoursAgo(7)),
  entry("entry-ci-api-token", "project-api-token", "api-token", "CI token", "tok_********", true, "pending", 1, minutesAgo(52)),
  entry("entry-family-streaming", "project-family-streaming", "login", "Shared credential", "family@example.com / ********", true, "conflict", 1, hoursAgo(3)),
  entry("entry-family-note", "project-family-streaming", "note", "Device limits", "Shared note changed remotely", false, "conflict", 1, hoursAgo(3)),
  entry("entry-old-forum", "project-old-forum", "login", "Legacy login", "legacy@example.com / ********", true, "local-only", 1, daysAgo(21)),
  entry("entry-deleted-note", "project-deleted-note", "note", "Deleted backup codes", "Tombstone pending purge", true, "pending", 1, daysAgo(2))
];

const attachments: AttachmentRecord[] = [
  attachment("att-github-recovery", "project-github", "entry-github-login", "github-recovery-codes.txt", "text/plain", 18_432, "embedded-inline", false, "healthy", daysAgo(14)),
  attachment("att-github-ssh-pub", "project-github", "entry-github-ssh", "deploy.pub", "text/plain", 1_024, "embedded-inline", false, "healthy", daysAgo(9)),
  attachment("att-router-label", "project-router", "entry-router-wifi", "router-label.jpg", "image/jpeg", 1_485_432, "embedded-chunked", true, "attention", hoursAgo(5)),
  attachment("att-card-front", "project-bank-card", "entry-card", "travel-visa-front.png", "image/png", 2_191_304, "external-hash-ref", true, "healthy", hoursAgo(11)),
  attachment("att-card-back", "project-bank-card", "entry-card", "travel-visa-back.png", "image/png", 2_402_102, "external-hash-ref", true, "healthy", hoursAgo(11)),
  attachment("att-passport-cover", "project-passport", "entry-passport", "passport-cover.jpg", "image/jpeg", 3_824_501, "embedded-chunked", true, "healthy", hoursAgo(23)),
  attachment("att-passport-page", "project-passport", "entry-passport", "passport-page.jpg", "image/jpeg", 4_125_901, "embedded-chunked", true, "healthy", hoursAgo(23)),
  attachment("att-passport-visa", "project-passport", "entry-passport", "visa-scan.pdf", "application/pdf", 1_882_114, "embedded-chunked", false, "healthy", hoursAgo(23)),
  attachment("att-note-diagram", "project-seed-note", "entry-seed-note", "recovery-diagram.png", "image/png", 910_221, "embedded-chunked", true, "healthy", daysAgo(1)),
  attachment("att-note-readme", "project-seed-note", "entry-seed-note", "recovery-readme.md", "text/markdown", 5_812, "embedded-inline", false, "healthy", daysAgo(1)),
  attachment("att-ssh-config", "project-server-ssh", "entry-prod-ssh", "ssh-config.txt", "text/plain", 3_911, "embedded-inline", false, "remote-changed", hoursAgo(7))
];

export async function loadServerSnapshot(): Promise<MonicaServerSnapshot> {
  await delay(120);
  return {
    profile: {
      email: "owner@monica.local",
      displayName: "Monica Owner",
      role: "owner",
      serverUrl: "https://vault.monica.local",
      plan: "Self-hosted GPL"
    },
    metrics: [
      {
        labelKey: "metrics.items",
        value: String(projects.filter((item) => !item.deleted).length),
        detailKey: "metrics.itemsDetail",
        state: "healthy"
      },
      {
        labelKey: "metrics.attachments",
        value: String(attachments.length),
        detailKey: "metrics.attachmentsDetail",
        state: "healthy"
      },
      {
        labelKey: "metrics.review",
        value: "2",
        detailKey: "metrics.reviewDetail",
        state: "attention"
      },
      {
        labelKey: "metrics.storage",
        value: "1.78 GB",
        detailKey: "metrics.storageDetail",
        state: "healthy"
      }
    ],
    categories: [
      { id: "cat-dev", name: "Developer", sortOrder: 1, projectCount: 4, mdbxDatabaseId: "vault-main", mdbxFolderId: "folder-dev" },
      { id: "cat-wallet", name: "Wallet", sortOrder: 2, projectCount: 2, mdbxDatabaseId: "vault-main", mdbxFolderId: "folder-wallet" },
      { id: "cat-notes", name: "Secure Notes", sortOrder: 3, projectCount: 2, mdbxDatabaseId: "vault-main", mdbxFolderId: "folder-notes" },
      { id: "cat-home", name: "Home", sortOrder: 4, projectCount: 1, mdbxDatabaseId: "vault-main", mdbxFolderId: "folder-home" },
      { id: "cat-family", name: "Family", sortOrder: 5, projectCount: 1, mdbxDatabaseId: "vault-family", mdbxFolderId: "folder-shared" },
      { id: "cat-archive", name: "Archive", sortOrder: 6, projectCount: 1, mdbxDatabaseId: "vault-legacy", mdbxFolderId: "folder-archive" }
    ],
    projects,
    entries,
    attachments,
    sends: [
      {
        id: "send-recovery",
        name: "Recovery package",
        type: "file",
        notes: "One-time transfer for emergency contact.",
        protected: true,
        passwordRequired: true,
        disabled: false,
        hideEmail: true,
        maxAccessCount: 2,
        accessCount: 1,
        sizeBytes: 4_291_201,
        fileName: "recovery-package.monica-send",
        expirationAt: hoursAgo(-18),
        deletionAt: daysAgo(-7),
        createdAt: hoursAgo(6)
      },
      {
        id: "send-wifi",
        name: "Guest Wi-Fi",
        type: "text",
        notes: "Temporary guest network credentials.",
        protected: true,
        passwordRequired: false,
        disabled: false,
        hideEmail: false,
        maxAccessCount: 10,
        accessCount: 3,
        deletionAt: daysAgo(-2),
        createdAt: daysAgo(1)
      },
      {
        id: "send-disabled",
        name: "Old card image",
        type: "file",
        notes: "Disabled after remote download.",
        protected: true,
        passwordRequired: true,
        disabled: true,
        hideEmail: true,
        maxAccessCount: 1,
        accessCount: 1,
        sizeBytes: 2_402_102,
        fileName: "travel-visa-back.png",
        deletionAt: hoursAgo(-3),
        createdAt: daysAgo(4)
      }
    ],
    organizations: [
      {
        id: "org-personal",
        name: "Personal Vault",
        ownerEmail: "owner@monica.local",
        seatsUsed: 1,
        seatsLimit: 3,
        collections: 5,
        projects: 9,
        storageBytes: 1_277_820_928,
        state: "healthy"
      },
      {
        id: "org-family",
        name: "Family Space",
        ownerEmail: "family-admin@monica.local",
        seatsUsed: 4,
        seatsLimit: 5,
        collections: 2,
        projects: 1,
        storageBytes: 496_621_568,
        state: "conflict"
      }
    ],
    collections: [
      { id: "col-personal-dev", organizationId: "org-personal", name: "Developer", projectCount: 4, memberCount: 1, policy: "Owner only", updatedAt: minutesAgo(16) },
      { id: "col-personal-wallet", organizationId: "org-personal", name: "Wallet", projectCount: 2, memberCount: 1, policy: "Require re-prompt", updatedAt: hoursAgo(11) },
      { id: "col-personal-private", organizationId: "org-personal", name: "Private Notes", projectCount: 2, memberCount: 1, policy: "个人模式", updatedAt: daysAgo(1) },
      { id: "col-personal-home", organizationId: "org-personal", name: "Home", projectCount: 1, memberCount: 1, policy: "Standard", updatedAt: hoursAgo(5) },
      { id: "col-personal-legacy", organizationId: "org-personal", name: "Legacy JSON", projectCount: 1, memberCount: 1, policy: "Read only", updatedAt: daysAgo(21) },
      { id: "col-family-media", organizationId: "org-family", name: "Media", projectCount: 1, memberCount: 4, policy: "Manager can edit", updatedAt: hoursAgo(3) }
    ],
    members: [
      member("mem-owner", "org-personal", "owner@monica.local", "Monica Owner", "owner", "accepted", ["Owner"], minutesAgo(4)),
      member("mem-family-admin", "org-family", "family-admin@monica.local", "Family Admin", "owner", "accepted", ["Family"], hoursAgo(1)),
      member("mem-family-a", "org-family", "alex@monica.local", "Alex", "manager", "accepted", ["Family", "Media"], hoursAgo(9)),
      member("mem-family-b", "org-family", "sam@monica.local", "Sam", "member", "accepted", ["Media"], daysAgo(2)),
      member("mem-invite", "org-family", "invitee@monica.local", "Invitee", "member", "invited", ["Media"], daysAgo(5))
    ],
    policies: [
      policy("policy-2fa", "org-family", "Require 2FA for console login", "Members must enable TOTP or passkey login before vault access.", true, "healthy"),
      policy("policy-reprompt", "org-personal", "Re-prompt for wallet and documents", "Cards and documents require unlock before access.", true, "healthy"),
      policy("policy-send", "org-family", "Limit Send access count", "File sends require max access count, deletion date, and password.", true, "attention"),
      policy("policy-autofill", "org-personal", "Browser autofill bridge", "Reserved for clients only; web console keeps it disabled.", false, "local-only")
    ],
    backups: [
      backup("backup-1009", "vault-main", "personal-20260604-1330.mdbx", "desktop", "mdbx-file", 153_472_832, minutesAgo(8), "John-Windows", "healthy"),
      backup("backup-1008", "vault-main", "personal-20260604-1200.bundle", "scheduled", "sync-bundle", 12_845_440, hoursAgo(1), "Monica Server", "healthy"),
      backup("backup-1007", "vault-family", "family-20260604-1044.mdbx", "manual", "mdbx-file", 82_104_320, hoursAgo(3), "MacBook Pro", "pending"),
      backup("backup-1006", "vault-legacy", "monica_backup_20260602_0945.monica.enc.json", "desktop", "encrypted-json", 18_381_216, daysAgo(2), "Linux Workstation", "attention"),
      backup("backup-1005", "vault-main", "snapshot-snap-8841.json", "server", "snapshot", 44_118_420, daysAgo(1), "Monica Server", "healthy")
    ],
    devices: [
      device("dev-win", "John-Windows", "Windows 11", "Monica Avalonia 0.1.0", minutesAgo(3), "trusted", "healthy", "main@8f23aa", 428, "192.168.1.42"),
      device("dev-mac", "MacBook Pro", "macOS", "Monica Avalonia 0.1.0", hoursAgo(3), "trusted", "pending", "main@7a32df", 411, "10.0.0.12"),
      device("dev-phone", "Android Phone", "Android", "Monica Android", hoursAgo(9), "trusted", "healthy", "mobile@8f23aa", 427, "172.16.0.18"),
      device("dev-ios", "iPhone", "iOS", "Monica iOS", hoursAgo(2), "trusted", "remote-changed", "ios@0bcd77", 390, "172.16.0.21"),
      device("dev-linux", "Linux Workstation", "Linux", "Monica Avalonia 0.1.0", daysAgo(2), "trusted", "attention", "legacy@991a2f", 122, "192.168.1.80"),
      device("dev-new", "New Desktop", "Windows", "Monica Server Web", minutesAgo(27), "pending", "pending", "join@000000", 0, "192.168.1.77")
    ],
    auditEvents: [
      audit("evt-1", "owner@monica.local", "Created backup", "Personal Vault", "vault", minutesAgo(8), "192.168.1.42", "healthy"),
      audit("evt-2", "New Desktop", "Requested device approval", "owner@monica.local", "device", minutesAgo(27), "192.168.1.77", "attention"),
      audit("evt-3", "Monica Server", "Applied retention policy", "Legacy Monica JSON", "backup", hoursAgo(6), "local", "healthy"),
      audit("evt-4", "MacBook Pro", "Queued sync bundle", "Family Shared", "sync", hoursAgo(3), "10.0.0.12", "pending"),
      audit("evt-5", "owner@monica.local", "Created Send", "Guest Wi-Fi", "send", daysAgo(1), "192.168.1.42", "healthy")
    ],
    timeline: [
      timeline("tl-1", "Password", "GitHub", "UPDATE", "John-Windows", minutesAgo(16), false, "healthy"),
      timeline("tl-2", "Attachment", "travel-visa-front.png", "ATTACHMENT", "John-Windows", hoursAgo(11), false, "healthy"),
      timeline("tl-3", "Sync", "Family Streaming", "SYNC", "MacBook Pro", hoursAgo(3), false, "conflict"),
      timeline("tl-4", "Import", "Legacy Monica JSON", "IMPORT", "Linux Workstation", daysAgo(2), false, "attention"),
      timeline("tl-5", "Secure Note", "Old Backup Codes", "DELETE", "Android Phone", daysAgo(2), false, "pending"),
      timeline("tl-6", "Snapshot", "snap-8841", "RESTORE", "Monica Server", daysAgo(4), true, "healthy")
    ],
    syncJobs: [
      syncJob("job-1", "Family Shared", "bundle", 62, hoursAgo(3), "pending"),
      syncJob("job-2", "Personal Vault", "retention", 100, hoursAgo(6), "healthy"),
      syncJob("job-3", "Legacy Monica JSON", "upload", 0, daysAgo(2), "attention"),
      syncJob("job-4", "Personal Vault", "snapshot", 100, daysAgo(1), "healthy"),
      syncJob("job-5", "Family Shared", "conflict-scan", 44, minutesAgo(31), "conflict")
    ],
    syncSources: [
      {
        id: "source-server",
        name: "Monica Server",
        type: "Monica Server",
        rootPath: "/var/lib/monica/vaults",
        enabled: true,
        lastSyncAt: minutesAgo(8),
        include: ["MDBX bundles", "attachments", "sends", "snapshots"],
        state: "healthy"
      },
      {
        id: "source-webdav",
        name: "WebDAV backup",
        type: "WebDAV",
        rootPath: "/Monica/Backups",
        enabled: true,
        lastSyncAt: hoursAgo(5),
        include: ["passwords", "totp", "notes", "cards", "documents", "images", "categories"],
        state: "attention"
      },
      {
        id: "source-onedrive",
        name: "OneDrive mirror",
        type: "OneDrive",
        rootPath: "/Apps/Monica",
        enabled: false,
        include: ["manual exports"],
        state: "local-only"
      }
    ],
    mdbxDatabases: [
      mdbx("vault-main", "Personal Vault", "vaults/personal.mdbx", "MonicaServer", "MONICA_SERVER", "multi", "MasterPassword", 9, 3, 12, minutesAgo(8), true, "healthy"),
      mdbx("vault-family", "Family Shared", "vaults/family.mdbx", "MonicaServer", "MONICA_SERVER", "multi", "PlatformCredential", 1, 4, 4, hoursAgo(3), true, "conflict"),
      mdbx("vault-legacy", "Legacy Monica JSON", "imports/legacy.monica.enc.json", "RemoteWebDav", "REMOTE_WEBDAV", "sky", "MasterPassword", 1, 1, 2, daysAgo(2), false, "attention")
    ],
    branches: [
      branch("br-main", "vault-main", "main", "8f23aa98", "John-Windows", 0, 0, minutesAgo(8), "healthy"),
      branch("br-mobile", "vault-main", "mobile", "8f23aa98", "Android Phone", 0, 0, hoursAgo(9), "healthy"),
      branch("br-ios", "vault-main", "ios", "0bcd77e1", "iPhone", 1, 2, hoursAgo(2), "remote-changed"),
      branch("br-family-main", "vault-family", "main", "7a32df12", "MacBook Pro", 2, 1, hoursAgo(3), "conflict"),
      branch("br-family-server", "vault-family", "server", "5c1b00a4", "Monica Server", 1, 2, minutesAgo(31), "conflict"),
      branch("br-legacy", "vault-legacy", "legacy", "991a2fef", "Linux Workstation", 0, 0, daysAgo(2), "attention")
    ],
    conflicts: [
      {
        id: "conf-family-streaming",
        vaultId: "vault-family",
        objectType: "entry",
        objectTitle: "Family Streaming",
        localDevice: "MacBook Pro",
        remoteDevice: "Monica Server",
        localCommit: "7a32df12",
        remoteCommit: "5c1b00a4",
        detectedAt: minutesAgo(31),
        state: "conflict"
      },
      {
        id: "conf-ssh-key",
        vaultId: "vault-main",
        objectType: "entry",
        objectTitle: "Production SSH",
        localDevice: "John-Windows",
        remoteDevice: "iPhone",
        localCommit: "8f23aa98",
        remoteCommit: "0bcd77e1",
        detectedAt: hoursAgo(2),
        state: "remote-changed"
      }
    ],
    snapshots: [
      snapshot("snap-8841", "vault-main", "Daily snapshot", "8f23aa98", 9, 18, 11, 44_118_420, daysAgo(1), "healthy"),
      snapshot("snap-8712", "vault-main", "Before key rotation", "7aac4412", 8, 17, 9, 41_908_024, daysAgo(8), "healthy"),
      snapshot("snap-family-041", "vault-family", "Family pre-merge", "7a32df12", 1, 2, 0, 3_992_280, hoursAgo(3), "conflict"),
      snapshot("snap-legacy-002", "vault-legacy", "Legacy import", "991a2fef", 1, 1, 0, 1_882_114, daysAgo(2), "attention")
    ],
    securityIssues: [
      issue("issue-weak", "weak", "Weak passwords", 3, "high", "attention"),
      issue("issue-duplicate", "duplicate", "Reused passwords", 2, "medium", "attention"),
      issue("issue-stale", "stale", "Stale credentials", 5, "low", "pending"),
      issue("issue-compromised", "compromised", "Pwned password check", 1, "critical", "failed"),
      issue("issue-2fa", "missing-2fa", "Important logins without TOTP", 4, "medium", "attention"),
      issue("issue-attachments", "attachment-risk", "Large external image refs", 2, "low", "healthy")
    ],
    generatorPresets: [
      { id: "gen-random", name: "Random password", length: 24, modes: ["uppercase", "lowercase", "number", "symbol"], updatedAt: daysAgo(9) },
      { id: "gen-phrase", name: "Passphrase", length: 5, modes: ["words", "separator", "capitalize"], updatedAt: daysAgo(20) },
      { id: "gen-pin", name: "PIN", length: 8, modes: ["number"], updatedAt: daysAgo(42) }
    ],
    importExportJobs: [
      importExport("job-import-bitwarden", "import", "Bitwarden JSON", "passwords, cards, notes", "bitwarden_export_20260604.json", 100, hoursAgo(2), "healthy"),
      importExport("job-export-monica", "export", "Monica JSON", "all encrypted items", "monica_export_20260604.enc.json", 100, minutesAgo(55), "healthy"),
      importExport("job-import-aegis", "import", "Aegis JSON", "totp only", "aegis_plain.json", 72, minutesAgo(20), "pending"),
      importExport("job-export-markdown", "export", "Markdown", "current secure note", "recovery-notes.md", 0, daysAgo(1), "attention"),
      importExport("job-import-keepass", "import", "KeePass KDBX", "passwords and binaries", "legacy.kdbx", 100, daysAgo(5), "healthy")
    ],
    diagnostics: [
      diag("diag-api", "API server", "Online", "Go/Rust service target can serve the same contract.", "healthy"),
      diag("diag-storage", "Storage backend", "Local filesystem", "Encrypted storage has 238 GB free.", "healthy"),
      diag("diag-mail", "Mail", "Not configured", "Invites and Send notifications need SMTP.", "attention"),
      diag("diag-jobs", "Background jobs", "5 workers", "Retention, import and snapshot queues active.", "healthy"),
      diag("diag-webdav", "WebDAV", "Credential warning", "Remote backup profile requires rotation.", "attention"),
      diag("diag-version", "MDBX version", "v1", "Batch limit 256, server version 1.", "healthy")
    ],
    apiContract: apiRoutes
  };
}

function entry(
  id: string,
  projectId: string,
  type: EntryType,
  label: string,
  valuePreview: string,
  protectedValue: boolean,
  syncStatus: SyncState,
  schemaVersion: number,
  updatedAt: string
): VaultEntry {
  return {
    id,
    projectId,
    type,
    label,
    valuePreview,
    protected: protectedValue,
    schemaVersion,
    syncStatus,
    updatedAt
  };
}

function attachment(
  id: string,
  projectId: string,
  entryId: string | undefined,
  fileName: string,
  contentType: string,
  sizeBytes: number,
  storageMode: StorageMode,
  isImage: boolean,
  syncStatus: SyncState,
  createdAt: string
): AttachmentRecord {
  return {
    id,
    projectId,
    entryId,
    ownerType: "project",
    fileName,
    contentType,
    sizeBytes,
    storageMode,
    contentHash: `b3:${id.replace(/-/g, "")}8f23aa98`,
    isImage,
    createdAt,
    syncStatus
  };
}

function member(
  id: string,
  organizationId: string,
  email: string,
  displayName: string,
  role: MemberRecord["role"],
  status: MemberRecord["status"],
  groups: string[],
  lastActiveAt: string
): MemberRecord {
  return { id, organizationId, email, displayName, role, status, groups, lastActiveAt };
}

function policy(id: string, organizationId: string, name: string, description: string, enabled: boolean, state: SyncState): PolicyRecord {
  return { id, organizationId, name, description, enabled, state };
}

function backup(
  id: string,
  vaultId: string,
  fileName: string,
  kind: BackupRecord["kind"],
  format: BackupRecord["format"],
  sizeBytes: number,
  createdAt: string,
  deviceName: string,
  state: SyncState
): BackupRecord {
  return { id, vaultId, fileName, kind, format, sizeBytes, createdAt, deviceName, state };
}

function device(
  id: string,
  name: string,
  platform: string,
  appVersion: string,
  lastSeenAt: string,
  trustState: DeviceRecord["trustState"],
  syncState: SyncState,
  branchHead: string,
  knownCommits: number,
  ipAddress: string
): DeviceRecord {
  return { id, name, platform, appVersion, lastSeenAt, trustState, syncState, branchHead, knownCommits, ipAddress };
}

function audit(id: string, actor: string, action: string, target: string, itemType: string, createdAt: string, ipAddress: string, state: SyncState): AuditEvent {
  return { id, actor, action, target, itemType, createdAt, ipAddress, state };
}

function timeline(
  id: string,
  itemType: string,
  itemTitle: string,
  operationType: TimelineEntry["operationType"],
  deviceName: string,
  createdAt: string,
  reverted: boolean,
  state: SyncState
): TimelineEntry {
  return { id, itemType, itemTitle, operationType, deviceName, createdAt, reverted, state };
}

function syncJob(id: string, vaultName: string, type: SyncJob["type"], progress: number, queuedAt: string, state: SyncState): SyncJob {
  return { id, vaultName, type, progress, queuedAt, state };
}

function mdbx(
  id: string,
  name: string,
  filePath: string,
  storageLocation: MdbxDatabaseRecord["storageLocation"],
  sourceType: MdbxDatabaseRecord["sourceType"],
  tigaMode: TigaMode,
  unlockMethod: MdbxDatabaseRecord["unlockMethod"],
  projectCount: number,
  branchCount: number,
  snapshotCount: number,
  lastSyncedAt: string,
  offlineAvailable: boolean,
  state: SyncState
): MdbxDatabaseRecord {
  return {
    id,
    name,
    filePath,
    storageLocation,
    sourceType,
    tigaMode,
    unlockMethod,
    kdfProfile: "argon2id",
    projectCount,
    branchCount,
    snapshotCount,
    lastSyncedAt,
    offlineAvailable,
    state
  };
}

function branch(
  id: string,
  vaultId: string,
  branchName: string,
  headCommitId: string,
  deviceName: string,
  commitsAhead: number,
  commitsBehind: number,
  updatedAt: string,
  state: SyncState
): BranchHeadRecord {
  return { id, vaultId, branchName, headCommitId, deviceName, commitsAhead, commitsBehind, updatedAt, state };
}

function snapshot(
  id: string,
  vaultId: string,
  name: string,
  commitId: string,
  projectCount: number,
  entryCount: number,
  attachmentCount: number,
  sizeBytes: number,
  createdAt: string,
  state: SyncState
): SnapshotRecord {
  return { id, vaultId, name, commitId, projectCount, entryCount, attachmentCount, sizeBytes, createdAt, state };
}

function issue(
  id: string,
  type: SecurityIssue["type"],
  title: string,
  affectedCount: number,
  severity: SecurityIssue["severity"],
  state: SyncState
): SecurityIssue {
  return { id, type, title, affectedCount, severity, state };
}

function importExport(
  id: string,
  direction: ImportExportJob["direction"],
  format: ImportExportJob["format"],
  itemScope: string,
  fileName: string,
  progress: number,
  createdAt: string,
  state: SyncState
): ImportExportJob {
  return { id, direction, format, itemScope, fileName, progress, createdAt, state };
}

function diag(id: string, name: string, value: string, detail: string, state: SyncState): DiagnosticRecord {
  return { id, name, value, detail, state };
}

function minutesAgo(value: number): string {
  return new Date(now.getTime() - value * 60_000).toISOString();
}

function hoursAgo(value: number): string {
  return minutesAgo(value * 60);
}

function daysAgo(value: number): string {
  return hoursAgo(value * 24);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const apiRoutes: ApiContractRoute[] = [
  { method: "POST", path: "/api/v1/auth/register", description: "Create a Monica Server account without receiving vault secrets." },
  { method: "POST", path: "/api/v1/auth/login", description: "Issue web console and client tokens." },
  { method: "POST", path: "/api/v1/auth/refresh", description: "Rotate an access token while keeping device trust state." },
  { method: "GET", path: "/api/v1/me", description: "Return account, server capabilities, and feature flags." },
  { method: "GET", path: "/api/v1/projects", description: "List encrypted Monica projects." },
  { method: "POST", path: "/api/v1/projects", description: "Create a project record for encrypted client data." },
  { method: "PATCH", path: "/api/v1/projects/{projectId}", description: "Update name, archive state, category, or collection links." },
  { method: "DELETE", path: "/api/v1/projects/{projectId}", description: "Move a project to the recycle bin." },
  { method: "GET", path: "/api/v1/projects/{projectId}/entries", description: "List entries such as logins, notes, cards, TOTP, passkeys, SSH keys, and API tokens." },
  { method: "POST", path: "/api/v1/projects/{projectId}/entries", description: "Add an encrypted entry." },
  { method: "GET", path: "/api/v1/attachments", description: "List files and image flags." },
  { method: "POST", path: "/api/v1/attachments", description: "Upload encrypted file content." },
  { method: "GET", path: "/api/v1/attachments/{attachmentId}/download", description: "Download encrypted attachment bytes for clients." },
  { method: "GET", path: "/api/v1/sends", description: "List Monica Send objects, access limits, deletion dates, and disabled state." },
  { method: "POST", path: "/api/v1/sends", description: "Create text or file Send with optional password and access count limit." },
  { method: "PATCH", path: "/api/v1/sends/{sendId}", description: "Disable, rotate, or update Send policy." },
  { method: "GET", path: "/api/v1/orgs", description: "List organizations and shared vault spaces." },
  { method: "POST", path: "/api/v1/orgs/{orgId}/members/invite", description: "Invite members to Monica collections." },
  { method: "GET", path: "/api/v1/orgs/{orgId}/collections", description: "List collection policy and member counts." },
  { method: "PATCH", path: "/api/v1/orgs/{orgId}/policies/{policyId}", description: "Enable or disable organization policy." },
  { method: "POST", path: "/api/v1/devices", description: "Register a client device and start approval if required." },
  { method: "PATCH", path: "/api/v1/devices/{deviceId}/trust", description: "Approve, revoke, or rename a device." },
  { method: "GET", path: "/api/v1/mdbx/vaults", description: "List MDBX databases, sync mode, unlock method, and status." },
  { method: "POST", path: "/api/v1/mdbx/vaults/{vaultId}/sync/hello", description: "Start an MDBX sync session." },
  { method: "POST", path: "/api/v1/mdbx/vaults/{vaultId}/sync/want", description: "Request missing versions from the server." },
  { method: "POST", path: "/api/v1/mdbx/vaults/{vaultId}/sync/batches", description: "Upload encrypted version batches." },
  { method: "POST", path: "/api/v1/mdbx/vaults/{vaultId}/snapshots", description: "Create an encrypted snapshot record." },
  { method: "POST", path: "/api/v1/mdbx/vaults/{vaultId}/snapshots/{snapshotId}/restore", description: "Queue a snapshot restore." },
  { method: "GET", path: "/api/v1/conflicts", description: "List project, entry, and attachment conflicts." },
  { method: "POST", path: "/api/v1/conflicts/{conflictId}/resolve", description: "Save the chosen conflict resolution." },
  { method: "GET", path: "/api/v1/backups", description: "List encrypted Monica JSON, MDBX files, snapshots, and sync bundles." },
  { method: "POST", path: "/api/v1/backups", description: "Upload encrypted backup or reserve a scheduled server snapshot." },
  { method: "GET", path: "/api/v1/import-export/jobs", description: "Track Monica JSON, CSV, Bitwarden, KeePass, Aegis and Markdown jobs." },
  { method: "POST", path: "/api/v1/import-export/jobs", description: "Start an import or export job." },
  { method: "GET", path: "/api/v1/security/reports", description: "Store client-side security analysis summaries." },
  { method: "GET", path: "/api/v1/audit", description: "Return operation log and admin audit events." },
  { method: "GET", path: "/api/v1/admin/diagnostics", description: "Return service, storage, queue, and mail diagnostics." },
  { method: "PATCH", path: "/api/v1/admin/settings", description: "Update storage, retention, invite, and session settings." }
];
