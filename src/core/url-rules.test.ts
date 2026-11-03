import { describe, expect, it } from 'vitest';
import { createLoginItem } from './model';
import { ANDROID_URL_RULE_FIELD, decodeAndroidUrlRules, effectiveLoginUriRules, writeAndroidUrlRules } from './url-rules';
import { loginMatchScore } from './matching';

const carrier = (value: string) => ({ name: ANDROID_URL_RULE_FIELD, value, protected: true });
const fields = (urls: unknown[]) => [carrier(JSON.stringify({ version: 1, urls }))];
const login = (urls: unknown[]) => ({ ...createLoginItem({ title: 'Rule', uris: ['https://example.test'] }), customFields: fields(urls) });

describe('Android URL rule metadata', () => {
  it('preserves all modes, literal URLs, separators, field attributes and future numeric data', () => {
    const raw = '{"version":1,"future":9007199254740993,"urls":[{"url":"^https://Example\\\\.test/(a,b|c)$","mode":"REGEX","extra":1.00000000000000001},{"url":"https://Example.test/Case","mode":"HOST"}]}';
    const source = [carrier(raw)];
    const rules = decodeAndroidUrlRules(raw)!;
    expect(rules[0].uri).toContain('a,b|c');
    expect(writeAndroidUrlRules(source, rules)).toBe(source);
    const updated = writeAndroidUrlRules(source, [rules[1], { ...rules[0], matchType: 'never' }]);
    expect(updated[0].protected).toBe(true);
    expect(updated[0].value).toContain('9007199254740993');
    expect(updated[0].value).toContain('1.00000000000000001');
    expect(decodeAndroidUrlRules(updated[0].value)).toEqual([rules[1], { ...rules[0], matchType: 'never' }]);
    const modes = ['DEFAULT', 'BASE_DOMAIN', 'HOST', 'STARTS_WITH', 'EXACT', 'REGEX', 'NEVER'];
    expect(effectiveLoginUriRules(login(modes.map(mode => ({ url: 'Example.test', mode })))).map(row => row.matchType))
      .toEqual(['default', 'base-domain', 'host', 'starts-with', 'exact', 'regex', 'never']);
  });

  it('removes only explicit all-default rules; BASE_DOMAIN remains explicit', () => {
    const source = fields([{ url: 'Example.test', mode: 'HOST' }]);
    expect(writeAndroidUrlRules(source, [{ uri: 'Example.test', matchType: 'default' }])).toEqual([]);
    expect(decodeAndroidUrlRules(writeAndroidUrlRules([], [{ uri: 'Example.test', matchType: 'base-domain' }])[0].value))
      .toEqual([{ uri: 'Example.test', matchType: 'base-domain' }]);
  });
  it('rejects mixed legacy domain and Android HOST rather than broadening HOST semantics', () => {
    expect(() => writeAndroidUrlRules([], [{ uri: 'example.test', matchType: 'domain' }, { uri: 'www.example.test', matchType: 'host' }])).toThrow('不能转换');
  });

  it.each(['{"version":2,"urls":[]}', '{"version":1,"urls":[{"url":"example.test","mode":"FUTURE"}]}', 'broken'])('fails closed on unknown carrier %s', value => {
    const item = { ...createLoginItem({ title: 'Rules', uris: ['example.test'] }), customFields: [carrier(value)] };
    expect(loginMatchScore(item, 'https://example.test')).toBe(0);
    expect(() => writeAndroidUrlRules(item.customFields, [{ uri: 'example.test', matchType: 'host' }])).toThrow();
    item.customFields.push(carrier(value));
    expect(loginMatchScore(item, 'https://example.test')).toBe(0);
  });

  it('uses host boundaries including www, prefix authority and case-sensitive regex', () => {
    const score = (mode: string, url: string, target: string) => loginMatchScore(login([{ url, mode }]), target);
    expect(score('HOST', 'www.example.test', 'https://example.test')).toBe(0);
    expect(score('HOST', 'example.test', 'https://sub.example.test')).toBe(0);
    expect(score('HOST', 'Example.test', 'https://example.test/anything')).toBeGreaterThan(0);
    expect(score('STARTS_WITH', 'https://example.test', 'https://example.test.evil/')).toBe(0);
    expect(score('STARTS_WITH', 'example.test', 'https://example.test/path')).toBeGreaterThan(0);
    expect(score('STARTS_WITH', 'https://example.test:443/Auth', 'https://example.test/Auth/ok')).toBeGreaterThan(0);
    expect(score('REGEX', '^https://example\\.test/Case$', 'https://example.test/case')).toBe(0);
    expect(score('REGEX', '(a+)+$', `https://example.test/${'a'.repeat(1000)}!`)).toBe(0);
    expect(score('REGEX', '(?<=example)\\.test', 'https://example.test')).toBe(0);
    expect(score('NEVER', 'example.test', 'https://example.test')).toBe(0);
  });
});
