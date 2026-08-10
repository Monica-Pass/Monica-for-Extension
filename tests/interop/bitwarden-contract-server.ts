import type { CardItem, LoginItem, PasskeyItem } from "../../src/core/model";
import { createLoginItem } from "../../src/core/model";
import { bytesToBase64 } from "../../src/security/encoding";
import {
  encodeBitwardenCipher,
  encodeBitwardenPasskeyCipher
} from "../../src/providers/bitwarden/bitwarden-cipher-codec";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import {
  deriveBitwardenMasterKey,
  deriveBitwardenMasterPasswordHash,
  encryptBitwardenString,
  stretchBitwardenMasterKey,
  type BitwardenSymmetricKey
} from "../../src/providers/bitwarden/bitwarden-crypto";

export type BitwardenContractProfile = "official" | "vaultwarden";

export const BITWARDEN_INTEROP_EMAIL = "interop@example.test";
export const BITWARDEN_INTEROP_MASTER_PASSWORD = "monica bitwarden contract password";
export const BITWARDEN_INTEROP_INITIAL_REVISION = "2026-08-08T08:00:00.000Z";

export interface BitwardenContractStats {
  prelogin: number;
  login: number;
  sync: number;
  createCipher: number;
  updateCipher: number;
  moveCollections: number;
  prepareAttachment: number;
  uploadAttachment: number;
  downloadAttachment: number;
  deleteAttachment: number;
  emptySync: number;
}

export interface BitwardenContractEvidence {
  profile: BitwardenContractProfile;
  responseStyle: string;
  attachmentTransport: "Azure" | "Direct";
  stats: BitwardenContractStats;
  signedRequestsCarriedAuthorization: boolean;
  finalCipherCount: number;
  secureItemAttachmentVerified?: boolean;
}

interface AttachmentMetadata {
  id: string;
  fileName: string;
  key?: string;
  size: string;
}

const PERSONAL_CIPHER_ID = "cipher-personal";
const PERSONAL_CARD_CIPHER_ID = "cipher-personal-card";
const ORGANIZATION_CIPHER_ID = "cipher-organization";
const ORGANIZATION_ID = "organization-1";
const OLD_COLLECTION_ID = "collection-old";
const TARGET_COLLECTION_ID = "collection-target";
const ACCESS_TOKEN = "recorded-access-token";
const REFRESH_TOKEN = "recorded-refresh-token";

export class RecordedBitwardenContractServer {
  readonly profile: BitwardenContractProfile;
  readonly vaultUrl: string;
  readonly providerId: string;
  readonly personalCipherId = PERSONAL_CIPHER_ID;
  readonly personalCardCipherId = PERSONAL_CARD_CIPHER_ID;
  readonly organizationCipherId = ORGANIZATION_CIPHER_ID;
  readonly organizationId = ORGANIZATION_ID;
  readonly oldCollectionId = OLD_COLLECTION_ID;
  readonly targetCollectionId = TARGET_COLLECTION_ID;
  readonly vaultKey: BitwardenSymmetricKey;
  readonly organizationKey: BitwardenSymmetricKey;
  readonly fetcher: typeof fetch;
  readonly stats: BitwardenContractStats = {
    prelogin: 0,
    login: 0,
    sync: 0,
    createCipher: 0,
    updateCipher: 0,
    moveCollections: 0,
    prepareAttachment: 0,
    uploadAttachment: 0,
    downloadAttachment: 0,
    deleteAttachment: 0,
    emptySync: 0
  };
  readonly signedAuthorizationHeaders: Array<string | null> = [];
  readonly events: string[] = [];

  private readonly ciphers = new Map<string, Record<string, unknown>>();
  private readonly attachmentBodies = new Map<string, Uint8Array>();
  private readonly organizations: Record<string, unknown>[] = [];
  private readonly collections: Record<string, unknown>[] = [];
  private protectedVaultKey = "";
  private protectedPrivateKey = "";
  private organizationKeyCipher = "";
  private expectedPasswordHash = "";
  private revisionCounter = 100;
  private attachmentCounter = 0;
  private createdCipherCounter = 0;

  constructor(profile: BitwardenContractProfile) {
    this.profile = profile;
    this.vaultUrl = `https://${profile}.bitwarden-contract.test`;
    this.providerId = `bitwarden-${profile}`;
    this.vaultKey = symmetricKey(profile === "official" ? 11 : 21);
    this.organizationKey = symmetricKey(profile === "official" ? 91 : 101);
    this.fetcher = this.handle.bind(this) as typeof fetch;
  }

  async initialize(): Promise<this> {
    await this.initializeAuthentication();
    await this.initializeOrganization();
    await this.initializeCiphers();
    return this;
  }

  cipher(cipherId: string): Record<string, unknown> {
    const cipher = this.ciphers.get(cipherId);
    if (!cipher) throw new Error(`Recorded Bitwarden Cipher is missing: ${cipherId}`);
    return structuredClone(cipher);
  }

  attachmentCount(cipherId = PERSONAL_CIPHER_ID): number {
    return attachmentList(this.cipher(cipherId)).length;
  }

  clearCiphers(): void {
    this.ciphers.clear();
  }

  evidence(): BitwardenContractEvidence {
    return {
      profile: this.profile,
      responseStyle: this.profile === "official"
        ? "PascalCase sync and full mutation responses"
        : "camelCase OrganizationsNew and reduced mutation responses",
      attachmentTransport: this.profile === "official" ? "Azure" : "Direct",
      stats: { ...this.stats },
      signedRequestsCarriedAuthorization: this.signedAuthorizationHeaders.some(Boolean),
      finalCipherCount: this.ciphers.size
    };
  }

  dispose(): void {
    this.vaultKey.encKey.fill(0);
    this.vaultKey.macKey.fill(0);
    this.organizationKey.encKey.fill(0);
    this.organizationKey.macKey.fill(0);
    for (const bytes of this.attachmentBodies.values()) bytes.fill(0);
    this.attachmentBodies.clear();
    this.protectedVaultKey = "";
    this.protectedPrivateKey = "";
    this.organizationKeyCipher = "";
    this.expectedPasswordHash = "";
  }

  private async initializeAuthentication(): Promise<void> {
    const kdf = { type: 0 as const, iterations: 10_000 };
    const masterKey = await deriveBitwardenMasterKey(BITWARDEN_INTEROP_MASTER_PASSWORD, BITWARDEN_INTEROP_EMAIL, kdf);
    const stretchedKey = await stretchBitwardenMasterKey(masterKey);
    try {
      this.expectedPasswordHash = await deriveBitwardenMasterPasswordHash(masterKey, BITWARDEN_INTEROP_MASTER_PASSWORD);
      this.protectedVaultKey = await new BitwardenClient((() => Promise.reject(new Error("unused"))) as unknown as typeof fetch)
        .protectVaultKey(this.vaultKey, stretchedKey, Uint8Array.from({ length: 16 }, (_, index) => index + 1));
    } finally {
      masterKey.fill(0);
      stretchedKey.encKey.fill(0);
      stretchedKey.macKey.fill(0);
    }
  }

  private async initializeOrganization(): Promise<void> {
    const pair = await crypto.subtle.generateKey({
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: Uint8Array.of(1, 0, 1),
      hash: "SHA-1"
    }, true, ["encrypt", "decrypt"]);
    const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const rawOrganizationKey = new Uint8Array(64);
    rawOrganizationKey.set(this.organizationKey.encKey);
    rawOrganizationKey.set(this.organizationKey.macKey, 32);
    try {
      const encryptedOrganizationKey = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, rawOrganizationKey));
      this.organizationKeyCipher = `4.${bytesToBase64(encryptedOrganizationKey)}`;
      this.protectedPrivateKey = await encryptBitwardenString(bytesToBase64(privateKeyPkcs8), this.vaultKey);
    } finally {
      privateKeyPkcs8.fill(0);
      rawOrganizationKey.fill(0);
    }

    this.organizations.push({
      id: ORGANIZATION_ID,
      name: await encryptBitwardenString("Monica Contract Organization", this.organizationKey),
      key: this.organizationKeyCipher,
      type: "Manager",
      status: "Confirmed",
      enabled: true,
      permissions: { editAnyCollection: false, createNewCollections: true },
      allowAdminAccessToAllCollectionItems: false,
      accessAll: false
    });
    this.collections.push(
      await this.collection(OLD_COLLECTION_ID, "Existing Collection"),
      await this.collection(TARGET_COLLECTION_ID, "Target Collection")
    );
  }

  private async collection(id: string, name: string): Promise<Record<string, unknown>> {
    return {
      id,
      organizationId: ORGANIZATION_ID,
      name: await encryptBitwardenString(name, this.organizationKey),
      readOnly: false,
      hidePasswords: false,
      manage: true,
      assigned: true,
      revisionDate: BITWARDEN_INTEROP_INITIAL_REVISION
    };
  }

  private async initializeCiphers(): Promise<void> {
    const personalLogin: LoginItem = {
      ...createLoginItem({
        title: "Personal Contract Login",
        username: "personal-user",
        password: "personal-server-secret",
        uris: ["https://personal.example.test"],
        notes: "personal fixture"
      }),
      id: "fixture-personal-login",
      createdAt: BITWARDEN_INTEROP_INITIAL_REVISION,
      updatedAt: BITWARDEN_INTEROP_INITIAL_REVISION
    };
    const passkey: PasskeyItem = {
      id: "fixture-personal-passkey",
      kind: "passkey",
      title: personalLogin.title,
      favorite: false,
      notes: "",
      createdAt: BITWARDEN_INTEROP_INITIAL_REVISION,
      updatedAt: BITWARDEN_INTEROP_INITIAL_REVISION,
      providerRefs: [],
      credentialId: "recorded-passkey-credential",
      rpId: "personal.example.test",
      rpName: "Personal Contract",
      userHandle: "cmVjb3JkZWQtdXNlcg",
      userName: "personal-user",
      userDisplayName: "Personal User",
      algorithm: -7,
      publicKey: "recorded-spki-material",
      privateKeyPkcs8: "recorded-pkcs8-material",
      signCount: 4,
      discoverable: true,
      sourceMode: "bitwarden"
    };
    let personal = await encodeBitwardenCipher(personalLogin, this.vaultKey);
    personal = await encodeBitwardenPasskeyCipher(passkey, this.vaultKey, personal);
    personal.id = PERSONAL_CIPHER_ID;
    personal.revisionDate = BITWARDEN_INTEROP_INITIAL_REVISION;
    personal.creationDate = BITWARDEN_INTEROP_INITIAL_REVISION;
    personal.passwordHistory = [{
      password: await encryptBitwardenString("historical-secret", this.vaultKey),
      lastUsedDate: "2026-08-07T08:00:00.000Z"
    }];
    personal.FutureServerField = { keep: true, profile: this.profile };
    this.ciphers.set(PERSONAL_CIPHER_ID, canonicalCipher(personal));

    const personalCard: CardItem = {
      id: "fixture-personal-card",
      kind: "card",
      title: "Personal Contract Card",
      favorite: false,
      notes: "personal card fixture",
      createdAt: BITWARDEN_INTEROP_INITIAL_REVISION,
      updatedAt: BITWARDEN_INTEROP_INITIAL_REVISION,
      providerRefs: [],
      cardholderName: "Personal Card Holder",
      number: "4111111111111111",
      expiryMonth: "12",
      expiryYear: "2030",
      securityCode: "123",
      cardType: "CREDIT",
      customFields: []
    };
    const personalCardCipher = await encodeBitwardenCipher(personalCard, this.vaultKey);
    personalCardCipher.id = PERSONAL_CARD_CIPHER_ID;
    personalCardCipher.revisionDate = BITWARDEN_INTEROP_INITIAL_REVISION;
    personalCardCipher.creationDate = BITWARDEN_INTEROP_INITIAL_REVISION;
    personalCardCipher.FutureCardField = { keep: true, profile: this.profile };
    this.ciphers.set(PERSONAL_CARD_CIPHER_ID, canonicalCipher(personalCardCipher));

    const organizationLogin: LoginItem = {
      ...createLoginItem({
        title: "Organization Contract Login",
        username: "organization-user",
        password: "organization-server-secret",
        uris: ["https://organization.example.test"]
      }),
      id: "fixture-organization-login",
      createdAt: "2026-08-08T08:00:01.000Z",
      updatedAt: "2026-08-08T08:00:01.000Z"
    };
    const organization = await encodeBitwardenCipher(organizationLogin, this.organizationKey);
    organization.id = ORGANIZATION_CIPHER_ID;
    organization.organizationId = ORGANIZATION_ID;
    organization.collectionIds = [OLD_COLLECTION_ID];
    organization.revisionDate = "2026-08-08T08:00:01.000Z";
    organization.creationDate = "2026-08-08T08:00:01.000Z";
    organization.FutureOrganizationField = { keep: true };
    this.ciphers.set(ORGANIZATION_CIPHER_ID, canonicalCipher(organization));
  }

  private async handle(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    const method = (init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    this.events.push(`${method} ${url.host}${url.pathname}`);

    if (url.host === this.objectHost()) return this.handleSignedObject(url, method, headers, init.body);
    if (url.origin !== this.vaultUrl) return json({ error: "unexpected-origin" }, 404);

    if (url.pathname === "/identity/accounts/prelogin/password" && method === "POST") {
      this.stats.prelogin += 1;
      const body = parseJson(init.body);
      if (String(body.email || "").toLowerCase() !== BITWARDEN_INTEROP_EMAIL) throw new Error("Recorded prelogin email mismatch.");
      return this.profile === "official"
        ? json({ Kdf: 0, KdfIterations: 10_000 })
        : json({ kdf: 0, kdfIterations: 10_000 });
    }

    if (url.pathname === "/identity/connect/token" && method === "POST") {
      this.stats.login += 1;
      const form = parseForm(init.body);
      if (form.get("username") !== BITWARDEN_INTEROP_EMAIL || form.get("password") !== this.expectedPasswordHash) {
        throw new Error("Recorded Bitwarden login proof mismatch.");
      }
      if (form.get("grant_type") !== "password" || form.get("client_id") !== "browser") throw new Error("Recorded Bitwarden login grant mismatch.");
      return this.profile === "official"
        ? json({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3_600, Key: this.protectedVaultKey })
        : json({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3_600, key: this.protectedVaultKey });
    }

    this.assertAuthorized(headers);
    if (url.pathname === "/api/sync" && method === "GET") {
      this.stats.sync += 1;
      if (!this.ciphers.size) this.stats.emptySync += 1;
      return json(this.syncPayload());
    }
    if (url.pathname === "/api/ciphers" && method === "POST") return this.createCipher(init.body);

    const collectionMatch = /^\/api\/ciphers\/([^/]+)\/collections_v2$/.exec(url.pathname);
    if (collectionMatch && method === "PUT") return this.moveCipherCollections(decodeURIComponent(collectionMatch[1]), init.body);

    const prepareAttachmentMatch = /^\/api\/ciphers\/([^/]+)\/attachment\/v2$/.exec(url.pathname);
    if (prepareAttachmentMatch && method === "POST") return this.prepareAttachment(decodeURIComponent(prepareAttachmentMatch[1]), init.body);

    const attachmentMatch = /^\/api\/ciphers\/([^/]+)\/attachment\/([^/]+)$/.exec(url.pathname);
    if (attachmentMatch) {
      return this.handleAttachment(
        decodeURIComponent(attachmentMatch[1]),
        decodeURIComponent(attachmentMatch[2]),
        method,
        init.body
      );
    }

    const cipherMatch = /^\/api\/ciphers\/([^/]+)$/.exec(url.pathname);
    if (cipherMatch && method === "PUT") return this.updateCipher(decodeURIComponent(cipherMatch[1]), init.body);
    return json({ error: "unexpected-request", method, path: url.pathname }, 404);
  }

  private syncPayload(): Record<string, unknown> {
    const ciphers = [...this.ciphers.values()].map((cipher) => this.projectCipher(cipher));
    if (this.profile === "official") {
      return {
        Profile: {
          Id: "recorded-user",
          Email: BITWARDEN_INTEROP_EMAIL,
          PrivateKey: this.protectedPrivateKey,
          Organizations: this.organizations.map(projectOfficialOrganization)
        },
        Ciphers: ciphers,
        Collections: this.collections.map(projectOfficialCollection),
        Folders: []
      };
    }
    return {
      profile: { id: "recorded-user", email: BITWARDEN_INTEROP_EMAIL, privateKey: this.protectedPrivateKey },
      organizationsNew: { data: structuredClone(this.organizations) },
      ciphers,
      collections: structuredClone(this.collections),
      folders: []
    };
  }

  private createCipher(body: BodyInit | null | undefined): Response {
    this.stats.createCipher += 1;
    const raw = canonicalCipher(parseJson(body));
    const id = `cipher-created-${++this.createdCipherCounter}`;
    raw.id = id;
    raw.creationDate = this.nextRevision();
    raw.revisionDate = raw.creationDate;
    this.ciphers.set(id, raw);
    return json(this.projectCipher(raw));
  }

  private updateCipher(cipherId: string, body: BodyInit | null | undefined): Response {
    this.stats.updateCipher += 1;
    const current = this.requireCipher(cipherId);
    const updated = canonicalCipher(parseJson(body));
    updated.id = cipherId;
    updated.creationDate = text(updated.creationDate) || text(current.creationDate) || BITWARDEN_INTEROP_INITIAL_REVISION;
    updated.revisionDate = this.nextRevision();
    this.ciphers.set(cipherId, updated);
    return this.profile === "official"
      ? json(this.projectCipher(updated))
      : json({ id: cipherId, revisionDate: updated.revisionDate });
  }

  private moveCipherCollections(cipherId: string, body: BodyInit | null | undefined): Response {
    this.stats.moveCollections += 1;
    const current = this.requireCipher(cipherId);
    const request = parseJson(body);
    const collectionIds = Array.isArray(request.collectionIds)
      ? request.collectionIds.filter((value): value is string => typeof value === "string")
      : [];
    current.collectionIds = [...new Set(collectionIds)];
    current.revisionDate = this.nextRevision();
    this.ciphers.set(cipherId, current);
    return this.profile === "official"
      ? json({ Unavailable: false, Cipher: this.projectCipher(current) })
      : json({ unavailable: false, cipher: { id: cipherId, revisionDate: current.revisionDate } });
  }

  private prepareAttachment(cipherId: string, body: BodyInit | null | undefined): Response {
    this.stats.prepareAttachment += 1;
    const current = this.requireCipher(cipherId);
    const request = parseJson(body);
    if (text(request.lastKnownRevisionDate) !== text(current.revisionDate)) throw new Error("Recorded attachment revision mismatch.");
    const attachmentId = `attachment-${++this.attachmentCounter}`;
    const metadata: AttachmentMetadata = {
      id: attachmentId,
      fileName: requiredText(request.fileName, "attachment file name"),
      key: requiredText(request.key, "attachment key"),
      size: String(requiredPositiveInteger(request.fileSize, "attachment size"))
    };
    current.attachments = [...attachmentList(current), metadata];
    current.revisionDate = this.nextRevision();
    this.ciphers.set(cipherId, current);
    if (this.profile === "official") {
      return json({
        FileUploadType: 1,
        AttachmentId: attachmentId,
        Url: this.signedUrl(attachmentId),
        CipherResponse: this.projectCipher(current)
      });
    }
    return json({
      fileUploadType: 0,
      attachmentId,
      cipherMiniResponse: {
        id: cipherId,
        revisionDate: current.revisionDate,
        attachments: structuredClone(current.attachments)
      }
    });
  }

  private async handleAttachment(
    cipherId: string,
    attachmentId: string,
    method: string,
    body: BodyInit | null | undefined
  ): Promise<Response> {
    const current = this.requireCipher(cipherId);
    const metadata = attachmentList(current).find((candidate) => candidate.id === attachmentId);
    if (!metadata) return json({ error: "attachment-not-found" }, 404);
    if (method === "GET") {
      return this.profile === "official"
        ? json({ Id: attachmentId, Url: this.signedUrl(attachmentId), FileName: metadata.fileName, Size: metadata.size, Key: metadata.key })
        : json({ id: attachmentId, url: this.signedUrl(attachmentId), fileName: metadata.fileName, size: metadata.size, key: metadata.key });
    }
    if (method === "POST") {
      if (this.profile !== "vaultwarden" || !(body instanceof FormData)) throw new Error("Recorded Direct upload contract mismatch.");
      const names = [...body.keys()];
      if (names.length !== 1 || names[0] !== "data") throw new Error("Direct attachment upload must contain only the data part.");
      const value = body.get("data");
      if (!(value instanceof Blob)) throw new Error("Recorded Direct attachment body is missing.");
      this.attachmentBodies.set(attachmentId, new Uint8Array(await value.arrayBuffer()));
      this.stats.uploadAttachment += 1;
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      const remaining = attachmentList(current).filter((candidate) => candidate.id !== attachmentId);
      current.attachments = remaining;
      current.revisionDate = this.nextRevision();
      this.ciphers.set(cipherId, current);
      const bytes = this.attachmentBodies.get(attachmentId);
      bytes?.fill(0);
      this.attachmentBodies.delete(attachmentId);
      this.stats.deleteAttachment += 1;
      return this.profile === "official" ? new Response(null, { status: 204 }) : json({ deleted: true });
    }
    return json({ error: "attachment-method" }, 405);
  }

  private async handleSignedObject(
    url: URL,
    method: string,
    headers: Headers,
    body: BodyInit | null | undefined
  ): Promise<Response> {
    this.signedAuthorizationHeaders.push(headers.get("Authorization"));
    const match = /^\/attachments\/([^/]+)$/.exec(url.pathname);
    if (!match) return new Response(null, { status: 404 });
    const attachmentId = decodeURIComponent(match[1]);
    if (method === "PUT") {
      if (this.profile !== "official" || headers.get("x-ms-blob-type") !== "BlockBlob") {
        throw new Error("Recorded Azure upload contract mismatch.");
      }
      this.attachmentBodies.set(attachmentId, await bodyBytes(body));
      this.stats.uploadAttachment += 1;
      return new Response(null, { status: 201 });
    }
    if (method === "GET") {
      const bytes = this.attachmentBodies.get(attachmentId);
      if (!bytes) return new Response(null, { status: 404 });
      this.stats.downloadAttachment += 1;
      return new Response(bytes.slice(), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) }
      });
    }
    return new Response(null, { status: 405 });
  }

  private projectCipher(cipher: Record<string, unknown>): Record<string, unknown> {
    return this.profile === "official" ? projectOfficialCipher(cipher) : structuredClone(cipher);
  }

  private requireCipher(cipherId: string): Record<string, unknown> {
    const current = this.ciphers.get(cipherId);
    if (!current) throw new Error(`Recorded Bitwarden Cipher is missing: ${cipherId}`);
    return structuredClone(current);
  }

  private assertAuthorized(headers: Headers): void {
    if (headers.get("Authorization") !== `Bearer ${ACCESS_TOKEN}`) throw new Error("Recorded Bitwarden API request is missing its Bearer token.");
  }

  private nextRevision(): string {
    const base = Date.parse("2026-08-08T08:00:00.000Z");
    return new Date(base + this.revisionCounter++ * 1_000).toISOString();
  }

  private objectHost(): string {
    return `${this.profile}-objects.bitwarden-contract.test`;
  }

  private signedUrl(attachmentId: string): string {
    return `https://${this.objectHost()}/attachments/${encodeURIComponent(attachmentId)}?sig=recorded`;
  }
}

function symmetricKey(seed: number): BitwardenSymmetricKey {
  return {
    encKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff),
    macKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + 64 + index) & 0xff)
  };
}

function parseJson(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") throw new Error("Recorded JSON request body is missing.");
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Recorded JSON request body is invalid.");
  return parsed as Record<string, unknown>;
}

function parseForm(body: BodyInit | null | undefined): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  throw new Error("Recorded token request form is missing.");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  if (typeof body === "string") return new TextEncoder().encode(body);
  throw new Error("Recorded binary request body is missing.");
}

function canonicalCipher(raw: Record<string, unknown>): Record<string, unknown> {
  const result = canonicalRecord(raw, CIPHER_FIELDS);
  if (isRecord(result.login)) result.login = canonicalRecord(result.login, LOGIN_FIELDS, {
    uris: (value) => recordArray(value).map((entry) => canonicalRecord(entry, URI_FIELDS)),
    fido2Credentials: (value) => recordArray(value).map((entry) => canonicalRecord(entry, FIDO2_FIELDS))
  });
  if (Array.isArray(result.attachments)) result.attachments = recordArray(result.attachments).map((entry) => canonicalRecord(entry, ATTACHMENT_FIELDS));
  return result;
}

function canonicalRecord(
  raw: Record<string, unknown>,
  fields: ReadonlyArray<readonly [string, string]>,
  transforms: Record<string, (value: unknown) => unknown> = {}
): Record<string, unknown> {
  const result = structuredClone(raw);
  for (const [camel, pascal] of fields) {
    const hasCamel = Object.prototype.hasOwnProperty.call(raw, camel);
    const hasPascal = Object.prototype.hasOwnProperty.call(raw, pascal);
    if (!hasCamel && !hasPascal) continue;
    const value = hasCamel ? raw[camel] : raw[pascal];
    delete result[pascal];
    result[camel] = transforms[camel] ? transforms[camel](value) : structuredClone(value);
  }
  return result;
}

function projectOfficialCipher(raw: Record<string, unknown>): Record<string, unknown> {
  return projectOfficialRecord(raw, CIPHER_FIELDS, {
    login: (value) => isRecord(value) ? projectOfficialRecord(value, LOGIN_FIELDS, {
      uris: (entries) => recordArray(entries).map((entry) => projectOfficialRecord(entry, URI_FIELDS)),
      fido2Credentials: (entries) => recordArray(entries).map((entry) => projectOfficialRecord(entry, FIDO2_FIELDS))
    }) : value,
    attachments: (value) => recordArray(value).map((entry) => projectOfficialRecord(entry, ATTACHMENT_FIELDS))
  });
}

function projectOfficialOrganization(raw: Record<string, unknown>): Record<string, unknown> {
  return projectOfficialRecord(raw, ORGANIZATION_FIELDS, {
    permissions: (value) => isRecord(value) ? projectOfficialRecord(value, PERMISSION_FIELDS) : value
  });
}

function projectOfficialCollection(raw: Record<string, unknown>): Record<string, unknown> {
  return projectOfficialRecord(raw, COLLECTION_FIELDS);
}

function projectOfficialRecord(
  raw: Record<string, unknown>,
  fields: ReadonlyArray<readonly [string, string]>,
  transforms: Record<string, (value: unknown) => unknown> = {}
): Record<string, unknown> {
  const result = structuredClone(raw);
  for (const [camel, pascal] of fields) {
    if (!Object.prototype.hasOwnProperty.call(raw, camel)) continue;
    const value = raw[camel];
    delete result[camel];
    result[pascal] = transforms[camel] ? transforms[camel](value) : structuredClone(value);
  }
  return result;
}

function attachmentList(raw: Record<string, unknown>): AttachmentMetadata[] {
  const values = Array.isArray(raw.attachments) ? raw.attachments : Array.isArray(raw.Attachments) ? raw.Attachments : [];
  return values.flatMap((value): AttachmentMetadata[] => {
    if (!isRecord(value)) return [];
    const canonical = canonicalRecord(value, ATTACHMENT_FIELDS);
    const id = text(canonical.id);
    const fileName = text(canonical.fileName);
    const size = text(canonical.size);
    if (!id || !fileName || !size) return [];
    return [{ id, fileName, size, ...(text(canonical.key) ? { key: text(canonical.key) } : {}) }];
  });
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord).map((entry) => structuredClone(entry)) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiredText(value: unknown, label: string): string {
  const result = text(value);
  if (!result) throw new Error(`Recorded ${label} is missing.`);
  return result;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`Recorded ${label} is invalid.`);
  return result;
}

const CIPHER_FIELDS = [
  ["id", "Id"], ["organizationId", "OrganizationId"], ["folderId", "FolderId"], ["collectionIds", "CollectionIds"],
  ["type", "Type"], ["name", "Name"], ["notes", "Notes"], ["favorite", "Favorite"], ["reprompt", "Reprompt"],
  ["key", "Key"], ["fields", "Fields"], ["login", "Login"], ["card", "Card"], ["identity", "Identity"],
  ["secureNote", "SecureNote"], ["sshKey", "SshKey"], ["attachments", "Attachments"], ["passwordHistory", "PasswordHistory"],
  ["revisionDate", "RevisionDate"], ["creationDate", "CreationDate"], ["deletedDate", "DeletedDate"], ["archivedDate", "ArchivedDate"]
] as const;

const LOGIN_FIELDS = [
  ["username", "Username"], ["password", "Password"], ["totp", "Totp"], ["uris", "Uris"], ["fido2Credentials", "Fido2Credentials"]
] as const;

const URI_FIELDS = [["uri", "Uri"], ["match", "Match"]] as const;

const FIDO2_FIELDS = [
  ["credentialId", "CredentialId"], ["keyType", "KeyType"], ["keyAlgorithm", "KeyAlgorithm"], ["keyCurve", "KeyCurve"],
  ["keyValue", "KeyValue"], ["rpId", "RpId"], ["rpName", "RpName"], ["userHandle", "UserHandle"], ["userName", "UserName"],
  ["userDisplayName", "UserDisplayName"], ["counter", "Counter"], ["discoverable", "Discoverable"], ["creationDate", "CreationDate"]
] as const;

const ATTACHMENT_FIELDS = [["id", "Id"], ["fileName", "FileName"], ["key", "Key"], ["size", "Size"], ["sizeName", "SizeName"]] as const;

const ORGANIZATION_FIELDS = [
  ["id", "Id"], ["name", "Name"], ["key", "Key"], ["type", "Type"], ["status", "Status"], ["enabled", "Enabled"],
  ["permissions", "Permissions"], ["allowAdminAccessToAllCollectionItems", "AllowAdminAccessToAllCollectionItems"],
  ["accessAll", "AccessAll"], ["limitCollectionCreation", "LimitCollectionCreation"], ["limitCollectionDeletion", "LimitCollectionDeletion"]
] as const;

const PERMISSION_FIELDS = [
  ["editAnyCollection", "EditAnyCollection"], ["deleteAnyCollection", "DeleteAnyCollection"], ["createNewCollections", "CreateNewCollections"]
] as const;

const COLLECTION_FIELDS = [
  ["id", "Id"], ["organizationId", "OrganizationId"], ["name", "Name"], ["readOnly", "ReadOnly"],
  ["hidePasswords", "HidePasswords"], ["manage", "Manage"], ["assigned", "Assigned"], ["revisionDate", "RevisionDate"]
] as const;
