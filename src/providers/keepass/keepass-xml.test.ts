import { expect, it, vi } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import { JSDOM } from 'jsdom';
import { installKdbxCryptoEngine } from './keepass-crypto';
import { buildKeePassFixture } from './keepass-fixture';
import { KeePassProvider } from './keepass-provider';
import type { LoginItem, ProviderAccount } from '../../core/model';

const account: ProviderAccount = { id:'plain-xml', kind:'keepass', name:'XML', enabled:true, isDefaultSaveTarget:false, config:{databaseId:91} };
const password='synthetic plaintext XML';

it.each([false, true])('uses strict error handling and exact text with native DOMParser=%s', native => {
  const window = native ? new JSDOM('').window : undefined;
  vi.stubGlobal('DOMParser', window?.DOMParser);
  try {
    installKdbxCryptoEngine();
    const document=kdbxweb.XmlUtils.parse('<Value><![CDATA[private\ttext]]>&#13;&#10;&amp;</Value>');
    expect(document.documentElement.textContent).toBe('private\ttext\r\n&');
    expect(kdbxweb.XmlUtils.parse('<Value><![CDATA[<!DOCTYPE literal>]]></Value>').documentElement.textContent).toBe('<!DOCTYPE literal>');
    const empty=kdbxweb.XmlUtils.parse('<String><Key>Hidden</Key><Value Protected="True"/></String>').getElementsByTagName('Value')[0];
    expect(kdbxweb.XmlUtils.getProtectedText(empty)).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect((kdbxweb.XmlUtils.getProtectedText(empty) as kdbxweb.ProtectedValue).getText()).toBe('');
    for (const xml of ['<Value>synthetic-secret', '<Value>synthetic-secret</Wrong>', '<Value>&missing;</Value>', '<Value>synthetic-secret</Value><extra/>', '<!DOCTYPE Value><Value>text</Value>', '<!DOCTYPE Value [<!ENTITY text "synthetic-secret">]><Value>&text;</Value>']) {
      try { kdbxweb.XmlUtils.parse(xml); throw new Error('Expected rejection'); }
      catch (error) {
        expect(error).toBeInstanceOf(kdbxweb.KdbxError);
        expect(String(error)).not.toContain('synthetic-secret');
      }
    }
  } finally { vi.unstubAllGlobals(); window?.close(); }
});

it.each([
  ['literal tab', '<Value>before\tafter</Value>', 'before\tafter'],
  ['CDATA', '<Value><![CDATA[before\tafter & <literal>]]></Value>', 'before\tafter & <literal>'],
  ['character references', '<Value>&#9;before&#13;&#10;after&#x9;</Value>', '\tbefore\r\nafter\t'],
  ['standard XML newline normalization', '<Value>before\r\nafter\rnext</Value>', 'before\nafter\nnext'],
  ['non-ASCII content', '<Value>中文\t🔑\n  text  </Value>', '中文\t🔑\n  text  ']
])('preserves %s through the actual configured KDBX XML parser', (_name, xml, expected) => {
  installKdbxCryptoEngine();
  expect(kdbxweb.XmlUtils.parse(xml).documentElement.textContent).toBe(expected);
});

it.each(['\u0000','\u0001','\u0008','\u000b','\u000c','\u001f'])('rejects invalid XML control %j instead of silently changing a secret', value => {
  installKdbxCryptoEngine();
  expect(() => kdbxweb.XmlUtils.parse(`<Value>synthetic-secret${value}tail</Value>`)).toThrow();
});

it.each([3,4] as const)('imports plain tabs in encrypted KDBX %s and retains them across rename/export/reconnect', async version => {
  const text=' \tAndroid plain value\nsecond line\t ';
  const bytes=await buildKeePassFixture({password,version,entries:[{title:'Plain SSH',fields:{
    MonicaLoginType:'SSH_KEY',MonicaSshAlgorithm:'RSA',MonicaSshPublicKey:'ssh-rsa\tpublic',
    MonicaSshComment:text,Email:text,Notes:text,'Future\tfield':text
  },protectedFields:{MonicaSshPrivateKey:'private\r\nkey'}}]});
  const provider=new KeePassProvider();
  await provider.unlock(account,bytes,{password});
  const initial=(await provider.sync(account,{now:new Date().toISOString(),localItems:[]})).items[0] as LoginItem;
  expect(initial.email).toBe(text);expect(initial.notes).toBe(text);
  expect(initial.customFields).toContainEqual({name:'Future\tfield',value:text,protected:false});
  expect(JSON.parse(initial.sshKeyData!)).toMatchObject({publicKeyOpenSsh:'ssh-rsa\tpublic',privateKeyOpenSsh:'private\r\nkey',comment:text});
  await provider.update(account,{...initial,title:'Renamed'});
  const exported=await provider.exportFile(account.id);provider.lock();
  const reconnected=new KeePassProvider();
  const other={...account,id:'other-xml'};
  await reconnected.unlock(other,exported,{password});
  const item=(await reconnected.sync(other,{now:new Date().toISOString(),localItems:[]})).items[0] as LoginItem;
  expect(item.email).toBe(text);expect(item.notes).toBe(text);
  expect(item.sshKeyData).toBe(initial.sshKeyData);
  expect(item.customFields).toContainEqual({name:'Future\tfield',value:text,protected:true});
  reconnected.lock();
});

it('keeps an unlocked vault and its fields when a replacement file contains invalid plain XML controls', async () => {
  const valid=await buildKeePassFixture({password,entries:[{title:'Keep',fields:{Notes:'unchanged'}}]});
  const corrupt=await buildKeePassFixture({password,entries:[{title:'Reject',fields:{Notes:'synthetic-secret\u0001tail'}}]});
  const originalBytes=corrupt.slice();
  const provider=new KeePassProvider();await provider.unlock(account,valid,{password});
  const before=(await provider.sync(account,{now:new Date().toISOString(),localItems:[]})).items;
  await expect(provider.unlock(account,corrupt,{password})).rejects.toThrow();
  expect((await provider.sync(account,{now:new Date().toISOString(),localItems:[]})).items).toEqual(before);
  expect(corrupt).toEqual(originalBytes);
  provider.lock();
});
