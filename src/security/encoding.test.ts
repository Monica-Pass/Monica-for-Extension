import { afterEach, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './encoding';

const encodingDescriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64');
const decodingDescriptor = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
afterEach(() => {
  if (encodingDescriptor) Object.defineProperty(Uint8Array.prototype, 'toBase64', encodingDescriptor);
  else delete (Uint8Array.prototype as any).toBase64;
  if (decodingDescriptor) Object.defineProperty(Uint8Array, 'fromBase64', decodingDescriptor);
  else delete (Uint8Array as any).fromBase64;
});

function fallback() {
  Object.defineProperty(Uint8Array.prototype, 'toBase64', { value: undefined, configurable: true });
  Object.defineProperty(Uint8Array, 'fromBase64', { value: undefined, configurable: true });
}
function decodeLegacy(value: string) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }

it('fallback preserves empty, binary, chunk-boundary and subarray encoding', () => {
  fallback();
  for (const length of [0, 1, 2, 3, 255, 32767, 32768, 32769, 100003]) {
    const storage = Uint8Array.from({ length: length + 6 }, (_, index) => index % 256);
    const bytes = storage.subarray(3, length + 3);
    const encoded = bytesToBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    expect(base64ToBytes(encoded)).toEqual(bytes);
  }
});

it('fallback preserves forgiving whitespace, omitted padding and invalid input rejection', () => {
  fallback();
  for (const value of ['', 'Zg', 'Zh==', 'Zm8', 'Zm9v', ' Z\tg\n=\r=\f', 'AA', 'AAA'])
    expect(base64ToBytes(value)).toEqual(decodeLegacy(value));
  for (const value of ['A', '=', 'Zg=', 'Zg===', 'Zm9v=', 'AA=A', 'AA-_', 'AA\v', 'AA\u00a0'])
    expect(() => base64ToBytes(value)).toThrow();
});

it('uses available typed-array APIs and passes the exact view', () => {
  let encodes = 0, decodes = 0;
  Object.defineProperty(Uint8Array.prototype, 'toBase64', { configurable: true, value: function(this: Uint8Array) {
    encodes++; return Buffer.from(this).toString('base64');
  } });
  Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, value: (value: string) => { decodes++; return decodeLegacy(value); } });
  const bytes = Uint8Array.of(99, 0, 255, 22).subarray(1, 3);
  expect(bytesToBase64(bytes)).toBe('AP8='); expect(base64ToBytes('AP8=')).toEqual(bytes);
  expect(encodes).toBe(1); expect(decodes).toBe(1);
});

it('native decoding failure preserves legacy success and DOMException rejection', () => {
  Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, value: () => { throw new SyntaxError('native rejection'); } });
  expect(base64ToBytes('Zg')).toEqual(Uint8Array.of(102));
  expect(() => base64ToBytes('A')).toThrow(DOMException);
});
