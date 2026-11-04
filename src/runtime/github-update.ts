export const GITHUB_RELEASES_URL = 'https://github.com/Monica-Pass/Monica-for-Extension/releases';
export const GITHUB_LATEST_API = 'https://api.github.com/repos/Monica-Pass/Monica-for-Extension/releases/latest';
const MAX_RESPONSE_BYTES = 512 * 1024;
export type UpdateFailure = 'network' | 'timeout' | 'rate-limit' | 'invalid';
export class GitHubUpdateError extends Error {
  constructor(readonly code: UpdateFailure) { super(code); }
}
export type GitHubUpdateResult = { kind: 'none' } | { kind: 'available' | 'current'; version: string; url: string; downloadUrl?: string };

function extensionDownloadUrl(assets: unknown, tag: string, version: string): string | undefined {
  if (!Array.isArray(assets)) return;
  const name = `monica-extension-${version}.zip`;
  const candidates = assets.filter(asset => asset && typeof asset === 'object' && asset.name === name);
  if (candidates.length !== 1) return;
  const asset = candidates[0];
  const url = `${GITHUB_RELEASES_URL}/download/${tag}/${name}`;
  return asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0
    && asset.size <= 128 * 1024 * 1024 && asset.browser_download_url === url ? url : undefined;
}

/** Tags and browser versions share a numeric X.Y.Z scheme, never lexical ordering. */
export function parseReleaseVersion(value: string): number[] | undefined {
  if (typeof value !== 'string' || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return;
  const parts = value.replace(/^v/, '').split('.').map(Number);
  return parts.every(part => Number.isSafeInteger(part) && part <= 65535) ? parts : undefined;
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseReleaseVersion(left), b = parseReleaseVersion(right);
  if (!a || !b) throw new GitHubUpdateError('invalid');
  for (let n = 0; n < 3; n++) if (a[n] !== b[n]) return a[n] > b[n] ? 1 : -1;
  return 0;
}

async function releaseJson(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new GitHubUpdateError('invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new GitHubUpdateError('invalid'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new GitHubUpdateError('invalid'); }
}

/** Public release metadata only. No vault access, authentication or executable content. */
export async function checkGitHubUpdate(currentVersion: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<GitHubUpdateResult> {
  if (!parseReleaseVersion(currentVersion)) throw new GitHubUpdateError('invalid');
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12_000);
  try {
    const response = await fetcher(GITHUB_LATEST_API, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: controller.signal
    });
    if (response.status === 403 || response.status === 429) throw new GitHubUpdateError('rate-limit');
    if (response.status === 404) return { kind: 'none' };
    if (!response.ok) throw new GitHubUpdateError('network');
    const release = await releaseJson(response) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown } | null;
    if (!release || typeof release.tag_name !== 'string' || release.draft !== false || release.prerelease !== false || !parseReleaseVersion(release.tag_name)) throw new GitHubUpdateError('invalid');
    const version = release.tag_name.replace(/^v/, '');
    const downloadUrl = extensionDownloadUrl(release.assets, release.tag_name, version);
    return { kind: compareReleaseVersions(version, currentVersion) > 0 ? 'available' : 'current', version,
      url: `${GITHUB_RELEASES_URL}/tag/${release.tag_name}`, ...(downloadUrl ? { downloadUrl } : {}) };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timedOut) throw new GitHubUpdateError('timeout');
    throw error instanceof GitHubUpdateError ? error : new GitHubUpdateError('network');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
