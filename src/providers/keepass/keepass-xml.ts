import * as kdbxweb from 'kdbxweb';
import { DOMParser as FallbackDOMParser } from '@xmldom/xmldom';

const kdbxRuntime = (kdbxweb as unknown as { default?: typeof kdbxweb }).default ?? kdbxweb;

/**
 * kdbxweb 2.1.1 strips U+0009 before parsing, although XML 1.0 permits tabs.
 * Use the same parsers without that lossy sanitizer. Invalid XML is rejected;
 * its contents must not appear in errors because this document holds secrets.
 */
export function parseKeePassXml(xml: string): Document {
  const invalid = () => new kdbxRuntime.KdbxError(kdbxRuntime.Consts.ErrorCodes.FileCorrupt, 'bad xml');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)) throw invalid();
  try {
    const fail = () => { throw invalid(); };
    const parser = globalThis.DOMParser ? new globalThis.DOMParser() : new FallbackDOMParser({
      errorHandler: { warning: fail, error: fail, fatalError: fail }
    });
    const document = parser.parseFromString(xml, 'application/xml');
    if (!document.documentElement || document.doctype || document.getElementsByTagName('parsererror').length) throw invalid();
    // kdbxweb skips zero-byte protected strings when applying the inner stream.
    // Empty values consume no stream bytes, but still need their protection
    // marker so clearing a hidden field does not change its display setting.
    for (const value of Array.from(document.getElementsByTagName('Value'))) {
      if (value.parentNode?.nodeName === 'String' && value.getAttribute('Protected')?.toLowerCase() === 'true' && !value.textContent) {
        value.protectedValue = kdbxRuntime.ProtectedValue.fromString('');
      }
    }
    return document;
  } catch {
    throw invalid();
  }
}

/** Install once with the pinned KDBX runtime, for encrypted files and XML imports. */
export function installKdbxXmlParser(): void {
  Object.assign(kdbxRuntime.XmlUtils, { parse: parseKeePassXml });
}
