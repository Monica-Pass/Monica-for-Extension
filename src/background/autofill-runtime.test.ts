import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createAutofillRuntime } from './autofill-runtime';
import { createLoginItem } from '../core/model';

const root = 'chrome-extension://synthetic/';
const sender = { id: 'synthetic', url: root + 'index.html', origin: root.slice(0, -1) };
const url = 'https://login.example.test/';
const documentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
let sendMessage: Mock;
beforeEach(() => {
  sendMessage = vi.fn(async (_tab: number, _message: unknown) => ({ ok: false }));
  vi.stubGlobal('chrome', { runtime: { id: 'synthetic', getURL: (name: string) => root + name },
    tabs: { get: vi.fn(async () => ({ active: true })), sendMessage },
    webNavigation: { getFrame: vi.fn(async () => ({ url, documentId, documentLifecycle: 'active' })) } });
});
afterEach(() => vi.unstubAllGlobals());

describe('autofill HOTP acknowledgements after partial page success', () => {
  function fixture(filledTotp: boolean, consumed = true) {
    const item = { ...createLoginItem({ title: 'Fixture', username: 'alice', password: 'password', uris: [url] }),
      totpSecret: 'otpauth://hotp/Fixture?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=7' };
    const events: string[] = [];
    const service = { readAutofillContext: vi.fn(async () => ({ items: [item], locked: false, blockedHosts: [], blockedFieldSignatures: [] })),
      dispatchAutofill: vi.fn(async (_context, work: () => Promise<unknown>) => work()),
      consumeHotp: vi.fn(async () => { events.push('consume'); return consumed; }) };
    sendMessage.mockImplementation(async (_tab, message) => {
      if ((message as { type?: string }).type === 'MONICA_GET_FIELD_CONTEXT') return { ok: false };
      events.push('fill'); return { ok: false, error: 'custom control failed', filledTotp };
    });
    const afterRuntimeRequest = vi.fn(async () => { events.push('notify'); });
    const dismissInlineMenus = vi.fn(async () => undefined);
    const runtime = createAutofillRuntime({ service, afterRuntimeRequest, dismissInlineMenus, autofillBlocked: async () => false } as unknown as Parameters<typeof createAutofillRuntime>[0]);
    const request = { type: 'VAULT_FILL_LOGIN', itemId: item.id, tabId: 4, documentId, expectedOrigin: new URL(url).origin } as const;
    return { events, service, runtime, request, afterRuntimeRequest, dismissInlineMenus };
  }
  it('consumes a code already delivered to the field and notifies before reporting another field failure', async () => {
    const f = fixture(true);
    await expect(f.runtime.handlers.VAULT_FILL_LOGIN(f.request, sender, false)).rejects.toThrow('custom control failed');
    expect(f.events).toEqual(['fill', 'consume', 'notify']);
    expect(f.service.consumeHotp).toHaveBeenCalledOnce();
    expect(f.afterRuntimeRequest).toHaveBeenCalledWith(expect.objectContaining({ type: 'VAULT_CONSUME_HOTP' }));
    expect(f.dismissInlineMenus).toHaveBeenCalledOnce();
  });
  it('does not consume or notify when the page did not acknowledge the code field', async () => {
    const f = fixture(false);
    await expect(f.runtime.handlers.VAULT_FILL_LOGIN(f.request, sender, false)).rejects.toThrow();
    expect(f.service.consumeHotp).not.toHaveBeenCalled();
    expect(f.afterRuntimeRequest).not.toHaveBeenCalled();
  });
  it('does not emit a duplicate mutation notification when the code was already consumed', async () => {
    const f = fixture(true, false);
    await expect(f.runtime.handlers.VAULT_FILL_LOGIN(f.request, sender, false)).rejects.toThrow();
    expect(f.service.consumeHotp).toHaveBeenCalledOnce();
    expect(f.afterRuntimeRequest).not.toHaveBeenCalled();
  });
  it('rejects a replaced document before reading or sending credentials', async () => {
    const f = fixture(true);
    await expect(f.runtime.handlers.VAULT_FILL_LOGIN({ ...f.request, documentId: 'obsolete' }, sender, false)).rejects.toThrow('页面已变化');
    expect(f.service.readAutofillContext).not.toHaveBeenCalled();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
