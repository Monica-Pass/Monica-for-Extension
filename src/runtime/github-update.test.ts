import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkGitHubUpdate, compareReleaseVersions, GITHUB_LATEST_API, GITHUB_RELEASES_URL, parseReleaseVersion } from './github-update';
import { version } from '../../package.json';

const release = (tag = 'v1.0.102', extra = {}) => new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false, ...extra }));
afterEach(() => vi.useRealTimers());

describe('GitHub update detection', () => {
  const asset = { name: 'monica-extension-1.0.104.zip', state: 'uploaded', size: 14001977,
    browser_download_url: `${GITHUB_RELEASES_URL}/download/v1.0.104/monica-extension-1.0.104.zip` };
  it('offers the exact official extension ZIP when it exists in the release', async () => {
    const fetcher = vi.fn().mockResolvedValue(release('v1.0.104', { assets: [asset] }));
    expect(await checkGitHubUpdate('1.0.103', undefined, fetcher)).toMatchObject({ kind: 'available', downloadUrl: asset.browser_download_url });
  });
  it.each([
    undefined, [], [asset, asset], [{ ...asset, state: 'new' }], [{ ...asset, size: 0 }],
    [{ ...asset, size: 128 * 1024 * 1024 + 1 }], [{ ...asset, size: '14001977' }],
    [{ ...asset, name: 'monica-mdbx2-host-windows-x64.zip' }],
    [{ ...asset, browser_download_url: 'https://evil.example.test/extension.zip' }],
    [{ ...asset, browser_download_url: asset.browser_download_url + '?redirect=elsewhere' }],
    [{ ...asset, browser_download_url: asset.browser_download_url.replace('v1.0.104', 'v1.0.103') }]
  ])('leaves a release-page fallback for absent or untrusted assets (%j)', async assets => {
    const fetcher = vi.fn().mockResolvedValue(release('v1.0.104', { assets }));
    expect(await checkGitHubUpdate('1.0.103', undefined, fetcher)).toEqual({ kind: 'available', version: '1.0.104', url: `${GITHUB_RELEASES_URL}/tag/v1.0.104` });
  });
  it.each([
    ['1.0.101', '0.1.48', 1], ['1.0.101', '1.0.99', 1], ['v1.0.101', '1.0.101', 0],
    ['1.0.102', '1.0.101', 1], ['1.0.9', '1.0.101', -1], ['1.1.0', '1.0.65535', 1],
    ['2.0.0', '10.0.0', -1]
  ])('compares numeric versions %s and %s', (left, right, expected) => expect(compareReleaseVersions(left, right)).toBe(expected));

  it.each(['', '1.0', '1.0.101.1', '1.0.0101', '1.0.102-beta', 'v1.0.102/path', ' 1.0.102', '1.0.65536', 'x1.0.102', 'https://evil.test'])('rejects unsafe or unsupported release tag %s', tag => {
    expect(parseReleaseVersion(tag)).toBeUndefined();
    expect(() => compareReleaseVersions(tag, version)).toThrow();
  });

  it('requests only the fixed public endpoint without credentials and constructs a trusted link', async () => {
    const fetcher = vi.fn().mockResolvedValue(release('v1.0.102', { html_url: 'javascript:alert(1)', body: '<script>evil</script>' }));
    expect(await checkGitHubUpdate('1.0.101', undefined, fetcher)).toEqual({ kind: 'available', version: '1.0.102', url: `${GITHUB_RELEASES_URL}/tag/v1.0.102` });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(GITHUB_LATEST_API, expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error' }));
  });

  it.each(['v1.0.101', 'v0.1.48'])('does not propose a downgrade or reinstall of %s', async tag => {
    expect(await checkGitHubUpdate('1.0.101', undefined, vi.fn().mockResolvedValue(release(tag)))).toMatchObject({ kind: 'current' });
  });

  it.each([[404, 'none'], [403, 'rate-limit'], [429, 'rate-limit'], [503, 'network']] as const)('distinguishes GitHub status %s', async (status, expected) => {
    const request = checkGitHubUpdate(version, undefined, vi.fn().mockResolvedValue(new Response('', { status })));
    if (expected === 'none') expect(await request).toEqual({ kind: 'none' });
    else await expect(request).rejects.toMatchObject({ code: expected });
  });

  it.each([{ draft: true }, { prerelease: true }, { tag_name: '<img onerror=evil>' }, { draft: undefined }])('rejects draft, prerelease or malformed metadata %j', async extra => {
    await expect(checkGitHubUpdate(version, undefined, vi.fn().mockResolvedValue(release('v1.0.102', extra)))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects malformed and oversized data', async () => {
    for (const response of [new Response('not json'), new Response(JSON.stringify(null)), new Response('x'.repeat(512 * 1024 + 1)), new Response('{}', { headers: { 'content-length': String(512 * 1024 + 1) } })]) {
      await expect(checkGitHubUpdate(version, undefined, vi.fn().mockResolvedValue(response))).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  it('reports connection failures without surfacing upstream strings', async () => {
    await expect(checkGitHubUpdate(version, undefined, vi.fn().mockRejectedValue(new Error('private proxy detail')))).rejects.toMatchObject({ code: 'network', message: 'network' });
  });

  it('times out a stalled request and cleans up timers', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    const request = expect(checkGitHubUpdate(version, undefined, fetcher)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(12_000);
    await request;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards owner cancellation to fetch and removes its timeout', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('owner left')), { once: true })));
    const request = expect(checkGitHubUpdate(version, controller.signal, fetcher)).rejects.toThrow('owner left');
    controller.abort(); await request;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps package, lockfile and installed browser version synchronized', () => {
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
    expect([lock.version, lock.packages[''].version, manifest.version]).toEqual([version, version, version]);
    expect(parseReleaseVersion(version)).toHaveLength(3);
  });
});
