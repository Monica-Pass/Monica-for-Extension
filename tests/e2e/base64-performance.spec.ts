import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import { launchEdgeContext } from './fixtures/edge';

test('production Base64 native and legacy branches agree in installed Edge', async ({}, info) => {
  const context = await launchEdgeContext(info.outputPath('profile'));
  try {
    const page = await context.newPage();
    const bundle = buildSync({ entryPoints: ['src/security/encoding.ts'], bundle: true, platform: 'browser', format: 'iife', globalName: 'taskEncoding', write: false });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(() => {
      const functions = (window as any).taskEncoding;
      const nativeEncode = (Uint8Array.prototype as any).toBase64;
      const nativeDecode = (Uint8Array as any).fromBase64;
      if (!nativeEncode || !nativeDecode) throw new Error('Installed Edge must expose native typed-array Base64 for this comparison');
      const native = (enabled: boolean) => {
        (Uint8Array.prototype as any).toBase64 = enabled ? nativeEncode : undefined;
        (Uint8Array as any).fromBase64 = enabled ? nativeDecode : undefined;
      };
      const read = (value: string) => {
        try { return { bytes: [...functions.base64ToBytes(value)] }; }
        catch (error) { return { error: (error as Error).name }; }
      };
      let checks = 0;
      const equal = (left: unknown, right: unknown) => { checks++; if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error('Base64 branch mismatch'); };
      const corpus = ['', 'Zg', 'Zh==', 'Zm8', 'Zm9v', ' Z\tg\n=\r=\f', 'A', '=', 'Zg=', 'Zg===', 'Zm9v=', 'AA=A', 'AA-_', 'AA\v', 'AA\u00a0'];
      const alphabet = 'Aa0+/= \t\n\r\f\v_-!\u00a0';
      // Deterministic malformed-input corpus; compare acceptance and bytes.
      let seed = 77;
      for (let index = 0; index < 10000; index++) {
        let value = '';
        for (let i = 0; i < index % 17; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; value += alphabet[seed % alphabet.length]; }
        corpus.push(value);
      }
      try {
        for (const value of corpus) { native(true); const a = read(value); native(false); equal(a, read(value)); }
        for (const length of [0, 1, 2, 3, 255, 32767, 32768, 32769, 100003]) {
          const bytes = Uint8Array.from({ length: length + 7 }, (_, i) => i % 256).subarray(3, length + 3);
          native(true); const a = functions.bytesToBase64(bytes);
          native(false); equal(a, functions.bytesToBase64(bytes));
        }
        const bytes = Uint8Array.from({ length: 10 * 1024 * 1024 }, (_, i) => i % 256);
        const measure = (enabled: boolean) => {
          native(enabled); const start = performance.now(), encoded = functions.bytesToBase64(bytes), encodedAt = performance.now();
          const decoded: Uint8Array = functions.base64ToBytes(encoded), end = performance.now();
          if (decoded.length !== bytes.length || decoded.some((value, index) => value !== bytes[index])) throw new Error('Binary mismatch');
          return { encodeMs: encodedAt - start, decodeMs: end - encodedAt, encodedLength: encoded.length };
        };
        return { checks, native: measure(true), fallback: measure(false), userAgent: navigator.userAgent };
      } finally { native(true); }
    });
    expect(result.checks).toBe(10024);
    expect(result.native.encodedLength).toBe(result.fallback.encodedLength);
    await writeFile(info.outputPath('base64-comparison.json'), JSON.stringify(result, null, 2));
    await info.attach('base64-comparison', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  } finally { await context.close(); }
});
