import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { groupedPasswords } from '../../src/core/password-groups';
import { reconcileProjectCredentialEdits } from '../../src/core/project-credential-edits';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential, rebaseProjectCredentialFields } from '../../src/core/project-credentials';
import type { LoginItem } from '../../src/core/model';
import type { LoginForm } from '../../src/manager/login-form';
import { addProjectCredentialPassword, addProjectCredentialGroup, moveProjectCredentialPassword, updateProjectContentFields, projectCredentialFormGroups, setProjectCredentialFormValue, setProjectCredentialGroupLabel } from '../../src/manager/project-credential-form';
import { withContentOrder } from '../../src/core/password-content';
import { createProjectPassword } from '../../src/manager/project-password-create';
import { decryptAndroidBackup, encryptAndroidBackup } from '../../src/providers/webdav/android-backup-crypto';
import { readAndroidBackup, writeAndroidBackup } from '../../src/providers/webdav/android-backup-codec';

const directory = process.env.MONICA_315_APP_FIXTURE;
if (!directory) throw new Error('MONICA_315_APP_FIXTURE must name an actual Android project-credential export directory');
const root = resolve(directory);
const stage = process.env.MONICA_PROJECT_CREDENTIAL_STAGE || 'forward';
if (!['forward', 'return'].includes(stage)) throw new Error('Choose forward or return');
const archivePassword = 'synthetic archive password';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const metadata = (item: LoginItem) => readProjectCredential(item.customFields)!;
const ordered = (items: LoginItem[]) => groupedPasswords(items).flat();
const snapshot = (item: LoginItem) => ({ title: item.title, username: item.username, password: item.password,
  otp: item.totpSecret ?? '', projectId: item.passwordGroupId, metadata: metadata(item),
  notes: item.notes, email: item.email, phone: item.phone, appName: item.appName, appPackageName: item.appPackageName,
  addressLine: item.addressLine, city: item.city, state: item.state, zipCode: item.zipCode, country: item.country,
  creditCardNumber: item.creditCardNumber, creditCardHolder: item.creditCardHolder, creditCardExpiry: item.creditCardExpiry,
  creditCardCVV: item.creditCardCVV, uris: item.uris, customFields: item.customFields });
const load = async (name: string) => JSON.parse(await readFile(join(root, name), 'utf8'));

it(`actual Android project credentials ${stage}`, async () => {
  const input = stage === 'forward' ? 'android-project-credentials.zip' : 'android-project-credentials-return.zip';
  const bytes = await readFile(join(root, input));
  const report: Record<string, unknown> = { status: 'failed', stage, inputSha256: hash(bytes),
    layer: 'Actual Android application archives, extension editor helpers and ZIP codec; no browser or Android screen interaction' };
  try {
    const device = await load(`project-credentials-${stage === 'forward' ? 'export' : 'import'}-evidence.json`);
    const build = await load('build-evidence.json');
    expect(device.status).toBe('passed');
    expect(build.status).toBe('passed');
    expect(build.androidSourcesUnchanged).toBe(true);
    expect(build.testSourcesUnchanged).toBe(true);
    expect(device.installedTestApkSha256).toBe(build.builtTestApkSha256);
    expect(device.baseline).toEqual(build.baseline);
    expect(device.testSourceHashes).toEqual(build.testSourceHashes);
    for (const invariant of ['installedApplicationUnchanged', 'installedTestApkUnchanged', 'androidSourcesUnchanged', 'testSourcesUnchanged', 'deviceBootUnchanged'])
      expect(device[invariant], invariant).toBe(true);
    expect(device.androidVersion).toMatch(/^1\.0\.317-/);
    expect(device.outputs.find((output: { name: string }) => output.name === input)?.sha256).toBe(hash(bytes));
    Object.assign(report, { androidVersion: device.androidVersion, installedApkSha256: device.installedApkSha256,
      installedTestApkSha256: device.installedTestApkSha256, baseline: device.baseline });
    const providerId = 'android-project-credentials';
    const document = readAndroidBackup(await decryptAndroidBackup(bytes, archivePassword), providerId);
    const items = ordered(document.items.filter((item): item is LoginItem => item.kind === 'login'));
    expect(items).toHaveLength(document.items.length);
    for (const item of items) {
      expect(metadata(item)).toBeDefined();
      expect(metadata(item).projectId).toBe(item.passwordGroupId);
    }
    if (stage === 'forward') {
      expect(items).toHaveLength(3);
      expect(groupedPasswords(items)).toHaveLength(1);
      expect(items.map(item => item.password)).toEqual(['first-password', 'second-password', 'recovery-password']);
      const [anchor, ...members] = items;
      const form = { username: anchor.username, password: anchor.password, totpSecret: anchor.totpSecret ?? '',
        passwordGroupId: anchor.passwordGroupId, customFields: structuredClone(anchor.customFields),
        groupMembers: members.map(original => ({ id: original.id, username: original.username, password: original.password, original })) } as LoginForm;
      const before = JSON.stringify(items);
      const groups = projectCredentialFormGroups(form)!;
      expect(groups.map(group => group.rows.length)).toEqual([2, 1]);
      expect(groups.map(group => group.label)).toEqual(['工作账号', '恢复账号']);
      const indexes = groups[0].rows.map(row => row.index);
      setProjectCredentialFormValue(form, indexes, 'username', 'browser-user');
      setProjectCredentialFormValue(form, indexes, 'totpSecret', '');
      setProjectCredentialGroupLabel(form, groups[0].id, 'Browser account');
      const added = addProjectCredentialPassword(form, groups[0].id);
      form.groupMembers.find(row => row.id === added)!.password = 'browser-added-password';
      const extraId = addProjectCredentialGroup(form);
      setProjectCredentialGroupLabel(form, extraId, 'Third account');
      const extra = projectCredentialFormGroups(form)!.find(group => group.id === extraId)!;
      setProjectCredentialFormValue(form, extra.rows.map(row => row.index), 'username', 'third-user');
      setProjectCredentialFormValue(form, extra.rows.map(row => row.index), 'password', 'third-password');
      moveProjectCredentialPassword(form, groups[0].id, groups[0].rows[0].metadata!.passwordId, groups[0].rows[1].metadata!.passwordId, true);
      updateProjectContentFields(form, withContentOrder(form.customFields, [`CREDENTIAL:${extraId}`, 'NOTES', `CREDENTIAL:${groups[1].id}`]));
      const editedAnchor = { ...anchor, title: 'Credential project edited', username: form.username,
        password: form.password, totpSecret: form.totpSecret, customFields: form.customFields,
        notes: '  Browser shared note\r\n\t合成项目  ', email: '', phone: '  +86 001  ',
        appName: '合成服务', appPackageName: 'invalid.synthetic.project', addressLine: '  街道\r\n第二行  ',
        city: '上海', state: '  Province  ', zipCode: '00007', country: 'CN',
        creditCardNumber: '4111111111111111', creditCardHolder: '  Synthetic Holder  ', creditCardExpiry: '03/29', creditCardCVV: '007',
        uris: ['https://project.example.invalid/login'] };
      const edited = reconcileProjectCredentialEdits([editedAnchor, ...form.groupMembers.map(member => member.original
        ? { ...member.original, username: member.username, password: member.password,
            totpSecret: member.totpSecret ?? member.original.totpSecret, customFields: member.customFields ?? member.original.customFields }
        : createProjectPassword(editedAnchor, member))], items);
      expect(edited.every(item => item.title === editedAnchor.title && item.notes === editedAnchor.notes
        && item.email === '' && item.creditCardCVV === '007' && item.addressLine === editedAnchor.addressLine)).toBe(true);
      expect(JSON.stringify(items)).toBe(before);
      const projectId = randomUUID();
      const copies = edited.map(item => ({ ...item, id: randomUUID(), replicaGroupId: undefined,
        providerRefs: [{ providerId }], passwordGroupId: projectId, title: 'Credential project copy',
        customFields: rebaseProjectCredentialFields(item.customFields, projectId) }));
      const plain = writeAndroidBackup(document, [...edited, ...copies], providerId);
      const check = readAndroidBackup(plain, providerId);
      const reopened = ordered(check.items as LoginItem[]);
      expect(groupedPasswords(reopened).map(group => group.length)).toEqual([5, 5]);
      for (const original of items) {
        const updated = edited.find(item => item.id === original.id)!;
        expect(metadata(updated).passwordId).toBe(metadata(original).passwordId);
        expect(metadata(updated).groupId).toBe(metadata(original).groupId);
        expect(updated.customFields.find(field => field.name === PROJECT_CREDENTIAL_FIELD)!.value).toContain('9007199254740993');
      }
      const output = await encryptAndroidBackup(plain, archivePassword);
      await writeFile(join(root, 'extension-project-credentials.zip'), output);
      await writeFile(join(root, 'project-credentials-expected.json'), JSON.stringify(reopened.map(snapshot), null, 2));
      report.outputSha256 = hash(output);
      report.checks = ['Actual Android three-row two-group seed', 'Editor shared account/OTP clear/label edit',
        'New password and third credential group', 'Password and extra-group content order', 'Independent project copy retaining credential IDs', 'Unknown large integer preserved', 'Ten-row ZIP reopen'];
    } else {
      const forward = await load('project-credentials-forward-codec-evidence.json');
      const expected = await load('project-credentials-expected.json') as ReturnType<typeof snapshot>[];
      const android = await load('android-project-credentials-return.json');
      expect(forward.status).toBe('passed'); expect(android.status).toBe('passed');
      expect(device.installedApkSha256).toBe(forward.installedApkSha256);
      expect(device.installedTestApkSha256).toBe(forward.installedTestApkSha256);
      expect(device.baseline).toEqual(forward.baseline);
      expect(device.inputs.find((input: { name: string }) => input.name === 'extension-project-credentials.zip')?.sha256).toBe(forward.outputSha256);
      expect(items).toHaveLength(10);
      expect(groupedPasswords(items).map(group => group.length)).toEqual([5, 5]);
      for (const previous of expected) {
        const item = items.find(item => item.title === previous.title && metadata(item).passwordId === previous.metadata.passwordId)!;
        expect(item).toBeDefined();
        const changed = previous.title === 'Credential project edited' && previous.metadata.groupOrder === 0;
        const wanted = { ...previous, username: changed ? 'android-user' : previous.username,
          password: changed && previous.metadata.passwordOrder === 2 ? 'android-final-password' : previous.password,
          metadata: { ...previous.metadata, label: changed ? 'Android returned' : previous.metadata.label } };
        const actual = snapshot(item);
        expect({ ...actual, customFields: undefined }).toEqual({ ...wanted, customFields: undefined });
        expect(item.customFields.filter(field => field.name !== PROJECT_CREDENTIAL_FIELD))
          .toEqual(previous.customFields.filter(field => field.name !== PROJECT_CREDENTIAL_FIELD));
        const oldCarrier = previous.customFields.find(field => field.name === PROJECT_CREDENTIAL_FIELD)!;
        const carrier = item.customFields.find(field => field.name === PROJECT_CREDENTIAL_FIELD)!;
        expect(carrier.protected).toBe(oldCarrier.protected);
        if (oldCarrier.value.includes('9007199254740993')) expect(carrier.value).toContain('9007199254740993');
      }
      const reopened = readAndroidBackup(writeAndroidBackup(document, items, providerId), providerId);
      expect(ordered(reopened.items as LoginItem[]).map(snapshot)).toEqual(items.map(snapshot));
      await writeFile(join(root, 'project-credentials-edge-return.json'), JSON.stringify({ synthetic: true,
        archiveSha256: hash(bytes), androidVersion: device.androidVersion,
        items: items.map(item => ({ ...item, providerRefs: [] })) }, null, 2));
      report.checks = ['Actual Android import/reopen of two independent projects', 'Android edits only original first group',
        'All project/group/password identities retained', 'Copied project unchanged', 'Unknown integer/protection/shared data retained', 'Final extension reopen'];
    }
    report.status = 'passed';
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    await writeFile(join(root, `project-credentials-${stage}-codec-evidence.json`), JSON.stringify(report, null, 2));
  }
});
