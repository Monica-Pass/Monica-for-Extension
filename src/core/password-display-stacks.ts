import type { LoginItem, VaultItem } from "./model";
import { passwordGroupKey } from "./password-groups";
import { passwordProjectStackSetting } from "./password-manual-stacks";

export const PASSWORD_STACK_MODES = ["none", "manual", "smart", "website", "title", "app", "note", "folder"] as const;
export type PasswordStackMode = typeof PASSWORD_STACK_MODES[number];
export type WebsiteStackMatch = "strict" | "relaxed";
export interface PasswordDisplayStack {
  key: string;
  label: string;
  projects: LoginItem[][];
  representative: LoginItem;
  passwordCount: number;
  setting?: "manual" | "never" | "invalid";
}

export function passwordDisplaySourceKey(item: LoginItem): string {
  return JSON.stringify([[...new Set(item.providerRefs.map(ref => ref.providerId))].sort(), item.mdbxDatabaseId ?? null, item.keepassDatabaseId ?? null]);
}

/** Presentation only. Never use stack domain matching to authorize autofill or establish membership. */
export function passwordWebsiteLabel(website: string, match: WebsiteStackMatch): string {
  const raw = website.trim().toLowerCase();
  if (!raw) return "";
  let host: string;
  try { host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname; }
  catch { host = raw.split(/[/?#]/)[0].split(":")[0]; }
  host = host.replace(/^\.+|\.+$/g, "").replace(/^www\./, "");
  if (match === "strict" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  const common = ["ac", "co", "com", "edu", "gov", "mil", "net", "nom", "org"];
  // Match Android's display heuristic; this is deliberately separate from the PSL-based URI policy.
  const parts = /^[a-z]{2}$/.test(labels[labels.length - 1]) && common.includes(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-parts).join(".");
}

function stackLabel(item: LoginItem, mode: PasswordStackMode, match: WebsiteStackMatch): string {
  const website = passwordWebsiteLabel(item.uris.join("\n"), match);
  const note = item.notes.split(/\r?\n/).find(line => line.trim())?.trim() || "";
  const app = item.appName?.trim() || item.appPackageName?.trim() || "";
  if (mode === "website") return website;
  if (mode === "title") return item.title.trim();
  if (mode === "app") return app;
  if (mode === "note") return note;
  if (mode === "folder") return item.keepassGroupPath || item.categoryName || item.mdbxFolderId || "";
  return note || website || app || item.title.trim();
}

/** Group whole projects for display. A stack never changes their explicit members or selection semantics. */
export function passwordDisplayStacks(projects: LoginItem[][], mode: PasswordStackMode, match: WebsiteStackMatch = "strict"): PasswordDisplayStack[] {
  const stacks = new Map<string, PasswordDisplayStack>();
  for (const project of projects) {
    if (!project.length) continue;
    const item = project.find(member => member.isGroupCover === true) || project[0];
    const setting = passwordProjectStackSetting(project);
    const forced = mode !== "none" && setting.kind !== "auto";
    const label = forced || mode === "manual" ? item.title : stackLabel(item, mode, match);
    const folder = [item.keepassGroupUuid ?? item.keepassGroupPath ?? null, item.mdbxFolderId ?? null,
      item.providerRefs.map(ref => [ref.providerId, ref.remoteFolderId ?? null]).sort(), item.categoryId ?? null];
    const key = forced ? setting.kind === "manual" ? JSON.stringify([passwordDisplaySourceKey(item), "manual", setting.groupId]) : `project:${passwordGroupKey(item)}`
      : mode === "none" || mode === "manual" || !label && mode !== "folder" ? `project:${passwordGroupKey(item)}`
      : JSON.stringify([passwordDisplaySourceKey(item), mode, mode === "folder" ? folder : label]);
    const current = stacks.get(key);
    if (current) {
      current.projects.push(project);
      current.passwordCount += project.length;
      if (item.isGroupCover && !current.representative.isGroupCover) current.representative = item;
    } else stacks.set(key, { key, label: label || (mode === "folder" ? "/" : item.title), projects: [project], representative: item, passwordCount: project.length,
      ...(forced && setting.kind !== "auto" ? { setting: setting.kind } : {}) });
  }
  return [...stacks.values()];
}

/** Android clears by exact website, independently of relaxed display labels. Scope changes never affect another vault. */
export function passwordCoverPeers(anchor: LoginItem, items: VaultItem[]): LoginItem[] {
  const website = anchor.uris.join("\n");
  const source = passwordDisplaySourceKey(anchor);
  return items.filter((item): item is LoginItem => item.kind === "login" && !item.deletedAt && !item.archivedAt
    && passwordDisplaySourceKey(item) === source && (website ? item.uris.join("\n") === website : item.id === anchor.id));
}
