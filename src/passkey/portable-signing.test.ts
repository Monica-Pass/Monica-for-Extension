import { constants, createHash, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { readAndroidBackup, writeAndroidBackup } from "../providers/webdav/android-backup-codec";
import type { PasskeyItem } from "../core/model";
import { passkeyAvailability } from "./source-policy";
import { createAssertion } from "./webauthn-core";
import { decodeMdbx2Object, encodeMdbx2Object } from "../providers/mdbx2/mdbx2-item-codec";

describe("portable Android Passkey signing", () => {
  for (const algorithm of [-7, -257, -37, -8]) {
    it(`imports and independently verifies COSE ${algorithm} without changing the key or flags`, async () => {
      const pair = algorithm === -7 ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        : algorithm === -8 ? generateKeyPairSync("ed25519") : generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pkcs8 = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
      const raw = { credentialId: "cG9ydGFibGUtY3JlZGVudGlhbA", rpId: "example.com", rpName: "Example", userId: "dXNlcg", userName: "Synthetic", userDisplayName: "Synthetic", publicKeyAlgorithm: algorithm, publicKey: "", privateKeyAlias: pkcs8, signCount: 0, isDiscoverable: true, createdAt: 1700000000000 };
      const document = readAndroidBackup(zipSync({ "folders/_root/passkeys/passkey_portable.json": strToU8(JSON.stringify(raw)) }), "synthetic", { allowPortablePasskeys: true });
      const item = document.items[0] as PasskeyItem;
      expect(item).toMatchObject({ algorithm, privateKeyPkcs8: pkcs8 });
      expect(passkeyAvailability(item, "example.com")).toBe("ready");
      const exported = writeAndroidBackup(document, [{ ...item, notes: "Edited in browser" }], "synthetic", { allowPortablePasskeys: true });
      expect(readAndroidBackup(exported, "other-client", { allowPortablePasskeys: true }).items[0]).toMatchObject({ algorithm, privateKeyPkcs8: pkcs8, notes: "Edited in browser" });
      const metadata = readAndroidBackup(exported, "plain").items[0] as PasskeyItem;
      expect(metadata.privateKeyPkcs8).toBeUndefined();
      expect(passkeyAvailability(metadata)).toBe("android-metadata-only");
      expect(() => writeAndroidBackup({ entries: {}, records: new Map(), items: [], warnings: [] }, [item], "synthetic")).toThrow("私钥");
      const native = encodeMdbx2Object(item)!;
      const reopened = decodeMdbx2Object({ objectId: "synthetic-native", collectionId: "synthetic-vault", objectTypeId: native.objectTypeId, title: item.title, payloadSchemaVersion: 1, deleted: false, payloadJson: native.payloadJson }, { headCommitId: "synthetic-head", updatedAt: item.updatedAt }, "native-client").item as PasskeyItem;
      expect(reopened).toMatchObject({ credentialId: item.credentialId, algorithm, privateKeyPkcs8: pkcs8 });
      expect(passkeyAvailability(reopened, "example.com")).toBe("ready");
      const challenge = Buffer.alloc(32, 19).toString("base64url");
      const assertion = await createAssertion({ origin: "https://example.com", challenge, rpId: item.rpId, credentialId: item.credentialId, userHandle: item.userHandle, privateKeyPkcs8: pkcs8, algorithm, signCount: 0, backupEligible: false, backupState: false, userVerified: true });
      const client = Buffer.from(assertion.response.clientDataJSON, "base64url");
      const auth = Buffer.from(assertion.response.authenticatorData, "base64url");
      expect(JSON.parse(client.toString())).toMatchObject({ origin: "https://example.com", challenge, type: "webauthn.get" });
      expect(auth.subarray(0, 32)).toEqual(createHash("sha256").update("example.com").digest());
      expect(auth[32]).toBe(5);
      expect(auth.readUInt32BE(33)).toBe(0);
      const key = algorithm === -37 ? { key: pair.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : pair.publicKey;
      expect(verify(algorithm === -8 ? null : "sha256", Buffer.concat([auth, createHash("sha256").update(client).digest()]), key, Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
    });
  }

  it("rejects unknown algorithms and mismatched key material before returning a signature", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const input = { origin: "https://example.com", challenge: Buffer.alloc(32, 9).toString("base64url"), credentialId: "aWQ", userHandle: "dXNlcg", privateKeyPkcs8: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), signCount: 0 };
    await expect(createAssertion({ ...input, algorithm: -999 })).rejects.toThrow();
    await expect(createAssertion({ ...input, algorithm: -7 })).rejects.toThrow();
    await expect(createAssertion({ ...input, algorithm: -8 })).rejects.toThrow();
  });
});
