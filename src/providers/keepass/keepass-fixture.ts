import * as kdbxweb from "kdbxweb";
import { installKdbxCryptoEngine } from "./keepass-crypto";

// Playwright loads kdbxweb through Node's CJS interop, where the public classes live on `default`;
// Vite/Vitest expose the same object as the namespace. Keeping the test-only fixture bilingual avoids
// baking a generated KDBX file into the repository and does not affect the provider bundle.
const kdbxRuntime = ((kdbxweb as unknown as { default?: typeof kdbxweb }).default ?? kdbxweb);

/**
 * Test fixtures are built here with kdbxweb rather than exported from the Android project: the Android
 * repository is read-only for this work, so no fixture may be produced by modifying or running it.
 * Compatibility is therefore asserted at the model level (field names, values, protection) against the
 * semantics the Kotlin tests encode, not by comparing bytes with a file Android produced.
 */

export interface KeePassFixtureEntry {
  title: string;
  fields?: Record<string, string>;
  protectedFields?: Record<string, string>;
  group?: string;
  binaries?: Record<string, Uint8Array>;
  tags?: string[];
}

export interface KeePassFixtureOptions {
  /** `null` builds a database with no password at all, which is only openable with the key file. */
  password?: string | null;
  keyFile?: Uint8Array;
  /** KDBX 3 uses AES-KDF and Salsa20; KDBX 4 uses Argon2 and ChaCha20. Both must round-trip. */
  version?: 3 | 4;
  kdf?: "argon2d" | "argon2id" | "aes";
  name?: string;
  entries?: KeePassFixtureEntry[];
}

export function keePassCredentials(password: string | null | undefined, keyFile?: Uint8Array): kdbxweb.Credentials {
  installKdbxCryptoEngine();
  const credentials = new kdbxRuntime.Credentials(
    password === null || password === undefined ? null : kdbxRuntime.ProtectedValue.fromString(password)
  );
  // Installed directly so kdbxweb does not re-interpret the bytes as an XML or hex key file.
  if (keyFile) credentials.keyFileHash = kdbxRuntime.ProtectedValue.fromBinary(keyFile.slice().buffer);
  return credentials;
}

/** Keeps the KDF cheap so a suite of fixtures stays fast; production files keep whatever they declare. */
function useTestKdfParameters(db: kdbxweb.Kdbx): void {
  const parameters = db.header.kdfParameters;
  if (!parameters) return;
  if (parameters.get("M") !== undefined) {
    parameters.set("M", kdbxRuntime.VarDictionary.ValueType.UInt64, new kdbxRuntime.Int64(1024 * 64));
    parameters.set("I", kdbxRuntime.VarDictionary.ValueType.UInt64, new kdbxRuntime.Int64(1));
    parameters.set("P", kdbxRuntime.VarDictionary.ValueType.UInt32, 1);
  } else if (parameters.get("R") !== undefined) {
    parameters.set("R", kdbxRuntime.VarDictionary.ValueType.UInt64, new kdbxRuntime.Int64(1000));
  }
}

export async function buildKeePassFixture(options: KeePassFixtureOptions = {}): Promise<Uint8Array> {
  installKdbxCryptoEngine();
  const credentials = keePassCredentials(
    options.password === undefined ? "fixture master password" : options.password,
    options.keyFile
  );
  const db = kdbxRuntime.Kdbx.create(credentials, options.name ?? "Monica Fixture");
  db.setVersion(options.version ?? 4);
  if (options.kdf === "aes") db.setKdf(kdbxRuntime.Consts.KdfId.Aes);
  else if (options.kdf === "argon2id") db.setKdf(kdbxRuntime.Consts.KdfId.Argon2id);
  useTestKdfParameters(db);

  const root = db.getDefaultGroup();
  const groups = new Map<string, kdbxweb.KdbxGroup>();
  for (const fixture of options.entries ?? []) {
    let parent = root;
    if (fixture.group) {
      // `Kdbx.create` already made a "Recycle Bin" group, so a same-named fixture group must reuse it
      // rather than shadow the one the metadata points at.
      const existing = groups.get(fixture.group) ?? root.groups.find((group) => group.name === fixture.group);
      parent = existing ?? db.createGroup(root, fixture.group);
      groups.set(fixture.group, parent);
    }
    const entry = db.createEntry(parent);
    entry.fields.set("Title", fixture.title);
    for (const [name, value] of Object.entries(fixture.fields ?? {})) entry.fields.set(name, value);
    for (const [name, value] of Object.entries(fixture.protectedFields ?? {})) {
      entry.fields.set(name, kdbxRuntime.ProtectedValue.fromString(value));
    }
    for (const [name, value] of Object.entries(fixture.binaries ?? {})) {
      entry.binaries.set(name, await db.createBinary(value.slice().buffer));
    }
    if (fixture.tags?.length) entry.tags = [...fixture.tags];
  }

  return new Uint8Array(await db.save());
}

/** Rewrites the outer header's `CipherID` in place, the only way to produce a Twofish file locally. */
export function withCipherUuid(bytes: Uint8Array, cipherUuidBase64: string): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  const versionMajor = view.getUint16(10, true);
  const sizeBytes = versionMajor >= 4 ? 4 : 2;
  let offset = 12;
  while (offset + 1 + sizeBytes <= copy.length) {
    const fieldId = copy[offset];
    const size = sizeBytes === 4 ? view.getUint32(offset + 1, true) : view.getUint16(offset + 1, true);
    const dataStart = offset + 1 + sizeBytes;
    if (fieldId === 0) break;
    if (fieldId === 2 && size === 16) {
      copy.set(base64Bytes(cipherUuidBase64), dataStart);
      return copy;
    }
    offset = dataStart + size;
  }
  throw new Error("fixture has no CipherID header field");
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
