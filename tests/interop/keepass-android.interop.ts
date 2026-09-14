import { existsSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import type { CardItem, IdentityItem, LoginItem, PasskeyItem, ProviderAccount } from "../../src/core/model";
import { createAssertion } from "../../src/passkey/webauthn-core";
import { readKeePassHeader } from "../../src/providers/keepass/keepass-format";
import { keePassCredentials } from "../../src/providers/keepass/keepass-fixture";
import { keePassFieldText } from "../../src/providers/keepass/keepass-login-codec";
import { KeePassProvider } from "../../src/providers/keepass/keepass-provider";
import { runCommand, runText, sha256Hex } from "./mdbx2-interop-support";

const FIXTURE_CLASS = "takagi.ru.monica.keepass.ExtensionKeePassInteropFixtureTest";
const PASSWORD = "monica-android-extension-interop-password";
const ATTACHMENT_BYTES = new TextEncoder().encode("recovery attachment from Monica Android");
const CARD_FRONT_NAME = "Monica_BankCard_Front.jpg";
const CARD_BACK_NAME = "Monica_BankCard_Back.jpg";
const CARD_RECEIPT_NAME = "receipt.pdf";
const CARD_FRONT_BYTES = new TextEncoder().encode("android bank card front photo");
const CARD_BACK_BYTES = new TextEncoder().encode("android bank card back photo");
const CARD_FRONT_REPLACED_BYTES = new TextEncoder().encode("extension replaced bank card front photo");
const CARD_RECEIPT_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const DOCUMENT_FRONT_NAME = "Monica_Document_Front.jpg";
const DOCUMENT_BACK_NAME = "Monica_Document_Back.jpg";
const DOCUMENT_RECEIPT_NAME = "document-receipt.pdf";
const DOCUMENT_FRONT_BYTES = new TextEncoder().encode("android document front photo");
const DOCUMENT_BACK_BYTES = new TextEncoder().encode("android document back photo");
const DOCUMENT_FRONT_REPLACED_BYTES = new TextEncoder().encode("extension replaced document front photo");
const DOCUMENT_RECEIPT_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const PASSKEY_CREDENTIAL_ID = "YW5kcm9pZC1pbnRlcm9wLWNyZWRlbnRpYWw";
const PRIVATE_KEY_BASE64 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkW37q4De5OLmElVzGV+eVyxKWzUYTgiSmQGGNnkVvqKhRANCAATo31tQ78NEbm2ja6k1Omi1xPfSUGS3V74fv6x7WzvFrNxBDYm+FGmQVEiECyXmpcFTNeV0D/WFBONp8oJJZPn0";
const PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY_BASE64}\n-----END PRIVATE KEY-----`;
const JVM_ANDROID_SOURCES = [
  "data/PasskeyEntry.kt", "data/SecureItem.kt", "data/LocalKeePassDatabase.kt",
  "keepass/KeePassChangeSet.kt", "keepass/KeePassSecureItemPhotoAttachments.kt",
  "keepass/KeePassPasskeySyncCodec.kt", "utils/KeePassCodecSupport.kt",
  "passkey/PasskeyPrivateKeySupport.kt"
];

interface SupportedVariant {
  id: "aes" | "chacha20";
  inputName: string;
  outputName: string;
  cipherName: "AES-256" | "ChaCha20";
  editedUsername: string;
  editedNotes: string;
}

const SUPPORTED_VARIANTS: SupportedVariant[] = [
  {
    id: "aes",
    inputName: "android-aes.kdbx",
    outputName: "extension-aes.kdbx",
    cipherName: "AES-256",
    editedUsername: "extension-aes-user",
    editedNotes: "Edited by Monica Extension through AES-256"
  },
  {
    id: "chacha20",
    inputName: "android-chacha20.kdbx",
    outputName: "extension-chacha20.kdbx",
    cipherName: "ChaCha20",
    editedUsername: "extension-chacha20-user",
    editedNotes: "Edited by Monica Extension through ChaCha20"
  }
];

describe("KeePass current Android and browser KDBX interoperability", () => {
  it("round-trips Android Kotpass AES and ChaCha20 files and rejects Android Twofish explicitly", async () => {
    const extensionRoot = resolve(process.cwd());
    const androidRepository = process.env.MONICA_ANDROID_REPOSITORY || join(resolve(extensionRoot, ".."), "Monica-main");
    const androidProject = join(androidRepository, "Monica for Android");
    const initScript = join(extensionRoot, "tests", "interop", "android-keepass", "interop.init.gradle");
    const sourceDirectory = join(extensionRoot, "tests", "interop", "android-keepass", "src");
    const gradlew = join(androidProject, process.platform === "win32" ? "gradlew.bat" : "gradlew");
    for (const required of [androidProject, initScript, sourceDirectory, gradlew]) {
      if (!existsSync(required)) throw new Error(`KeePass interoperability input is missing: ${required}`);
    }

    const beforeStatus = await runText("git", ["status", "--porcelain=v1", "-uall"], { cwd: androidRepository });
    const androidRevision = await runText("git", ["rev-parse", "HEAD"], { cwd: androidRepository });
    const standalone = process.env.MONICA_KEEPASS_INTEROP_STANDALONE === "1";
    const coreSources = join(androidProject, "app/src/main/java/takagi/ru/monica");
    const sourceHashes = Object.fromEntries(await Promise.all(JVM_ANDROID_SOURCES.map(async file => [file, sha256Hex(await readFile(join(coreSources, file)))])));
    const tempParent = join(extensionRoot, ".tmp", "keepass-android-interop");
    await mkdir(tempParent, { recursive: true });
    const runRoot = await mkdtemp(join(tempParent, "run-"));
    let primaryError: unknown;
    let evidence: Record<string, unknown> | undefined;
    try {
      const jvmProject = standalone ? await prepareStandaloneJvm(extensionRoot, coreSources, sourceDirectory, runRoot) : undefined;
      await runAndroidFixtureMethod(androidProject, initScript, sourceDirectory, runRoot, "generateAndroidKdbxFixtures", jvmProject);

      const variantEvidence: Record<string, unknown>[] = [];
      for (const variant of SUPPORTED_VARIANTS) {
        const input = new Uint8Array(await readFile(join(runRoot, variant.inputName)));
        expect(readKeePassHeader(input, variant.inputName)).toMatchObject({
          format: "kdbx",
          versionMajor: 4,
          cipherName: variant.cipherName
        });

        const target = account(`keepass-android-${variant.id}`, variant.id === "aes" ? 41 : 42);
        const provider = new KeePassProvider();
        const summary = await provider.unlock(target, input, { password: PASSWORD, sourceName: variant.inputName });
        expect(summary).toMatchObject({
          versionMajor: 4,
          cipherName: variant.cipherName,
          itemCount: 4,
          dirty: false
        });
        expect(summary.skipped).toHaveLength(1);
        expect(summary.skipped[0].reason).toBe("unknown-item-type");

        const synchronized = await provider.sync(target, {
          now: "2026-08-07T00:00:00.000Z",
          localItems: []
        });
        const login = synchronized.items.find((item): item is LoginItem => item.kind === "login" && item.title === "GitHub");
        expect(login).toBeDefined();
        const passkey = synchronized.items.find((item): item is PasskeyItem => item.kind === "passkey" && item.credentialId === PASSKEY_CREDENTIAL_ID);
        expect(passkey).toMatchObject({
          rpId: "github.com", userName: "octocat", privateKeyPkcs8: PRIVATE_KEY_BASE64,
          signCount: 4, useCount: 3, backupEligible: true, backupState: true
        });
        const card = synchronized.items.find((item): item is CardItem => item.kind === "card" && item.title === "Android Bank Card");
        expect(card).toBeDefined();
        expect(card).toMatchObject({
          number: "4111111111111111",
          cardholderName: "Android Card Holder",
          expiryMonth: "12",
          expiryYear: "2030",
          securityCode: "123"
        });
        const document = synchronized.items.find((item): item is IdentityItem => item.kind === "identity" && item.title === "Android Passport");
        expect(document).toBeDefined();
        expect(document).toMatchObject({
          documentType: "PASSPORT",
          documentNumber: "P99887766",
          fullName: "Android Document"
        });
        expect(login).toMatchObject({
          username: "octocat",
          password: "old-password",
          notes: "original notes",
          totpSecret: expect.stringContaining("secret=JBSWY3DPEHPK3PXP")
        });
        expect(login!.customFields).toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "External Unknown Field", value: "unknown must stay", protected: false }),
          expect.objectContaining({ name: "Recovery PIN", value: "123456", protected: true })
        ]));
        expect(synchronized.sourceRecords).toHaveLength(1);
        expect(synchronized.sourceRecords?.[0].payload).toContain("Future Plugin Field");

        const attachment = provider.listAttachments(target, login!);
        expect(attachment).toHaveLength(1);
        expect(attachment[0]).toMatchObject({ fileName: "recovery.txt", sizeBytes: ATTACHMENT_BYTES.length });
        const attachmentRead = provider.readAttachment(target, login!, attachment[0].attachmentId, 0);
        expect(attachmentRead.eof).toBe(true);
        expect(attachmentRead.bytes).toEqual(ATTACHMENT_BYTES);
        expect(provider.listEntryHistory(target, login!)).toMatchObject({ totalCount: 1 });

        const cardAttachments = provider.listAttachments(target, card!);
        expect(cardAttachments.map((attachment) => attachment.fileName).sort()).toEqual([
          CARD_BACK_NAME,
          CARD_FRONT_NAME,
          CARD_RECEIPT_NAME
        ].sort());
        expect(cardAttachments.find((attachment) => attachment.fileName === CARD_FRONT_NAME)?.sizeBytes).toBe(CARD_FRONT_BYTES.length);
        expect(cardAttachments.find((attachment) => attachment.fileName === CARD_BACK_NAME)?.sizeBytes).toBe(CARD_BACK_BYTES.length);
        expect(cardAttachments.find((attachment) => attachment.fileName === CARD_RECEIPT_NAME)?.sizeBytes).toBe(CARD_RECEIPT_BYTES.length);
        for (const [fileName, expected] of [[CARD_FRONT_NAME, CARD_FRONT_BYTES], [CARD_BACK_NAME, CARD_BACK_BYTES], [CARD_RECEIPT_NAME, CARD_RECEIPT_BYTES]] as const) {
          const attachment = cardAttachments.find((candidate) => candidate.fileName === fileName);
          expect(attachment).toBeDefined();
          expect(provider.readAttachment(target, card!, attachment!.attachmentId, 0).bytes).toEqual(expected);
        }

        const documentAttachments = provider.listAttachments(target, document!);
        expect(documentAttachments.map((attachment) => attachment.fileName).sort()).toEqual([
          DOCUMENT_BACK_NAME,
          DOCUMENT_FRONT_NAME,
          DOCUMENT_RECEIPT_NAME
        ].sort());
        for (const [fileName, expected] of [[DOCUMENT_FRONT_NAME, DOCUMENT_FRONT_BYTES], [DOCUMENT_BACK_NAME, DOCUMENT_BACK_BYTES], [DOCUMENT_RECEIPT_NAME, DOCUMENT_RECEIPT_BYTES]] as const) {
          const attachment = documentAttachments.find((candidate) => candidate.fileName === fileName);
          expect(attachment).toBeDefined();
          expect(provider.readAttachment(target, document!, attachment!.attachmentId, 0).bytes).toEqual(expected);
        }

        const rawInput = await openRaw(input);
        assertRawFixture(rawInput, 1, "octocat", "original notes", "Monica Android interop", "Android Card Holder", CARD_FRONT_BYTES, "Android Document Holder", DOCUMENT_FRONT_BYTES);

        await provider.update(target, {
          ...login!,
          username: variant.editedUsername,
          notes: variant.editedNotes
        });
        const updatedCard = await provider.update(target, {
          ...card!,
          cardholderName: "Extension Card Holder"
        });
        const replacedCardPhoto = await provider.addAttachment(
          target,
          updatedCard,
          CARD_FRONT_NAME,
          CARD_FRONT_REPLACED_BYTES,
          true
        );
        expect(replacedCardPhoto).toMatchObject({ fileName: CARD_FRONT_NAME, sizeBytes: CARD_FRONT_REPLACED_BYTES.length });
        const updatedDocument = await provider.update(target, {
          ...document!,
          fullName: "Extension Document Holder"
        });
        const replacedDocumentPhoto = await provider.addAttachment(
          target,
          updatedDocument,
          DOCUMENT_FRONT_NAME,
          DOCUMENT_FRONT_REPLACED_BYTES,
          true
        );
        expect(replacedDocumentPhoto).toMatchObject({ fileName: DOCUMENT_FRONT_NAME, sizeBytes: DOCUMENT_FRONT_REPLACED_BYTES.length });
        const exported = await provider.exportFile(target.id);
        expect(readKeePassHeader(exported, variant.outputName).cipherName).toBe(variant.cipherName);
        const rawExport = await openRaw(exported);
        assertRawFixture(rawExport, 2, variant.editedUsername, variant.editedNotes, "KdbxWeb", "Extension Card Holder", CARD_FRONT_REPLACED_BYTES, "Extension Document Holder", DOCUMENT_FRONT_REPLACED_BYTES);
        await writeFile(join(runRoot, variant.outputName), exported);
        variantEvidence.push({
          cipher: variant.cipherName,
          inputSize: input.length,
          inputSha256: sha256Hex(input),
          outputSize: exported.length,
          outputSha256: sha256Hex(exported)
        });

        // Keep the unchanged-field fixture above separate from a real Passkey use.
        // Android must still load and sign with the key after browser usage resets a legacy counter.
        const challenge = Buffer.alloc(32, variant.id === "aes" ? 33 : 34).toString("base64url");
        const assertion = await signPortablePasskey(passkey!, challenge);
        await provider.update(target, {
          ...passkey!, signCount: assertion.signCount, useCount: 4,
          lastUsedAt: "2026-09-14T00:00:00.000Z"
        });
        await writeFile(join(runRoot, `extension-passkey-${variant.id}.kdbx`), await provider.exportFile(target.id));
        await writeFile(join(runRoot, `extension-passkey-${variant.id}.json`), JSON.stringify({
          challenge, publicKeySpki: fixturePublicKey().export({ type: "spki", format: "der" }).toString("base64"),
          ...assertion.response
        }));
      }

      const twofish = new Uint8Array(await readFile(join(runRoot, "android-twofish.kdbx")));
      expect(readKeePassHeader(twofish, "android-twofish.kdbx")).toMatchObject({
        format: "kdbx",
        versionMajor: 4,
        cipherName: "Twofish"
      });
      await expect(new KeePassProvider().unlock(account("keepass-android-twofish", 43), twofish, {
        password: PASSWORD,
        sourceName: "android-twofish.kdbx"
      })).rejects.toMatchObject({
        code: "cipher-unsupported",
        message: expect.stringContaining("AES-256")
      });

      await runAndroidFixtureMethod(androidProject, initScript, sourceDirectory, runRoot, "verifyExtensionKdbxExports", jvmProject);
      for (const variant of SUPPORTED_VARIANTS) {
        const request = JSON.parse(await readFile(join(runRoot, `extension-passkey-${variant.id}.json`), "utf8"));
        const signatures: string[] = JSON.parse(await readFile(join(runRoot, `android-passkey-${variant.id}.json`), "utf8"));
        const signedData = Buffer.concat([
          Buffer.from(request.authenticatorData, "base64url"),
          createHash("sha256").update(Buffer.from(request.clientDataJSON, "base64url")).digest()
        ]);
        expect(signatures).toHaveLength(2);
        for (const signature of signatures) expect(verify("sha256", signedData, fixturePublicKey(), Buffer.from(signature, "base64url"))).toBe(true);
        const returnedProvider = new KeePassProvider();
        const target = account(`android-returned-${variant.id}`, variant.id === "aes" ? 44 : 45);
        await returnedProvider.unlock(target, new Uint8Array(await readFile(join(runRoot, `android-passkey-${variant.id}.kdbx`))), { password: PASSWORD });
        const returned = await returnedProvider.sync(target, { now: "2026-09-14T00:02:00.000Z", localItems: [] });
        const passkey = returned.items.find((item): item is PasskeyItem => item.kind === "passkey");
        expect(passkey).toMatchObject({ credentialId: PASSKEY_CREDENTIAL_ID, privateKeyPkcs8: PRIVATE_KEY_BASE64, signCount: 0, useCount: 5, backupEligible: true, backupState: true });
        await signPortablePasskey(passkey!, request.challenge);
      }
      evidence = {
        androidRevision,
        androidExecution: standalone ? "isolated JVM with verbatim Android core sources" : "Android app JVM unit tests",
        androidSourceSha256: sourceHashes,
        supportedCiphers: variantEvidence,
        rejectedCipher: "Twofish",
        passkeyPortability: {
          recognizedWithUsernameAndUrl: true,
          legacyStoredCounter: 4,
          assertionCounter: 0,
          verifiedAndroidSignatures: 4,
          androidHelpers: ["KeePassPasskeySyncCodec", "PasskeyPrivateKeySupport"],
          roundTrip: "Android KDBX → browser sign/export → Android decode/sign/export → browser sign",
          privateKeyAndCredentialIdPreserved: true
        },
        preserved: [
          "protected fields",
          "OTP parameters",
          "unknown fields",
          "entry and group CustomData",
          "timestamps",
          "history",
          "attachments and binary pool",
          "Android-managed bank-card front/back photos and ordinary attachments",
          "Android-managed document front/back photos and ordinary attachments",
          "KeePassDX and Monica passkey fields",
          "nested groups and future entries"
        ]
      };
      await writeFile(join(runRoot, "evidence.json"), JSON.stringify(evidence, null, 2));
      process.stdout.write(`KEEPASS_ANDROID_BROWSER_INTEROP ${JSON.stringify(evidence)}\n`);
    } catch (error) {
      primaryError = error;
    }

    const finalErrors: unknown[] = [];
    try {
      const afterStatus = await runText("git", ["status", "--porcelain=v1", "-uall"], { cwd: androidRepository });
      if (!standalone && afterStatus !== beforeStatus) {
        finalErrors.push(new Error("Android repository state changed during KeePass interoperability acceptance."));
      }
      for (const [file, hash] of Object.entries(sourceHashes)) {
        if (sha256Hex(await readFile(join(coreSources, file))) !== hash) finalErrors.push(new Error(`Android core source changed during verification: ${file}`));
      }
    } catch (error) {
      finalErrors.push(error);
    }
    if (process.env.MONICA_KEEPASS_INTEROP_KEEP !== "1") {
      try {
        const resolvedParent = await realpath(tempParent);
        const resolvedRun = await realpath(runRoot);
        if (dirname(resolvedRun) !== resolvedParent || !basename(resolvedRun).startsWith("run-")) {
          throw new Error("Refusing to remove an unexpected interoperability directory.");
        }
        await rm(resolvedRun, { recursive: true, force: true });
      } catch (error) {
        finalErrors.push(error);
      }
    }
    if (primaryError && finalErrors.length) {
      throw new AggregateError([primaryError, ...finalErrors], "KeePass interoperability and cleanup checks failed.");
    }
    if (primaryError) throw primaryError;
    if (finalErrors.length === 1) throw finalErrors[0];
    if (finalErrors.length > 1) throw new AggregateError(finalErrors, "KeePass interoperability cleanup checks failed.");
    expect(evidence).toBeDefined();
  });
});

function fixturePublicKey() {
  return createPublicKey(PRIVATE_KEY_PEM);
}

async function signPortablePasskey(item: PasskeyItem, challenge: string) {
  const assertion = await createAssertion({
    origin: "https://github.com", challenge, rpId: item.rpId,
    credentialId: item.credentialId, userHandle: item.userHandle,
    privateKeyPkcs8: item.privateKeyPkcs8!, signCount: 0,
    backupEligible: item.backupEligible, backupState: item.backupState, userVerified: true
  });
  const authData = Buffer.from(assertion.response.authenticatorData, "base64url");
  const clientData = Buffer.from(assertion.response.clientDataJSON, "base64url");
  expect(authData[32]).toBe(0x1d);
  expect(authData.readUInt32BE(33)).toBe(0);
  expect(assertion.signCount).toBe(0);
  expect(verify("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), fixturePublicKey(), Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
  return assertion;
}

async function runAndroidFixtureMethod(
  androidProject: string,
  initScript: string,
  sourceDirectory: string,
  interopDirectory: string,
  method: "generateAndroidKdbxFixtures" | "verifyExtensionKdbxExports",
  jvmProject?: string
): Promise<void> {
  const command = process.platform === "win32" ? ".\\gradlew.bat" : join(androidProject, "gradlew");
  const projectArgs = jvmProject
    ? ["--project-dir", jvmProject, "-Pkotlin.compiler.execution.strategy=in-process", "test"]
    : ["-I", initScript, ":app:testDebugUnitTest"];
  process.stdout.write(`KEEPASS_ANDROID_FIXTURE ${method} (${jvmProject ? "isolated JVM" : "Android app"})\n`);
  await runCommand(command, [
    ...projectArgs,
    ...(process.env.MONICA_KEEPASS_INTEROP_OFFLINE === "1" ? ["--offline"] : []),
    "--tests",
    `${FIXTURE_CLASS}.${method}`,
    "--no-daemon",
    "--console=plain",
    "--stacktrace"
  ], {
    cwd: androidProject,
    env: {
      ...process.env,
      MONICA_KEEPASS_INTEROP_SOURCE_DIR: sourceDirectory,
      MONICA_KEEPASS_INTEROP_DIR: interopDirectory
    },
    timeoutMs: 15 * 60_000,
    shell: process.platform === "win32"
  });
}

async function prepareStandaloneJvm(extensionRoot: string, coreSources: string, fixtures: string, runRoot: string): Promise<string> {
  const apiJar = process.env.MONICA_ANDROID_API_JAR;
  if (!apiJar || !existsSync(apiJar)) throw new Error("MONICA_ANDROID_API_JAR must name the local Android SDK android.jar for standalone JVM verification.");
  const project = join(runRoot, "jvm");
  const template = join(extensionRoot, "tests/interop/android-keepass/jvm");
  await mkdir(project, { recursive: true });
  for (const name of ["build.gradle", "settings.gradle"]) await cp(join(template, name), join(project, name));
  for (const file of JVM_ANDROID_SOURCES) {
    const target = join(project, "src/main/kotlin/takagi/ru/monica", file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(coreSources, file), target);
  }
  await cp(fixtures, join(project, "src/test/kotlin"), { recursive: true });
  return project;
}

function account(id: string, databaseId: number): ProviderAccount {
  return {
    id,
    kind: "keepass",
    name: `Android ${id}`,
    enabled: true,
    isDefaultSaveTarget: false,
    config: { databaseId }
  };
}

async function openRaw(bytes: Uint8Array): Promise<kdbxweb.Kdbx> {
  return await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials(PASSWORD));
}

function assertRawFixture(
  database: kdbxweb.Kdbx,
  expectedHistoryCount: number,
  expectedUsername: string,
  expectedNotes: string,
  expectedGenerator: string,
  expectedCardHolder = "Android Card Holder",
  expectedCardFront = CARD_FRONT_BYTES,
  expectedDocumentHolder = "Android Document Holder",
  expectedDocumentFront = DOCUMENT_FRONT_BYTES
): void {
  expect(database.meta.generator).toBe(expectedGenerator);
  expect(database.meta.name).toBe("Android KeePass interoperability");
  expect(database.meta.defaultUser).toBe("android-default");
  expect(database.meta.customData?.get("database-plugin")?.value).toBe("database state must stay");

  const group = findGroup(database.getDefaultGroup(), "Android Interop");
  expect(group).toBeDefined();
  expect(group!.notes).toBe("group notes must stay");
  expect(group!.tags).toEqual(["android-group", "interop"]);
  expect(group!.customData?.get("group-plugin")?.value).toBe("group state must stay");

  const login = group!.entries.find((entry) => keePassFieldText(entry.fields.get("Title")) === "GitHub");
  expect(login).toBeDefined();
  expect(keePassFieldText(login!.fields.get("UserName"))).toBe(expectedUsername);
  expect(keePassFieldText(login!.fields.get("Notes"))).toBe(expectedNotes);
  expect(keePassFieldText(login!.fields.get("Password"))).toBe("old-password");
  expect(login!.fields.get("Password")).toBeInstanceOf(kdbxweb.ProtectedValue);
  expect(keePassFieldText(login!.fields.get("otp"))).toContain("secret=JBSWY3DPEHPK3PXP");
  expect(login!.fields.get("TOTP Seed")).toBeInstanceOf(kdbxweb.ProtectedValue);
  expect(keePassFieldText(login!.fields.get("External Unknown Field"))).toBe("unknown must stay");
  expect(login!.fields.get("Recovery PIN")).toBeInstanceOf(kdbxweb.ProtectedValue);
  expect(keePassFieldText(login!.fields.get("Recovery PIN"))).toBe("123456");
  expect(login!.tags).toEqual(["work", "totp"]);
  expect(login!.times.usageCount).toBe(7);
  expect(login!.customData?.get("plugin-state")?.value).toBe("custom must stay");
  expect(login!.history).toHaveLength(expectedHistoryCount);
  expect(binaryBytes(login!.binaries.get("recovery.txt")!)).toEqual(ATTACHMENT_BYTES);

  const card = group!.entries.find((entry) => keePassFieldText(entry.fields.get("Title")) === "Android Bank Card");
  expect(card).toBeDefined();
  expect(keePassFieldText(card!.fields.get("Card Holder"))).toBe(expectedCardHolder);
  expect(binaryBytes(card!.binaries.get(CARD_FRONT_NAME)!)).toEqual(expectedCardFront);
  expect(binaryBytes(card!.binaries.get(CARD_BACK_NAME)!)).toEqual(CARD_BACK_BYTES);
  expect(binaryBytes(card!.binaries.get(CARD_RECEIPT_NAME)!)).toEqual(CARD_RECEIPT_BYTES);

  const document = group!.entries.find((entry) => keePassFieldText(entry.fields.get("Title")) === "Android Passport");
  expect(document).toBeDefined();
  const documentData = JSON.parse(keePassFieldText(document!.fields.get("MonicaItemData")));
  expect(documentData.fullName).toBe(expectedDocumentHolder);
  expect(binaryBytes(document!.binaries.get(DOCUMENT_FRONT_NAME)!)).toEqual(expectedDocumentFront);
  expect(binaryBytes(document!.binaries.get(DOCUMENT_BACK_NAME)!)).toEqual(DOCUMENT_BACK_BYTES);
  expect(binaryBytes(document!.binaries.get(DOCUMENT_RECEIPT_NAME)!)).toEqual(DOCUMENT_RECEIPT_BYTES);

  const historical = login!.history.find((entry) => keePassFieldText(entry.fields.get("Title")) === "Historical title");
  expect(historical).toBeDefined();
  expect(historical!.fields.get("TOTP Seed")).toBeInstanceOf(kdbxweb.ProtectedValue);
  if (expectedHistoryCount === 2) {
    const extensionSnapshot = login!.history.find((entry) =>
      keePassFieldText(entry.fields.get("Title")) === "GitHub" &&
      keePassFieldText(entry.fields.get("UserName")) === "octocat"
    );
    expect(extensionSnapshot).toBeDefined();
    expect(binaryBytes(extensionSnapshot!.binaries.get("recovery.txt")!)).toEqual(ATTACHMENT_BYTES);
  }

  const passkey = group!.entries.find((entry) => keePassFieldText(entry.fields.get("Title")) === "GitHub [Passkey]");
  expect(passkey).toBeDefined();
  expect(keePassFieldText(passkey!.fields.get("MonicaPasskeyCredentialId"))).toBe(PASSKEY_CREDENTIAL_ID);
  expect(passkey!.fields.get("MonicaPasskeyData")).toBeInstanceOf(kdbxweb.ProtectedValue);
  expect(passkey!.fields.get("KPEX_PASSKEY_PRIVATE_KEY_PEM")).toBeInstanceOf(kdbxweb.ProtectedValue);
  expect(keePassFieldText(passkey!.fields.get("KPEX_PASSKEY_PRIVATE_KEY_PEM"))).toBe(PRIVATE_KEY_PEM);
  expect(passkey!.fields.get("KPEX_PASSKEY_CREDENTIAL_ID")).toBeInstanceOf(kdbxweb.ProtectedValue);
  expect(keePassFieldText(passkey!.fields.get("External Passkey Plugin Field"))).toBe("passkey plugin must stay");
  expect(passkey!.tags).toEqual(["passkey"]);
  expect(passkey!.customData?.get("passkey-plugin-state")?.value).toBe("passkey custom must stay");
  expect(passkey!.qualityCheck).toBe(false);

  const nested = findGroup(group!, "Nested Future Group");
  expect(nested).toBeDefined();
  expect(nested!.customData?.get("nested-plugin")?.value).toBe("nested state");
  const future = nested!.entries.find((entry) => keePassFieldText(entry.fields.get("Title")) === "Future Plugin Entry");
  expect(future).toBeDefined();
  expect(keePassFieldText(future!.fields.get("Future Plugin Field"))).toBe("future value must stay");
  expect(future!.fields.get("Future Protected Field")).toBeInstanceOf(kdbxweb.ProtectedValue);
}

function findGroup(root: kdbxweb.KdbxGroup, name: string): kdbxweb.KdbxGroup | undefined {
  if (root.name === name) return root;
  for (const child of root.groups) {
    const found = findGroup(child, name);
    if (found) return found;
  }
  return undefined;
}

function binaryBytes(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): Uint8Array {
  const value = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
  return value instanceof kdbxweb.ProtectedValue ? value.getBinary() : new Uint8Array(value);
}
