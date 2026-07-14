import type {
  ApiContractRoute,
  AttachmentRecord,
  BackupRecord,
  ConflictRecord,
  DeviceRecord,
  ImportExportJob,
  MdbxDatabaseRecord,
  MonicaServerSnapshot,
  ProjectKind,
  SendRecord,
  SyncState,
  VaultProject
} from "./api";
import { formatBytes, formatRelative } from "./format";
import type { MessageKey } from "../i18n";
import { t } from "../i18n";

export type SectionId =
  | "dashboard"
  | "passwords"
  | "notes"
  | "totp"
  | "wallet"
  | "passkeys"
  | "wifi"
  | "ssh"
  | "api-tokens"
  | "attachments"
  | "sends"
  | "archive"
  | "trash"
  | "security"
  | "generator"
  | "timeline"
  | "conflicts"
  | "organizations"
  | "collections"
  | "members"
  | "policies"
  | "devices"
  | "mdbx"
  | "sync"
  | "import-export"
  | "diagnostics"
  | "api"
  | "settings";

export type ModuleGroup = "vault" | "items" | "analysis" | "server";

export type TableColumn = {
  key: string;
  labelKey: MessageKey;
};

export type TableRow = {
  id: string;
  icon: string;
  title: string;
  subtitle: string;
  cells: Record<string, string | number>;
  state?: SyncState;
};

export type ModuleContext = {
  snapshot: MonicaServerSnapshot;
  query: string;
  entriesForProject: (projectId: string) => MonicaServerSnapshot["entries"];
  attachmentsForProject: (projectId: string) => MonicaServerSnapshot["attachments"];
  projectTitle: (projectId: string) => string;
};

export type FeatureModule = {
  id: SectionId;
  group: ModuleGroup;
  navKey: MessageKey;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  icon: string;
  columns: TableColumn[];
  action?: { labelKey: MessageKey; icon: string };
  projectDetail?: boolean;
  compact?: boolean;
  badge?: (snapshot: MonicaServerSnapshot) => number | string | undefined;
  rows: (context: ModuleContext) => TableRow[];
};

export const moduleGroups: Array<{ id: ModuleGroup; labelKey: MessageKey }> = [
  { id: "vault", labelKey: "groups.vault" },
  { id: "items", labelKey: "groups.items" },
  { id: "analysis", labelKey: "groups.analysis" },
  { id: "server", labelKey: "groups.server" }
];

export const featureModules: FeatureModule[] = [
  projectModule("dashboard", "vault", "modules.dashboard", "dashboard", () => true, { projectDetail: false }),
  projectModule("passwords", "vault", "modules.passwords", "password", (project, context) => {
    return project.kind === "password" && !project.deleted && !project.archived && !project.tags.includes("wifi");
  }),
  projectModule("notes", "vault", "modules.notes", "notes", (project) => project.kind === "secure-note" && !project.deleted && !project.archived),
  projectModule("totp", "vault", "modules.totp", "qr_code_2", (project) => project.kind === "totp" && !project.deleted && !project.archived),
  projectModule("wallet", "vault", "modules.wallet", "account_balance_wallet", (project) => {
    return (project.kind === "wallet" || project.kind === "document") && !project.deleted && !project.archived;
  }),
  projectModule("passkeys", "vault", "modules.passkeys", "fingerprint", (project, context) => {
    return project.passkeyCount > 0 || context.entriesForProject(project.id).some((entry) => entry.type === "passkey");
  }),
  projectModule("wifi", "vault", "modules.wifi", "wifi", (project) => project.tags.includes("wifi")),
  projectModule("ssh", "vault", "modules.ssh", "terminal", (project, context) => {
    return project.kind === "ssh-key" || context.entriesForProject(project.id).some((entry) => entry.type === "ssh-key");
  }),
  projectModule("api-tokens", "vault", "modules.apiTokens", "vpn_key", (project) => project.kind === "api-token"),
  tableModule("attachments", "items", "modules.attachments", "attach_file", columns("owner", "storage", "size", "created"), {
    badge: (snapshot) => snapshot.attachments.filter((item) => item.isImage).length,
    rows: (context) => context.snapshot.attachments.filter((item) => search(context.query, `${item.fileName} ${item.contentType} ${item.storageMode}`)).map((item) => attachmentRow(item, context))
  }),
  tableModule("sends", "items", "modules.sends", "send", columns("type", "access", "deletion", "policy"), {
    action: { labelKey: "actions.newSend", icon: "send" },
    badge: (snapshot) => snapshot.sends.filter((item) => !item.disabled).length,
    rows: (context) => context.snapshot.sends.filter((item) => search(context.query, `${item.name} ${item.notes} ${item.type}`)).map(sendRow)
  }),
  projectModule("archive", "items", "modules.archive", "archive", (project) => project.archived, {
    badge: (snapshot) => snapshot.projects.filter((item) => item.archived).length
  }),
  projectModule("trash", "items", "modules.trash", "delete", (project) => project.deleted, {
    badge: (snapshot) => snapshot.projects.filter((item) => item.deleted).length
  }),
  tableModule("security", "analysis", "modules.security", "security", columns("affected", "severity"), {
    badge: (snapshot) => snapshot.securityIssues.filter((item) => item.state !== "healthy").length,
    rows: (context) =>
      context.snapshot.securityIssues.map((item) => ({
        id: item.id,
        icon: "security",
        title: item.title,
        subtitle: stateLabel(item.state),
        cells: { affected: item.affectedCount, severity: t(`severity.${item.severity}` as MessageKey) },
        state: item.state
      }))
  }),
  tableModule("generator", "analysis", "modules.generator", "tune", columns("length", "updated"), {
    rows: (context) =>
      context.snapshot.generatorPresets.map((item) => ({
        id: item.id,
        icon: "tune",
        title: item.name,
        subtitle: item.modes.map((mode) => t(`generatorModes.${mode}` as MessageKey)).join(", "),
        cells: { length: item.length, updated: formatRelative(item.updatedAt) }
      }))
  }),
  tableModule("timeline", "analysis", "modules.timeline", "history", columns("time", "reverted"), {
    rows: (context) =>
      context.snapshot.timeline.map((item) => ({
        id: item.id,
        icon: "history",
        title: `${t(`operations.${item.operationType}` as MessageKey)} · ${item.itemTitle}`,
        subtitle: `${item.itemType} · ${item.deviceName}`,
        cells: { time: formatRelative(item.createdAt), reverted: item.reverted ? t("common.yes") : t("common.no") },
        state: item.state
      }))
  }),
  tableModule("conflicts", "analysis", "modules.conflicts", "sync_problem", columns("local", "remote", "detected"), {
    action: { labelKey: "actions.resolve", icon: "sync_problem" },
    badge: (snapshot) => snapshot.conflicts.length,
    rows: (context) => context.snapshot.conflicts.map(conflictRow)
  }),
  tableModule("organizations", "server", "modules.organizations", "business", columns("seats", "collections", "projects", "storage"), {
    action: { labelKey: "actions.newOrg", icon: "business" },
    rows: (context) =>
      context.snapshot.organizations.map((item) => ({
        id: item.id,
        icon: "business",
        title: item.name,
        subtitle: item.ownerEmail,
        cells: { seats: `${item.seatsUsed}/${item.seatsLimit}`, collections: item.collections, projects: item.projects, storage: formatBytes(item.storageBytes) },
        state: item.state
      }))
  }),
  tableModule("collections", "server", "modules.collections", "collections_bookmark", columns("projects", "members", "policy", "updated"), {
    action: { labelKey: "actions.newCollection", icon: "collections_bookmark" },
    rows: (context) => {
      const orgById = new Map(context.snapshot.organizations.map((org) => [org.id, org.name]));
      return context.snapshot.collections.map((item) => ({
        id: item.id,
        icon: "collections_bookmark",
        title: item.name,
        subtitle: orgById.get(item.organizationId) ?? item.organizationId,
        cells: { projects: item.projectCount, members: item.memberCount, policy: item.policy, updated: formatRelative(item.updatedAt) }
      }));
    }
  }),
  tableModule("members", "server", "modules.members", "group", columns("role", "groups", "status", "active"), {
    action: { labelKey: "actions.invite", icon: "group" },
    rows: (context) => {
      const orgById = new Map(context.snapshot.organizations.map((org) => [org.id, org.name]));
      return context.snapshot.members.map((item) => ({
        id: item.id,
        icon: "person",
        title: item.displayName,
        subtitle: `${item.email} · ${orgById.get(item.organizationId) ?? item.organizationId}`,
        cells: { role: t(`roles.${item.role}` as MessageKey), groups: item.groups.join(", "), status: t(`memberStatus.${item.status}` as MessageKey), active: formatRelative(item.lastActiveAt) }
      }));
    }
  }),
  tableModule("policies", "server", "modules.policies", "policy", columns("enabled", "org"), {
    action: { labelKey: "actions.newPolicy", icon: "policy" },
    rows: (context) =>
      context.snapshot.policies.map((item) => ({
        id: item.id,
        icon: "policy",
        title: item.name,
        subtitle: item.description,
        cells: { enabled: item.enabled ? t("common.enabled") : t("common.disabled"), org: item.organizationId },
        state: item.state
      }))
  }),
  tableModule("devices", "server", "modules.devices", "devices", columns("trust", "branch", "commits", "ip", "seen"), {
    action: { labelKey: "actions.register", icon: "devices" },
    badge: (snapshot) => snapshot.devices.filter((item) => item.trustState === "pending").length,
    rows: (context) =>
      context.snapshot.devices
        .filter((item) => search(context.query, `${item.name} ${item.platform} ${item.appVersion} ${item.branchHead} ${item.ipAddress}`))
        .map(deviceRow)
  }),
  tableModule("mdbx", "server", "modules.mdbx", "storage", columns("source", "tiga", "unlock", "projects", "branches", "snapshots"), {
    action: { labelKey: "actions.createVault", icon: "storage" },
    rows: (context) => context.snapshot.mdbxDatabases.map(mdbxRow)
  }),
  tableModule("sync", "server", "modules.sync", "cloud_sync", columns("format", "kind", "size", "created"), {
    action: { labelKey: "actions.backup", icon: "backup" },
    compact: true,
    rows: (context) => context.snapshot.backups.map(backupRow)
  }),
  tableModule("import-export", "server", "modules.importExport", "import_export", columns("format", "progress", "created"), {
    action: { labelKey: "actions.newJob", icon: "import_export" },
    rows: (context) => context.snapshot.importExportJobs.map(importExportRow)
  }),
  tableModule("diagnostics", "server", "modules.diagnostics", "gpp_maybe", columns("value"), {
    action: { labelKey: "actions.runChecks", icon: "gpp_maybe" },
    rows: (context) =>
      context.snapshot.diagnostics.map((item) => ({
        id: item.id,
        icon: "gpp_maybe",
        title: item.name,
        subtitle: item.detail,
        cells: { value: item.value },
        state: item.state
      }))
  }),
  tableModule("api", "server", "modules.api", "code", columns("method"), {
    action: { labelKey: "actions.openApi", icon: "download" },
    rows: (context) => context.snapshot.apiContract.map(routeRow)
  }),
  tableModule("settings", "server", "modules.settings", "settings", [], {
    action: { labelKey: "actions.save", icon: "settings" },
    rows: () => []
  })
];

export const modulesById = new Map(featureModules.map((module) => [module.id, module]));
export const projectSectionIds = featureModules.filter((module) => module.projectDetail).map((module) => module.id);

export function defaultAction(module: FeatureModule) {
  return module.action ?? { labelKey: "actions.addItem" as MessageKey, icon: "add" };
}

export function moduleKey(base: string, suffix: "nav" | "title" | "description") {
  return `${base}.${suffix}` as MessageKey;
}

export function projectIcon(kind: ProjectKind) {
  const icons: Record<ProjectKind, string> = {
    password: "password",
    "secure-note": "notes",
    wallet: "credit_card",
    identity: "verified_user",
    totp: "qr_code_2",
    passkey: "fingerprint",
    "ssh-key": "terminal",
    "api-token": "vpn_key",
    document: "description"
  };
  return icons[kind];
}

export function kindLabel(kind: ProjectKind) {
  return t(`kinds.${kind}` as MessageKey);
}

export function stateLabel(state?: SyncState) {
  return state ? t(`states.${state}` as MessageKey) : "";
}

export function stateClass(state?: SyncState) {
  return state ? `state state-${state}` : "state";
}

function projectModule(
  id: SectionId,
  group: ModuleGroup,
  keyBase: string,
  icon: string,
  filter: (project: VaultProject, context: ModuleContext) => boolean,
  options: Partial<Pick<FeatureModule, "badge" | "compact" | "projectDetail">> = {}
): FeatureModule {
  return tableModule(id, group, keyBase, icon, columns("type", "entries", "files", "tiga", "updated"), {
    ...options,
    projectDetail: options.projectDetail ?? true,
    rows: (context) => filteredProjects(context).filter((project) => filter(project, context)).map((project) => projectRow(project, context))
  });
}

function tableModule(
  id: SectionId,
  group: ModuleGroup,
  keyBase: string,
  icon: string,
  columns: TableColumn[],
  options: Pick<FeatureModule, "rows"> & Partial<FeatureModule>
): FeatureModule {
  return {
    id,
    group,
    icon,
    columns,
    navKey: moduleKey(keyBase, "nav"),
    titleKey: moduleKey(keyBase, "title"),
    descriptionKey: moduleKey(keyBase, "description"),
    rows: options.rows,
    action: options.action,
    badge: options.badge,
    compact: options.compact,
    projectDetail: options.projectDetail
  };
}

function columns(...keys: string[]): TableColumn[] {
  return keys.map((key) => ({ key, labelKey: `columns.${key}` as MessageKey }));
}

function filteredProjects(context: ModuleContext) {
  return context.snapshot.projects.filter((project) => {
    const text = `${project.title} ${project.subtitle} ${project.kind} ${project.tags.join(" ")} ${project.vaultId}`;
    return search(context.query, text);
  });
}

function search(query: string, value: string) {
  return !query || value.toLowerCase().includes(query);
}

function projectRow(project: VaultProject, context: ModuleContext): TableRow {
  return {
    id: project.id,
    icon: projectIcon(project.kind),
    title: project.title,
    subtitle: project.subtitle,
    cells: {
      type: kindLabel(project.kind),
      entries: context.entriesForProject(project.id).length,
      files: `${project.attachmentCount} · ${t("units.images", { value: project.imageCount })}`,
      tiga: t(`modes.${project.tigaMode}` as MessageKey),
      updated: formatRelative(project.updatedAt)
    },
    state: project.syncStatus
  };
}

function attachmentRow(item: AttachmentRecord, context: ModuleContext): TableRow {
  return {
    id: item.id,
    icon: item.isImage ? "image" : "attach_file",
    title: item.fileName,
    subtitle: item.isImage ? t("common.image") : item.contentType,
    cells: { owner: context.projectTitle(item.projectId), storage: t(`storage.${item.storageMode}` as MessageKey), size: formatBytes(item.sizeBytes), created: formatRelative(item.createdAt) },
    state: item.syncStatus
  };
}

function sendRow(item: SendRecord): TableRow {
  const policy = item.passwordRequired ? t("common.password") : t("common.open");
  return {
    id: item.id,
    icon: item.type === "file" ? "attach_file" : "notes",
    title: item.name,
    subtitle: item.fileName ?? item.notes,
    cells: {
      type: t(item.type === "file" ? "common.file" : "common.text"),
      access: `${item.accessCount}${item.maxAccessCount ? `/${item.maxAccessCount}` : ""}`,
      deletion: formatRelative(item.deletionAt),
      policy: `${policy}${item.disabled ? ` · ${t("common.disabled")}` : ""}`
    }
  };
}

function deviceRow(item: DeviceRecord): TableRow {
  return {
    id: item.id,
    icon: "devices",
    title: item.name,
    subtitle: `${item.platform} · ${item.appVersion}`,
    cells: { trust: t(`trust.${item.trustState}` as MessageKey), branch: versionLabel(item.branchHead), commits: item.knownCommits, ip: item.ipAddress, seen: formatRelative(item.lastSeenAt) },
    state: item.syncState
  };
}

function mdbxRow(item: MdbxDatabaseRecord): TableRow {
  return {
    id: item.id,
    icon: "storage",
    title: item.name,
    subtitle: item.filePath,
    cells: {
      source: t(`sources.${item.sourceType}` as MessageKey),
      tiga: t(`modes.${item.tigaMode}` as MessageKey),
      unlock: t(`unlock.${item.unlockMethod}` as MessageKey),
      projects: item.projectCount,
      branches: item.branchCount,
      snapshots: item.snapshotCount
    },
    state: item.state
  };
}

function backupRow(item: BackupRecord): TableRow {
  return {
    id: item.id,
    icon: "backup",
    title: item.fileName,
    subtitle: `${item.vaultId} · ${item.deviceName}`,
    cells: { format: t(`formats.${item.format}` as MessageKey), kind: t(`backup.${item.kind}` as MessageKey), size: formatBytes(item.sizeBytes), created: formatRelative(item.createdAt) },
    state: item.state
  };
}

function importExportRow(item: ImportExportJob): TableRow {
  return {
    id: item.id,
    icon: "import_export",
    title: item.fileName,
    subtitle: `${t(`directions.${item.direction}` as MessageKey)} · ${item.itemScope}`,
    cells: { format: item.format, progress: `${item.progress}%`, created: formatRelative(item.createdAt) },
    state: item.state
  };
}

function routeRow(item: ApiContractRoute): TableRow {
  return {
    id: `${item.method}:${item.path}`,
    icon: "code",
    title: item.path,
    subtitle: "",
    cells: { method: item.method }
  };
}

function conflictRow(item: ConflictRecord): TableRow {
  return {
    id: item.id,
    icon: "sync_problem",
    title: item.objectTitle,
    subtitle: `${item.localDevice} / ${item.remoteDevice}`,
    cells: { local: versionLabel(item.localCommit), remote: versionLabel(item.remoteCommit), detected: formatRelative(item.detectedAt) },
    state: item.state
  };
}

function versionLabel(value: string) {
  return value.includes("@") ? value.split("@")[0] || value : value.slice(0, 6);
}
