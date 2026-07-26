import { describe, expect, it } from "vitest";
import {
  createSourceRecord,
  findSourceRecord,
  MAX_SOURCE_RECORDS_TOTAL_BYTES,
  MAX_SOURCE_RECORD_PAYLOAD_BYTES,
  sourceRecordChanged,
  sourceRecordsBudgetError
} from "./source-records";

const BASE = { providerId: "provider-1", remoteId: "row-1", format: "mdbx-row", encoding: "json" };

describe("shared provider source records", () => {
  it("fingerprints the decoded bytes so json and base64 encodings of the same record agree", async () => {
    const payload = new TextEncoder().encode('{"id":1}');
    const asJson = await createSourceRecord({ ...BASE, payload: '{"id":1}' });
    const asBase64 = await createSourceRecord({ ...BASE, encoding: "base64", payload });

    expect(asJson.contentHash).toBe(asBase64.contentHash);
    expect(asBase64.payload).toBe("eyJpZCI6MX0=");
  });

  it("omits itemId and revision instead of writing undefined into the vault", async () => {
    const record = await createSourceRecord({ ...BASE, payload: "{}" });

    expect(Object.keys(record).sort()).toEqual(["contentHash", "encoding", "format", "payload", "providerId", "remoteId"]);
  });

  it("detects an edit that kept the same revision", async () => {
    const previous = await createSourceRecord({ ...BASE, revision: "7", payload: '{"password":"old"}' });
    const next = await createSourceRecord({ ...BASE, revision: "7", payload: '{"password":"new"}' });

    expect(sourceRecordChanged(previous, next)).toBe(true);
    expect(sourceRecordChanged(previous, previous)).toBe(false);
    expect(sourceRecordChanged(undefined, next)).toBe(true);
  });

  it("treats a re-encoded but byte-identical record as changed so the codec is re-run", async () => {
    const previous = await createSourceRecord({ ...BASE, payload: "{}" });
    const next = await createSourceRecord({ ...BASE, format: "kdbx-entry", payload: "{}" });

    expect(sourceRecordChanged(previous, next)).toBe(true);
  });

  it("scopes lookups by provider so two accounts of one kind never cross over", async () => {
    const first = await createSourceRecord({ ...BASE, payload: '{"db":"first"}' });
    const second = await createSourceRecord({ ...BASE, providerId: "provider-2", payload: '{"db":"second"}' });
    const records = [first, second];

    expect(findSourceRecord(records, "provider-2", "row-1")).toBe(second);
    expect(findSourceRecord(records, "provider-3", "row-1")).toBeUndefined();
  });

  it("rejects an oversized envelope before it can make the vault undecryptable", async () => {
    const oversized = await createSourceRecord({ ...BASE, payload: "x".repeat(MAX_SOURCE_RECORD_PAYLOAD_BYTES + 1) });

    expect(sourceRecordsBudgetError([oversized])).toContain("row-1");
    expect(sourceRecordsBudgetError([await createSourceRecord({ ...BASE, payload: "{}" })])).toBeUndefined();
  });

  it("rejects many small envelopes that together exceed the vault budget", async () => {
    const chunk = await createSourceRecord({ ...BASE, payload: "x".repeat(MAX_SOURCE_RECORD_PAYLOAD_BYTES) });
    const records = Array.from({ length: MAX_SOURCE_RECORDS_TOTAL_BYTES / MAX_SOURCE_RECORD_PAYLOAD_BYTES + 1 }, () => chunk);

    expect(sourceRecordsBudgetError(records)).toContain("合计");
  });

  it("measures base64 payloads by their decoded size", async () => {
    const bytes = new Uint8Array(MAX_SOURCE_RECORD_PAYLOAD_BYTES);
    const record = await createSourceRecord({ ...BASE, encoding: "base64", payload: bytes });

    expect(record.payload.length).toBeGreaterThan(MAX_SOURCE_RECORD_PAYLOAD_BYTES);
    expect(sourceRecordsBudgetError([record])).toBeUndefined();
  });
});
