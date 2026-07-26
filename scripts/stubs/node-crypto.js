/**
 * kdbxweb ships as a UMD bundle whose wrapper statically requires Node's `crypto`, which no browser
 * bundler can resolve. At runtime it only reaches for it when `globalThis.crypto.subtle` is missing
 * (`kdbxweb.js:166`), and WebCrypto exists in both the MV3 service worker and the extension pages, so
 * the require is satisfied with this stub instead of a Node polyfill.
 *
 * Every export throws rather than returning a stand-in: if a future kdbxweb release starts taking the
 * Node path, that must surface as a loud failure instead of a silently weaker digest.
 */
function unavailable() {
  throw new Error("浏览器环境不提供 Node crypto，KDBX 加密应通过 WebCrypto 完成。");
}

export const createHash = unavailable;
export const createHmac = unavailable;
export const createCipheriv = unavailable;
export const createDecipheriv = unavailable;
export const randomBytes = unavailable;

export default { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes };
