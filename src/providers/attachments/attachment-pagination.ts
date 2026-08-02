import {
  PROVIDER_ATTACHMENT_MAX_CURSOR_BYTES,
  PROVIDER_ATTACHMENT_MAX_PAGE_SIZE,
  ProviderAttachmentError,
  type ProviderAttachmentPage,
  type ProviderAttachmentSummary
} from "./attachment-contract";

interface AttachmentCursor {
  version: 1;
  offset: number;
  fingerprint: string;
}

export async function paginateProviderAttachments(
  items: ProviderAttachmentSummary[],
  input: { pageSize?: number; cursor?: string } = {}
): Promise<ProviderAttachmentPage> {
  const pageSize = input.pageSize ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PROVIDER_ATTACHMENT_MAX_PAGE_SIZE) {
    throw new ProviderAttachmentError("attachment-page-size-invalid", "附件分页大小必须介于 1 和 50 之间。");
  }
  const fingerprint = await attachmentInventoryFingerprint(items);
  const offset = input.cursor ? decodeCursor(input.cursor, fingerprint, items.length) : 0;
  const pageItems = items.slice(offset, offset + pageSize);
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    nextCursor: nextOffset < items.length ? encodeCursor({ version: 1, offset: nextOffset, fingerprint }) : undefined
  };
}

async function attachmentInventoryFingerprint(items: ProviderAttachmentSummary[]): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify(items.map((item) => [
    item.attachmentId,
    item.providerKind,
    item.fileName,
    item.sizeBytes,
    item.protected,
    item.mediaType || ""
  ])));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input as BufferSource));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function encodeCursor(cursor: AttachmentCursor): string {
  return btoa(JSON.stringify(cursor));
}

function decodeCursor(value: string, fingerprint: string, itemCount: number): number {
  if (new TextEncoder().encode(value).byteLength > PROVIDER_ATTACHMENT_MAX_CURSOR_BYTES) {
    throw new ProviderAttachmentError("attachment-cursor-invalid", "附件分页游标超过安全上限。");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(value));
  } catch {
    throw new ProviderAttachmentError("attachment-cursor-invalid", "附件分页游标无效。");
  }
  if (!parsed || typeof parsed !== "object") throw new ProviderAttachmentError("attachment-cursor-invalid", "附件分页游标无效。");
  const cursor = parsed as Partial<AttachmentCursor>;
  if (cursor.version !== 1 || cursor.fingerprint !== fingerprint || !Number.isSafeInteger(cursor.offset) || cursor.offset! < 1 || cursor.offset! >= itemCount) {
    throw new ProviderAttachmentError(
      cursor.fingerprint && cursor.fingerprint !== fingerprint ? "attachment-list-stale" : "attachment-cursor-invalid",
      cursor.fingerprint && cursor.fingerprint !== fingerprint ? "附件列表在分页期间发生变化，请刷新列表。" : "附件分页游标无效。"
    );
  }
  return cursor.offset!;
}
