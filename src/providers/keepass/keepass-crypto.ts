import * as kdbxweb from "kdbxweb";
import { argon2d, argon2i, argon2id } from "hash-wasm";

/**
 * kdbxweb has no Argon2 of its own — it requires the host to inject one (`CryptoEngine.setArgon2Impl`).
 * The project already ships `hash-wasm` for the local vault KDF and for Bitwarden, so KDBX reuses it
 * rather than adding a second Argon2 implementation.
 *
 * Everything else kdbxweb needs (AES-KDF, HMAC, SHA-2, ChaCha20) it resolves through WebCrypto, which
 * exists in both the service worker and extension pages.
 */

/** kdbxweb passes KeePass's own type ids: 0 = Argon2d, 1 = Argon2i, 2 = Argon2id. */
const ARGON2_VARIANTS = [argon2d, argon2i, argon2id];

let installed = false;

export function installKdbxCryptoEngine(): void {
  if (installed) return;
  installed = true;
  kdbxweb.CryptoEngine.setArgon2Impl(
    async (password, salt, memory, iterations, length, parallelism, type, version) => {
      const hash = ARGON2_VARIANTS[type] ?? argon2d;
      const digest = await hash({
        password: new Uint8Array(password),
        salt: new Uint8Array(salt),
        parallelism,
        iterations,
        memorySize: memory,
        hashLength: length,
        outputType: "binary"
      });
      void version;
      return digest.buffer as ArrayBuffer;
    }
  );
}
