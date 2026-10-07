import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { launchEdgeContext } from './fixtures/edge';

test('actual Edge recovery storage retains authenticated snapshots across abort, concurrent retry and restart', async ({}, info) => {
  test.setTimeout(90_000);
  const helper = info.outputPath('recovery.js');
  await build({ stdin: { contents: "export * from './src/providers/keepass/keepass-conflict-recovery'; export * from './src/providers/keepass/keepass-conflict-recovery-store';", resolveDir: process.cwd() },
    outfile: helper, bundle: true, platform: 'browser', format: 'iife', globalName: 'Recovery', logLevel: 'silent' });
  const server = createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Isolated recovery storage test</title>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing local server');
  const url = `http://127.0.0.1:${address.port}`;
  let context: Awaited<ReturnType<typeof launchEdgeContext>> | undefined;
  const source = { id: 'synthetic-provider', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
    config: { cacheEncryptionKey: Buffer.alloc(32, 7).toString('base64'), databasePassword: 'Synthetic source password' } };
  const evidence: Record<string, unknown> = { status: 'failed', actualIndexedDb: true, actualExtensionWorkflow: false };
  try {
    context = await launchEdgeContext(info.outputPath('profile'));
    let page = await context.newPage(); await page.goto(url); await page.addScriptTag({ path: helper });
    const first = await page.evaluate(async source => {
      const api = (window as any).Recovery as typeof import('../../src/providers/keepass/keepass-conflict-recovery') & typeof import('../../src/providers/keepass/keepass-conflict-recovery-store');
      const storage = new api.IndexedDbKeePassConflictRecoveryStorage('synthetic-recovery-test');
      const bytes = Uint8Array.of(1, 3, 5);
      const input = { source: source as any, operationId: 'committed', createdAt: '2026-10-06T00:00:00Z', reviewToken: 'a'.repeat(64),
        choices: [{ projectId: 'project', choice: 'local' as const }], files: { base: bytes, working: bytes, remote: bytes, resolved: bytes } };
      const sealed = await api.sealKeePassConflictRecovery(source as any, input);
      const retry = await api.sealKeePassConflictRecovery(source as any, input);
      const rows = await Promise.all([storage.create(sealed), storage.create(retry)]);
      const sameCipher = rows[0].files.base.ciphertext.every((byte, index) => byte === rows[1].files.base.ciphertext[index]);
      const abort = await api.sealKeePassConflictRecovery(source as any, { ...input, operationId: 'aborted' });
      const originalAdd = IDBObjectStore.prototype.add;
      let failed = false;
      IDBObjectStore.prototype.add = function(value, key) {
        if (this.transaction.db.name === 'synthetic-recovery-test') { this.transaction.abort(); throw new Error('Synthetic transaction abort'); }
        return key === undefined ? originalAdd.call(this, value) : originalAdd.call(this, value, key);
      };
      try { await storage.create(abort); } catch { failed = true; } finally { IDBObjectStore.prototype.add = originalAdd; }
      const absent = await storage.read(source.id, 'aborted');
      const changed = await api.sealKeePassConflictRecovery(source as any, { ...input, choices: [{ projectId: 'project', choice: 'remote' }] });
      let reuseRejected = false; try { await storage.create(changed); } catch { reuseRejected = true; }
      return { sameCipher, aborted: failed && absent === undefined, reuseRejected, summaries: await storage.list(source.id), intentTag: sealed.intentTag };
    }, source);
    expect(first.sameCipher).toBe(true); expect(first.aborted).toBe(true); expect(first.reuseRejected).toBe(true); expect(first.summaries).toHaveLength(1);
    await context.close(); context = await launchEdgeContext(info.outputPath('profile'));
    page = await context.newPage(); await page.goto(url); await page.addScriptTag({ path: helper });
    const restored = await page.evaluate(async source => {
      const api = (window as any).Recovery as typeof import('../../src/providers/keepass/keepass-conflict-recovery') & typeof import('../../src/providers/keepass/keepass-conflict-recovery-store');
      const storage = new api.IndexedDbKeePassConflictRecoveryStorage('synthetic-recovery-test');
      const encrypted = (await storage.read(source.id, 'committed'))!;
      const opened = await api.openKeePassConflictRecovery(source as any, encrypted);
      return { tag: encrypted.intentTag, files: Object.values(opened.files).map(bytes => [...bytes]),
        source: opened.source, count: (await storage.list(source.id)).length,
        abortedAbsent: await storage.read(source.id, 'aborted') === undefined };
    }, source);
    expect(restored.tag).toBe(first.intentTag); expect(restored.files).toEqual(Array.from({ length: 4 }, () => [1, 3, 5]));
    expect(restored.source).toEqual(source); expect(restored.count).toBe(1); expect(restored.abortedAbsent).toBe(true);
    const cleanup = await page.evaluate(async source => {
      const api = (window as any).Recovery as typeof import('../../src/providers/keepass/keepass-conflict-recovery') & typeof import('../../src/providers/keepass/keepass-conflict-recovery-store');
      const storage = new api.IndexedDbKeePassConflictRecoveryStorage('synthetic-recovery-test');
      const encrypted = (await storage.read(source.id, 'committed'))!;
      const input = await api.openKeePassConflictRecovery(source as any, encrypted);
      for (let i = 0; i < 7; i++) await storage.create(await api.sealKeePassConflictRecovery(source as any, { ...input, operationId: `spare-${i}` }));
      const ninth = await api.sealKeePassConflictRecovery(source as any, { ...input, operationId: 'ninth' });
      let full = false, stale = false, aborted = false;
      try { await storage.create(ninth); } catch { full = true; }
      try { await storage.delete(source.id, 'committed', 'f'.repeat(64)); } catch { stale = true; }
      const remove = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function(key) {
        if (this.transaction.db.name === 'synthetic-recovery-test') { this.transaction.abort(); throw new Error('Synthetic delete abort'); }
        return remove.call(this, key);
      };
      try { await storage.delete(source.id, 'committed', encrypted.intentTag); } catch { aborted = true; }
      finally { IDBObjectStore.prototype.delete = remove; }
      const retainedAfterAbort = (await storage.read(source.id, 'committed'))!.intentTag === encrypted.intentTag;
      // Deletion must inspect only indexed metadata, without loading four large blobs.
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function(key) {
        if (this.transaction.db.name === 'synthetic-recovery-test') throw new Error('Unexpected blob read during deletion');
        return get.call(this, key);
      };
      let results;
      try { results = await Promise.all([storage.delete(source.id, 'committed', encrypted.intentTag), storage.delete(source.id, 'committed', encrypted.intentTag)]); }
      finally { IDBObjectStore.prototype.get = get; }
      await storage.create(ninth);
      return { full, stale, aborted, retainedAfterAbort, results, count: (await storage.list(source.id)).length };
    }, source);
    expect(cleanup).toEqual({ full: true, stale: true, aborted: true, retainedAfterAbort: true, results: [true, false], count: 8 });
    await context.close(); context = await launchEdgeContext(info.outputPath('profile'));
    page = await context.newPage(); await page.goto(url); await page.addScriptTag({ path: helper });
    expect(await page.evaluate(async providerId => {
      const storage = new (window as any).Recovery.IndexedDbKeePassConflictRecoveryStorage('synthetic-recovery-test');
      return { deleted: await storage.read(providerId, 'committed') === undefined, count: (await storage.list(providerId)).length,
        replacement: !!await storage.read(providerId, 'ninth') };
    }, source.id)).toEqual({ deleted: true, count: 8, replacement: true });
    evidence.atomicDeletionAndCapacityAfterRestart = true;
    evidence.status = 'passed'; evidence.concurrentIdempotency = true; evidence.abortedTransactionAbsent = true; evidence.fullRestartDecryption = true;
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
