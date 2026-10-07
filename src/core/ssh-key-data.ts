import { parseLosslessJson } from './lossless-json';

/** Reject lossy conversions before a backend can overwrite an existing key. */
export function assertWritableSshKeyData(raw: string | undefined): void {
  if (!raw?.trim()) return; // Missing/blank data is an explicit clear.
  const fail = () => { throw new Error('SSH 数据格式无法安全保存，请检查密钥信息；原记录未修改。'); };
  let parsed: unknown;
  try { parsed = parseLosslessJson(raw); } catch { fail(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail();
  const ssh = parsed as Record<string, unknown>;
  for (const name of ['algorithm', 'publicKeyOpenSsh', 'privateKeyOpenSsh', 'fingerprintSha256', 'comment', 'format']) {
    if (ssh[name] !== undefined && typeof ssh[name] !== 'string') fail();
  }
  if (ssh.keySize !== undefined && (typeof ssh.keySize !== 'number' || !Number.isSafeInteger(ssh.keySize) || ssh.keySize < 0)) fail();
}
