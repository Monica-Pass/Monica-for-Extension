import type { Locale, MessageKey } from "../i18n";
import { t } from "../i18n";

const now = new Date("2026-06-04T13:38:00.000Z");

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

export function formatRelative(value: string): string {
  const date = new Date(value);
  const diffMs = now.getTime() - date.getTime();
  const minutes = Math.max(1, Math.round(Math.abs(diffMs) / 60_000));
  let unit: MessageKey = "relative.minute";
  let amount = minutes;

  if (minutes >= 60) {
    const hours = Math.round(minutes / 60);
    unit = hours < 48 ? "relative.hour" : "relative.day";
    amount = hours < 48 ? hours : Math.round(hours / 24);
  }

  const valueText = t(unit, { value: amount });
  return t(diffMs < 0 ? "relative.future" : "relative.past", { value: valueText });
}

export function formatDateTime(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
