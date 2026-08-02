import { describe, expect, it } from "vitest";
import { paginateProviderAttachments } from "./attachment-pagination";
import type { ProviderAttachmentSummary } from "./attachment-contract";

function attachment(index: number): ProviderAttachmentSummary {
  return {
    attachmentId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    providerKind: "keepass",
    fileName: `${index}.txt`,
    sizeBytes: index,
    protected: false
  };
}

describe("provider attachment pagination", () => {
  it("pages a stable opaque inventory", async () => {
    const items = [attachment(1), attachment(2), attachment(3)];
    const first = await paginateProviderAttachments(items, { pageSize: 2 });
    expect(first.items.map((item) => item.fileName)).toEqual(["1.txt", "2.txt"]);
    expect(first.nextCursor).toBeTypeOf("string");
    await expect(paginateProviderAttachments(items, { pageSize: 2, cursor: first.nextCursor })).resolves.toMatchObject({
      items: [{ fileName: "3.txt" }],
      nextCursor: undefined
    });
  });

  it("rejects oversized pages malformed cursors and changed inventories", async () => {
    const items = [attachment(1), attachment(2)];
    await expect(paginateProviderAttachments(items, { pageSize: 51 })).rejects.toMatchObject({ code: "attachment-page-size-invalid" });
    await expect(paginateProviderAttachments(items, { cursor: "not-base64" })).rejects.toMatchObject({ code: "attachment-cursor-invalid" });
    const first = await paginateProviderAttachments(items, { pageSize: 1 });
    await expect(paginateProviderAttachments([...items, attachment(3)], { cursor: first.nextCursor })).rejects.toMatchObject({ code: "attachment-list-stale" });
  });
});
