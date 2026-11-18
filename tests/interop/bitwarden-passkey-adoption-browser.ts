import { createLoginItem, type LoginItem, type PasskeyItem, type ProviderAccount, type VaultItem } from '../../src/core/model';
import { PROJECT_CREDENTIAL_FIELD } from '../../src/core/project-credentials';
import { createSourceRecord } from '../../src/core/source-records';
import { createPasskey } from '../../src/passkey/webauthn-core';
import { bytesToBase64, base64ToBytes } from '../../src/security/encoding';
import { SecureVaultService } from '../../src/security/secure-vault-service';
import { IndexedDbVaultStorage } from '../../src/security/vault-storage';
import { MemoryVaultSessionStore } from '../../src/security/vault-session';
import { BitwardenClient, type BitwardenSessionConfig } from '../../src/providers/bitwarden/bitwarden-client';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { BitwardenPasswordProjectRemovalCoordinator } from '../../src/providers/bitwarden/bitwarden-project-removal';
import { BitwardenDurableSyncCoordinator } from '../../src/providers/bitwarden/bitwarden-durable-sync';
import { decodeBitwardenCipher, encodeBitwardenCipher, encodeBitwardenPasskeyCipher } from '../../src/providers/bitwarden/bitwarden-cipher-codec';

// Dedicated loopback test origin/profile only. Remote HTTP is simulated by the
// injected fetcher; actual vault persistence uses Edge IndexedDB and WebCrypto.
const password = 'Synthetic browser preservation acceptance password';
const date = '2026-10-09T12:00:00.000Z';
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const load = <T>(name: string): T => JSON.parse(localStorage.getItem(name)!);
const save = (name: string, value: unknown) => localStorage.setItem(name, JSON.stringify(value));
class Storage extends IndexedDbVaultStorage {
  failNext = false;
  constructor() {
    super();
    const commit = this.records.commit;
    this.records.commit = async (...args) => {
      if (this.failNext) { this.failNext = false; throw new Error('Synthetic final vault save loss'); }
      await commit(...args);
    };
  }
}
const fetcher: typeof fetch = async (input, init) => {
  const url = new URL(String(input)), rows = load<Record<string, unknown>[]>('remote'), events = load<string[]>('events');
  const respond = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.pathname === '/api/sync') return respond({ ciphers: rows });
  if (url.pathname === '/api/ciphers' && init?.method === 'POST') {
    const copy = { ...JSON.parse(String(init.body)), id: crypto.randomUUID(), revisionDate: date, creationDate: date };
    rows.push(copy); events.push('create'); save('remote', rows); save('events', events);
    if (!localStorage.getItem('lost-create')) { localStorage.setItem('lost-create', 'yes'); throw new TypeError('Synthetic create response loss'); }
    return respond(copy);
  }
  const match = url.pathname.match(/^\/api\/ciphers\/([^/]+)(?:\/(details|delete))?$/);
  if (match) {
    const row = rows.find(row => row.id === decodeURIComponent(match[1])); check(row, 'Missing synthetic Cipher');
    if (match[2] === 'delete' && init?.method === 'PUT') {
      Object.assign(row!, { deletedDate: '2026-10-09T12:10:00.000Z', revisionDate: '2026-10-09T12:10:00.000Z' });
      events.push('delete'); save('events', events); save('remote', rows); return new Response(null, { status: 204 });
    }
    if (!init?.method || init.method === 'GET') return respond(row);
  }
  throw new Error(`Unexpected synthetic HTTP route: ${init?.method || 'GET'} ${url.pathname}`);
};

async function stage(vault: SecureVaultService) {
  const key = { encKey: crypto.getRandomValues(new Uint8Array(32)), macKey: crypto.getRandomValues(new Uint8Array(32)) };
  const session: BitwardenSessionConfig = { vaultUrl: 'https://synthetic.invalid', apiUrl: 'https://synthetic.invalid/api', identityUrl: 'https://synthetic.invalid/identity',
    email: 'synthetic@example.invalid', deviceId: crypto.randomUUID(), accessToken: 'synthetic', expiresAt: Date.now() + 3600000,
    kdf: { type: 0, iterations: 1 }, vaultKeyEnc: bytesToBase64(key.encKey), vaultKeyMac: bytesToBase64(key.macKey) };
  const account: ProviderAccount = { id: 'browser-preservation', kind: 'bitwarden', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: session };
  const rows: Record<string, unknown>[] = [], items: VaultItem[] = [], projectId = crypto.randomUUID();
  const identities: Array<{ id: string; credentialId: string; counter: number; publicKey: string }> = [];
  for (let index = 0; index < 2; index++) {
    const login: LoginItem = { ...createLoginItem({ title: 'Synthetic project', password: `synthetic-${index}` }), passwordGroupId: projectId,
      customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: true, value: JSON.stringify({ version: 1, projectId, groupId: crypto.randomUUID(), passwordId: crypto.randomUUID(),
        label: `Group ${index}`, primary: index === 0, groupOrder: index, passwordOrder: 0 }) }] };
    const row: Record<string, unknown> = { ...await encodeBitwardenCipher(login, key), id: crypto.randomUUID(), creationDate: date, revisionDate: date };
    const keys = [];
    if (index) for (const counter of [0, 23]) {
      const challenge = bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const created = await createPasskey({ origin: 'https://example.invalid', challenge, rpName: 'Synthetic RP', userId: 'c3ludGhldGlj',
        userName: 'Synthetic', userDisplayName: 'Synthetic', algorithms: [-7], excludeCredentialIds: [] });
      const item: PasskeyItem = { id: crypto.randomUUID(), kind: 'passkey', title: 'Synthetic RP', notes: '', favorite: false, createdAt: date, updatedAt: date, providerRefs: [],
        credentialId: created.credentialId, rpId: 'example.invalid', rpName: 'Synthetic RP', userHandle: 'c3ludGhldGlj', userName: 'Synthetic', userDisplayName: 'Synthetic',
        algorithm: -7, privateKeyPkcs8: created.privateKeyPkcs8, publicKey: created.publicKeySpki, signCount: counter, discoverable: true, sourceMode: 'bitwarden' };
      const encoded = await encodeBitwardenPasskeyCipher(item, key);
      keys.push(...(encoded.login as Record<string, unknown>).fido2Credentials as Record<string, unknown>[]);
      identities.push({ id: '', credentialId: created.credentialId, counter, publicKey: created.publicKeySpki });
    }
    if (keys.length) (row.login as Record<string, unknown>).fido2Credentials = keys;
    rows.push(row);
    for (const decoded of (await decodeBitwardenCipher(row, account.id, key)).items) {
      const id = crypto.randomUUID(); items.push({ ...decoded, id });
      if (decoded.kind === 'passkey') identities.find(row => row.credentialId === decoded.credentialId)!.id = id;
    }
  }
  await vault.setup(password, items); await vault.upsertProvider(account);
  const originals = (await vault.readState()).items.filter((row): row is LoginItem => row.kind === 'login');
  const operationId = crypto.randomUUID();
  await vault.stagePasswordProjectRemoval({ operationId, items: originals, expected: Object.fromEntries(originals.map(row => [row.id, row.updatedAt])), removedItemIds: [originals[1].id] });
  const staged = await vault.readState(), acknowledged: VaultItem[] = [], envelopes = [];
  for (const local of staged.items.filter((row): row is LoginItem => row.kind === 'login')) {
    const id = local.providerRefs[0].remoteId!, position = rows.findIndex(row => row.id === id);
    rows[position] = { ...rows[position], ...await encodeBitwardenCipher(local, key, rows[position]), id, creationDate: date, revisionDate: date };
    for (const decoded of (await decodeBitwardenCipher(rows[position], account.id, key)).items) {
      const original = staged.items.find(row => row.providerRefs[0]?.remoteId === decoded.providerRefs[0].remoteId)!;
      acknowledged.push({ ...decoded, id: original.id });
    }
    envelopes.push(await createSourceRecord({ providerId: account.id, remoteId: id, format: 'bitwarden-cipher', encoding: 'json', revision: date, payload: JSON.stringify(rows[position]) }));
  }
  await vault.applyProviderSync(account.id, acknowledged, undefined, [], envelopes, staged.items);
  key.encKey.fill(0); key.macKey.fill(0);
  save('remote', rows); save('events', []); save('identities', identities); save('operation', operationId);
}

async function run(phase: 'stage' | 'commit-loss' | 'recover') {
  const storage = new Storage(), vault = new SecureVaultService(storage, new MemoryVaultSessionStore());
  if (phase === 'stage') { check(!await storage.read(), 'Profile is not empty'); await stage(vault); }
  else await vault.unlock(password);
  const operationId = load<string>('operation'), client = new BitwardenClient(fetcher), provider = new BitwardenProvider(fetcher);
  if (phase === 'commit-loss') {
    const complete = vault.completePasswordProjectBitwardenDeletion.bind(vault);
    vault.completePasswordProjectBitwardenDeletion = async input => { storage.failNext = true; return complete(input); };
  }
  let error: unknown;
  try { await new BitwardenPasswordProjectRemovalCoordinator(vault, client, provider).resume(operationId); } catch (caught) { error = caught; }
  const record = (await vault.readPasswordProjectRemovals())[0];
  if (phase !== 'recover') {
    check(error, 'Expected injected loss');
    check(phase === 'stage' ? record.bitwardenPasskeyPreservation?.sources[0].copies[0].stage === 'attempted' : record.bitwardenDeletion?.phase === 'committed', 'Unexpected persisted recovery stage');
    await vault.lock(); return { phase, status: 'passed', persisted: phase === 'stage' ? 'attempted' : 'committed' };
  }
  if (error) throw error;
  check(record.status === 'completed', 'Local adoption incomplete');
  const account = (await vault.getProvider('browser-preservation'))!;
  for (let index = 0; index < 2; index++) await new BitwardenDurableSyncCoordinator(provider, vault).synchronize(account);
  const state = await vault.readState(), identities = load<Array<{ id: string; credentialId: string; counter: number; publicKey: string }>>('identities');
  check(!state.mutationQueue.length && !state.providerConflicts.length, 'Unexpected queue or conflict');
  check(state.items.filter(row => row.kind === 'passkey' && !row.deletedAt).length === 2, 'Duplicate/missing live credentials');
  for (const original of identities) {
    const item = state.items.find(row => row.id === original.id) as PasskeyItem;
    check(item?.kind === 'passkey' && !item.deletedAt && item.credentialId === original.credentialId && item.signCount === original.counter, 'Credential identity changed');
    const privateKey = await crypto.subtle.importKey('pkcs8', base64ToBytes(item.privateKeyPkcs8!) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const publicKey = await crypto.subtle.importKey('spki', base64ToBytes(original.publicKey) as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const challenge = crypto.getRandomValues(new Uint8Array(32)), signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, challenge);
    check(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, challenge), 'Preserved key cannot sign');
  }
  const events = load<string[]>('events'); check(events.filter(row => row === 'create').length === 2 && events.filter(row => row === 'delete').length === 1, 'Writes were replayed');
  const envelope = await storage.read(); check(envelope?.cipher === 'AES-256-GCM' && !JSON.stringify(envelope).includes('Synthetic RP'), 'Vault not encrypted');
  await vault.lock();
  return { phase, status: 'passed', livePasskeys: 2, signaturesVerified: 2, counters: [0, 23], originalLocalIdsPreserved: true, creates: 2, deletes: 1, ordinarySyncs: 2, storage: 'Edge IndexedDB + WebCrypto' };
}
(globalThis as unknown as { runPasskeyAdoption: typeof run }).runPasskeyAdoption = run;
