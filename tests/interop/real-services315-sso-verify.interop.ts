import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { BitwardenProvider } from '../../src/providers/bitwarden/bitwarden-provider';
import { KeePassWebDavClient } from '../../src/providers/keepass/keepass-webdav-client';
import { KeePassProvider } from '../../src/providers/keepass/keepass-provider';
import type { LoginItem, ProviderAccount, VaultItem } from '../../src/core/model';

const path = process.env.MONICA_315_SSO_VERIFY_FIXTURES;
const checks: unknown[] = [];
afterAll(async () => {
  if (path) await writeFile(join(dirname(path), 'edge-readback.json'), JSON.stringify({ layer: 'independent actual service read after Edge UI', checks }, null, 2));
});
describe.skipIf(!path)('SSO Edge writes independently read from actual services', () => {
  it.each(['keepass', 'vaultwarden'])('reads the final %s unlink and unchanged target account', async backend => {
    try {
      const fixture = JSON.parse(await readFile(path!, 'utf8'))[backend];
      expect(new URL(fixture.baseUrl).hostname).toBe('127.0.0.1');
      let items: VaultItem[];
      const base = { id: `independent-${backend}`, name: 'Independent SSO readback', enabled: true, isDefaultSaveTarget: false };
      if (backend === 'keepass') {
        const remote = await new KeePassWebDavClient(fixture).read();
        const provider = new KeePassProvider();
        const account: ProviderAccount = { ...base, kind: 'keepass', config: { sourceMode: 'webdav', databaseId: 891 } };
        await provider.unlock(account, remote.bytes, { password: fixture.databasePassword, sourceMode: 'webdav' });
        items = (await provider.sync(account, { now: new Date().toISOString(), localItems: [] })).items;
      } else {
        const login = await new BitwardenClient().login({ vaultUrl: fixture.baseUrl, email: fixture.email, masterPassword: fixture.password, deviceId: randomUUID() });
        if (login.status !== 'authenticated') throw new Error('Independent synthetic login failed');
        items = (await new BitwardenProvider().sync({ ...base, kind: 'bitwarden', config: login.session }, { now: new Date().toISOString(), localItems: [] })).items;
      }
      const sites = items.filter(item => item.title === `Edge SSO ${backend}`);
      expect(sites).toHaveLength(1);
      const site = sites[0] as LoginItem;
      expect(site.loginType).toBe('SSO');
      expect(site.ssoProvider).toBe('OKTA');
      expect(site.ssoRefLogicalId).toBeUndefined();
      expect(site.ssoRefEntryId).toBeUndefined();
      const account = items.find(item => item.title === 'Account') as LoginItem;
      expect(account.password).toBe('synthetic');
      checks.push({ backend, status: 'passed', remoteId: site.providerRefs[0].remoteId, unlink: true, accountUnchanged: true });
    } catch (error) { checks.push({ backend, status: 'failed', error: String(error) }); throw error; }
  });
});
