import type { ProviderKind } from "../core/model";
import { ProviderTransportError } from "./provider-transport";

export interface ProviderDiagnostic {
  at: string;
  providerRef: string;
  kind: ProviderKind;
  operation: string;
  code: string;
  status?: number;
  retryable: boolean;
  attempts: number;
  retryAfterMs?: number;
  message: string;
}

const SENSITIVE_KEY = /(?:pass(?:word)?|token|secret|key|authorization|cookie|credential|session|email|user(?:name)?|url|endpoint|host|account|providerId)/i;

export function redactProviderDiagnostic<T>(value: T): T {
  return redactValue(value, new WeakSet()) as T;
}

export function createProviderDiagnostic(providerId: string, kind: ProviderKind, error: unknown, at = new Date().toISOString()): ProviderDiagnostic {
  const transport = error instanceof ProviderTransportError ? error : undefined;
  return {
    at,
    providerRef: `provider-${fnv1a(providerId)}`,
    kind,
    operation: transport?.operation || "sync",
    code: transport?.code || "unknown",
    status: transport?.status,
    retryable: transport?.retryable || false,
    attempts: transport?.attempts || 1,
    retryAfterMs: transport?.retryAfterMs,
    message: sanitizeText(error instanceof Error ? error.message : "Provider 操作失败。")
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
