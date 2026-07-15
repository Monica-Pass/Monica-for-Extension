import type { ProviderDiagnostic, ProviderKind } from "../core/model";
import { ProviderTransportError } from "./provider-transport";

export type { ProviderDiagnostic } from "../core/model";

export interface ProviderDiagnosticDetails {
  operation?: string;
  outcome?: ProviderDiagnostic["outcome"];
  code?: string;
  durationMs?: number;
  conflicts?: number;
  warnings?: number;
  message?: string;
}

const SENSITIVE_KEY = /(?:pass(?:word)?|token|secret|key|authorization|cookie|credential|session|email|user(?:name)?|url|endpoint|host|account|providerId)/i;

export function redactProviderDiagnostic<T>(value: T): T {
  return redactValue(value, new WeakSet()) as T;
}

export function redactProviderMessage(value: string): string {
  return sanitizeText(value);
}

export function createProviderDiagnostic(
  providerId: string,
  kind: ProviderKind,
  error: unknown,
  at = new Date().toISOString(),
  details: ProviderDiagnosticDetails = {}
): ProviderDiagnostic {
  const transport = error instanceof ProviderTransportError ? error : undefined;
  return {
    at,
    providerRef: `provider-${fnv1a(providerId)}`,
    kind,
    operation: details.operation || transport?.operation || "sync",
    outcome: details.outcome || (transport?.code === "cancelled" ? "cancelled" : error ? "failure" : "success"),
    code: details.code || transport?.code || (error ? "unknown" : "ok"),
    status: transport?.status,
    retryable: transport?.retryable || false,
    attempts: transport?.attempts || 1,
    retryAfterMs: transport?.retryAfterMs,
    durationMs: details.durationMs,
    conflicts: details.conflicts,
    warnings: details.warnings,
    message: sanitizeText(details.message || (error instanceof Error ? error.message : error ? "Provider 操作失败。" : "Provider 操作完成。"))
  };
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(entry, seen);
  return result;
}

function sanitizeText(input: string): string {
  return input
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]")
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, "[REDACTED_EMAIL]")
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, "[REDACTED_AUTH]")
    .replace(/\b(password|pass|token|secret|authorization|cookie|api[_-]?key|code)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\beyJ[a-zA-Z0-9_-]{16,}(?:\.[a-zA-Z0-9_-]+){1,2}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[a-zA-Z0-9+/=_-]{40,}\b/g, "[REDACTED_VALUE]")
    .slice(0, 300);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
