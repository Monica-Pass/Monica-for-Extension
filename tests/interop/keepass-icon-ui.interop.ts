import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { openKeePassVault } from '../../src/providers/keepass/keepass-vault';
import { base64ToBytes } from '../../src/security/encoding';
const directory = process.env.MONICA_315_KP_ICON_UI_DIR;
it.skipIf(!directory)('independently decrypts actual Edge exports and verifies native icon bytes and clear', async () => {
  const root = resolve(directory!);
  const fixture = JSON.parse(await readFile(join(root,'native-icon-stages.json'),'utf8')) as {password:string;stages:Array<{name:string;type?:string;value?:string}>};
  const checks: unknown[] = [];
  for (const stage of fixture.stages) {
    const snapshot = await openKeePassVault(new Uint8Array(await readFile(join(root,stage.name+'.kdbx'))),{password:fixture.password,providerId:'independent',databaseId:123});
    const item=snapshot.items.find(item=>item.kind==='login' && item.title==='GitHub');
    expect(item?.kind).toBe('login');if(item?.kind!=='login') throw new Error('Missing login');
    expect(item.password).toBe('old-password');
    expect(item.customIconValue).toBe(stage.value);
    const entry=snapshot.entriesByUuid.get(item.keepassEntryUuid!)!;
    expect(entry.fields.get('External Unknown Field')).toBe('unknown must stay');
    if(stage.value) {
      expect(item.customIconType).toBe('KEEPASS_CUSTOM_ICON');
      const bytes=base64ToBytes(stage.value);
      expect(new DataView(bytes.buffer).getUint32(16)).toBe(128);
      expect(new DataView(bytes.buffer).getUint32(20)).toBe(128);
      expect(new Uint8Array(snapshot.database.meta.customIcons.get(entry.customIcon!.toString())!.data)).toEqual(bytes);
    } else {
      expect(entry.customIcon).toBeUndefined();
      expect(entry.history.some(item=>Boolean(item.customIcon))).toBe(true);
      expect(snapshot.database.meta.customIcons.size).toBeGreaterThan(0);
    }
    checks.push({stage:stage.name,status:'passed',passwordUnchanged:true,unknownFieldPreserved:true});
  }
  await writeFile(join(root,'native-icon-readback.json'),JSON.stringify({status:'passed',checks},null,2));
});
