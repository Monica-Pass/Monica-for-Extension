import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readItem } from './interop-315-edge-features.mjs';

const rpc = async (page, request) => {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const attachmentBytes = Buffer.from(' shared runtime attachment\r\n0007 ');
const memberField = 'monica.content.credential';

export async function runRemovalRuntime({ page, evidence, ui }) {
  assert.ok(process.env.MONICA_315_MDBX_FIXTURE, 'Explicit synthetic MDBX bootstrap required');
  await page.getByRole('button', { name: '密码源', exact: true }).click();
  await page.locator('m3e-list-action').filter({ hasText: '连接 MDBX2 保险库' }).click();
  const dialog = page.getByRole('dialog', { name: /MDBX2/ });
  await dialog.getByLabel('显示名称', { exact: true }).fill('Synthetic removal runtime');
  await dialog.getByLabel('MDBX2 可移植备份', { exact: true }).setInputFiles(process.env.MONICA_315_MDBX_FIXTURE);
  await dialog.getByLabel('保险库密码（可留空）', { exact: true }).fill('Synthetic transfer fixture password');
  await dialog.getByRole('button', { name: '验证、解锁并导入', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 60000 });
  const provider = (await rpc(page, { type: 'PROVIDER_LIST' })).find(row => row.name === 'Synthetic removal runtime');
  assert.ok(provider); const providerId = provider.id;
  const summaries = await rpc(page, { type: 'VAULT_LIST_ITEMS' });
  const seed = await readItem(page, summaries.find(row => row.kind === 'login').id);
  const state = { providerId, providerName: provider.name, vaultHandle: provider.config.vaultHandle, groups: [],
    scope: ui ? 'Actual Edge member-removal UI, Native writes, rich fields and attachment checks.' : 'Real Edge manager runtime messages and actual Native writes; member-removal controls are not exercised by this mode.' };
  evidence.removalRuntime = state;
  state.sourceSha256 = Object.fromEntries(await Promise.all([
    'src/background/index.ts', 'src/background/password-project-removal.ts', 'src/background/provider-operation-queue.ts',
    'src/core/password-project-removal-journal.ts', 'src/security/secure-vault-service.ts',
    'src/providers/mdbx2/mdbx2-project-removal.ts', 'src/providers/mdbx2/mdbx2-restore.ts',
    'src/runtime/messages.ts', 'src/runtime/client.ts', 'scripts/interop-317-edge-removal-runtime.mjs',
    ...(ui ? ['src/App.vue', 'src/components/ProjectCredentialEditor.vue', 'src/components/LoginEditorFields.vue', 'src/components/PasswordProjectPendingRemovals.vue', 'src/manager/project-removal-form.ts', 'src/manager/project-removal-save.ts', 'src/android-aligned-layout.css', 'scripts/interop-317-edge-removal-ui.mjs'] : []),
  ].map(async file => [file, hash(await readFile(new URL(`../${file}`, import.meta.url)))])));
  const popup = await page.context().newPage();
  try {
    await popup.goto(new URL('popup.html', page.url()).href);
    for (const type of ['VAULT_PASSWORD_PROJECT_REMOVALS', 'VAULT_PASSWORD_PROJECT_REMOVE', 'VAULT_PASSWORD_PROJECT_REMOVAL_RESUME', 'VAULT_PASSWORD_PROJECT_REMOVAL_CANCEL']) {
      const result = await popup.evaluate(type => chrome.runtime.sendMessage({ type }), type);
      assert.equal(result.ok, false); assert.match(result.error, /管理页/);
    }
    state.nonManagerDenied = true;
  } finally { await popup.close(); }

  for (const mode of ['complete', 'cancel', 'restart']) {
    const groupId = randomUUID(), credentialId = randomUUID(), secondaryId = randomUUID();
    const rows = [0, 1, 2].map(index => ({ ...seed, id: randomUUID(), replicaGroupId: undefined,
      passwordGroupId: groupId, title: `Synthetic runtime ${mode}`, username: 'runtime-account', password: `runtime-secret-${mode}-${index}`,
      loginType: 'PASSWORD', notes: '  exact notes\r\n0007 ', email: 'runtime@example.invalid', phone: '00123',
      providerRefs: [{ providerId }], imagePaths: undefined, passkeyBindings: undefined,
      customFields: [{ name: memberField, protected: true, value: JSON.stringify({ version: 1, projectId: groupId, groupId: ui && index === 2 ? secondaryId : credentialId,
        passwordId: randomUUID(), label: ui && index === 2 ? 'Recovery' : 'Primary', primary: !(ui && index === 2), groupOrder: ui && index === 2 ? 1 : 0, passwordOrder: ui && index === 2 ? 0 : index }).replace(/}$/, ',"future":9007199254740993}') },
      ...(index ? [] : [{ name: 'Shared custom', protected: true, value: '  exact protected text\r\n0007 ' }])] }));
    await rpc(page, { type: 'VAULT_SAVE_PASSWORD_GROUP', items: rows, expected: {} });
    const sync = await rpc(page, { type: 'PROVIDER_SYNC', providerId });
    const saved = await Promise.all(rows.map(row => readItem(page, row.id)));
    state.creationSync ||= [];
    state.creationSync.push({ mode, conflicts: sync.conflicts, saved: saved.map(row => ({ id: row.id, providerRefs: row.providerRefs })) });
    assert.equal(sync.conflicts, 0);
    assert.ok(saved.every(row => row.providerRefs.some(ref => ref.providerId === providerId && ref.remoteId)), 'Explicit sync must acknowledge all newly saved members');
    const upload = await rpc(page, { type: 'PROVIDER_ATTACHMENT_UPLOAD_BEGIN', providerId, itemId: saved[0].id,
      fileName: 'shared.txt', mediaType: 'text/plain', sizeBytes: attachmentBytes.length, sha256: hash(attachmentBytes), operationId: randomUUID() });
    await rpc(page, { type: 'PROVIDER_ATTACHMENT_UPLOAD_CHUNK', providerId, transferId: upload.transferId, offset: 0, dataBase64: attachmentBytes.toString('base64') });
    await rpc(page, { type: 'PROVIDER_ATTACHMENT_UPLOAD_FINISH', providerId, itemId: saved[0].id, transferId: upload.transferId });
    const current = await Promise.all(saved.map(row => readItem(page, row.id)));
    const input = { operationId: randomUUID(), items: current, expected: Object.fromEntries(current.map(row => [row.id, row.updatedAt])),
      removedItemIds: current.slice(0, 2).map(row => row.id) };
    const before = await rpc(page, { type: 'VAULT_PASSWORD_PROJECT_REMOVALS' });
    const unconfirmed = await page.evaluate(input => chrome.runtime.sendMessage({ type: 'VAULT_PASSWORD_PROJECT_REMOVE', input, confirmed: false }), input);
    assert.equal(unconfirmed.ok, false); assert.match(unconfirmed.error, /确认/);
    assert.deepEqual(await rpc(page, { type: 'VAULT_PASSWORD_PROJECT_REMOVALS' }), before);
    if (mode !== 'complete') await rpc(page, { type: 'MDBX2_VAULT_LOCK', providerId });
    const fromUi = ui ? await ui.remove({ page, mode, current }) : undefined;
    if (fromUi) input.operationId = fromUi.operationId;
    const result = fromUi?.result ?? await page.evaluate(input => chrome.runtime.sendMessage({ type: 'VAULT_PASSWORD_PROJECT_REMOVE', input, confirmed: true }), input);
    if (mode === 'complete') { assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.data.status, 'completed'); }
    else {
      assert.equal(result.ok, false, 'Locked native vault must retain preparation');
      const pending = (await rpc(page, { type: 'VAULT_PASSWORD_PROJECT_REMOVALS' })).find(row => row.operationId === input.operationId);
      assert.equal(pending.status, 'preparing'); assert.equal(pending.canCancel, true);
      assert.ok(!JSON.stringify(pending).includes('runtime-secret'));
      if (mode === 'cancel') {
        if (ui) await ui.cancel(page, input.operationId);
        else assert.equal((await rpc(page, { type: 'VAULT_PASSWORD_PROJECT_REMOVAL_CANCEL', operationId: input.operationId })).status, 'cancelled');
        await unlock(page, state); await rpc(page, { type: 'PROVIDER_SYNC', providerId });
        assert.equal((await rpc(page, { type: 'VAULT_PASSWORD_PROJECT_REMOVAL_RESUME', operationId: input.operationId })).status, 'cancelled');
      }
    }
    state.groups.push({ mode, groupId, operationId: input.operationId, original: current });
  }
  state.confirmationRequired = true; state.preparationCancellationPassed = true; state.pendingSavedForRestart = true;
}

export async function verifyRemovalRuntime(page, evidence, recover) {
  const state = evidence.removalRuntime;
  const pending = await rpc(page, { type: 'VAULT_PASSWORD_PROJECT_REMOVALS' });
  const restart = state.groups.find(row => row.mode === 'restart');
  assert.equal(pending.find(row => row.operationId === restart.operationId)?.status, 'preparing');
  if (recover) await recover(page, state, restart);
  else await unlock(page, state);
  // Source sync is the same recovery entry used after startup/unlock.
  await rpc(page, { type: 'PROVIDER_SYNC', providerId: state.providerId });
  assert.equal((await rpc(page, { type: 'VAULT_PASSWORD_PROJECT_REMOVAL_RESUME', operationId: restart.operationId })).status, 'completed');
  assert.deepEqual(await rpc(page, { type: 'VAULT_PASSWORD_PROJECT_REMOVALS' }), []);
  for (const group of state.groups) {
    const expectedLive = group.mode === 'cancel' ? group.original : group.original.slice(2);
    const live = (await rpc(page, { type: 'VAULT_LIST_ITEMS' })).filter(row => group.original.some(item => item.id === row.id));
    assert.deepEqual(live.map(row => row.id).sort(), expectedLive.map(row => row.id).sort());
    for (const row of expectedLive) {
      const current = await readItem(page, row.id);
      assert.equal(current.password, row.password); assert.equal(current.notes, row.notes);
      const ref = current.providerRefs.find(ref => ref.providerId === state.providerId);
      const remote = await rpc(page, { type: 'MDBX2_OBJECT_REVEAL', providerId: state.providerId, objectId: ref.remoteId });
      const payload = JSON.parse(remote.payloadJson);
      assert.equal(payload.password_plain, row.password); assert.equal(payload.notes, row.notes);
      assert.equal(payload.email, row.email); assert.equal(payload.phone, row.phone);
      assert.deepEqual(payload.custom_fields.map(field => ({ name: field.title, value: field.value, protected: field.is_protected })), current.customFields);
      assert.ok(current.customFields.find(field => field.name === memberField).value.includes('9007199254740993'));
      if (group.mode === 'cancel') assert.deepEqual(current.customFields, row.customFields);
      else {
        const metadata = JSON.parse(current.customFields.find(field => field.name === memberField).value);
        assert.equal(metadata.passwordOrder, 0); assert.equal(metadata.primary, true);
        assert.ok(current.customFields.some(field => field.name === 'Shared custom' && field.protected && field.value === '  exact protected text\r\n0007 '));
      }
    }
    const owner = group.mode === 'cancel' ? group.original[0] : group.original[2];
    const files = await rpc(page, { type: 'PROVIDER_ATTACHMENT_LIST', providerId: state.providerId, itemId: owner.id });
    const file = files.items.find(row => row.fileName === 'shared.txt'); assert.ok(file);
    const read = await rpc(page, { type: 'PROVIDER_ATTACHMENT_READ_BEGIN', providerId: state.providerId, itemId: owner.id, attachmentId: file.attachmentId });
    try {
      const content = await rpc(page, { type: 'PROVIDER_ATTACHMENT_READ_CHUNK', providerId: state.providerId, readHandle: read.readHandle, offset: 0 });
      assert.equal(hash(Buffer.from(content.dataBase64, 'base64')), hash(attachmentBytes));
    } finally { await rpc(page, { type: 'PROVIDER_ATTACHMENT_READ_RELEASE', providerId: state.providerId, readHandle: read.readHandle }); }
    const ref = group.original[0].providerRefs.find(row => row.providerId === state.providerId);
    const deleted = await rpc(page, { type: 'MDBX2_OBJECT_LIST', providerId: state.providerId, collectionId: ref.remoteFolderId, deleted: true });
    for (const row of group.original.slice(0, 2)) assert.equal(deleted.items.some(item => item.objectId === row.providerRefs.find(ref => ref.providerId === state.providerId).remoteId), group.mode !== 'cancel');
  }
  state.status = 'passed'; state.realBrowserRestartRecovery = true; state.richFieldsAndAttachmentHashes = true;
}

async function unlock(page, state) {
  await rpc(page, { type: 'MDBX2_VAULT_OPEN', input: { providerId: state.providerId, name: state.providerName,
    source: { kind: 'vault', handle: state.vaultHandle }, credential: { method: 'password', password: 'Synthetic transfer fixture password' } } });
}
