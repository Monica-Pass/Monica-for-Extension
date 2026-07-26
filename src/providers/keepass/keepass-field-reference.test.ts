import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import {
  buildKeePassReferenceContext,
  normalizeUuid,
  resolveKeePassEntryFields,
  resolveKeePassReferenceValue,
  type KeePassReferenceEntry
} from "./keepass-field-reference";
import { keePassFieldText, type KeePassEntryFieldValue } from "./keepass-login-codec";

/** Assertion semantics translated from Android `utils/KeePassFieldReferenceResolver.kt` (SHA 9930d8d8). */

const ALICE_UUID = "5A2B1C3D-4E5F-6071-8293-A4B5C6D7E8F9";
const BOB_UUID = "11112222-3333-4444-5555-666677778888";

function secret(value: string): kdbxweb.ProtectedValue {
  return kdbxweb.ProtectedValue.fromString(value);
}

function entry(uuid: string, fields: Record<string, KeePassEntryFieldValue>): KeePassReferenceEntry {
  return { uuid, fields: new Map(Object.entries(fields)) };
}

function alice(overrides: Record<string, KeePassEntryFieldValue> = {}): KeePassReferenceEntry {
  return entry(ALICE_UUID, {
    Title: "GitHub",
    UserName: "alice",
    Password: secret("hunter2"),
    URL: "https://github.com",
    Notes: "主账号",
    ...overrides
  });
}

describe("resolveKeePassReferenceValue", () => {
  it("resolves each standard field code against the referenced entry", () => {
    const source = alice();
    const consumer = entry(BOB_UUID, {});
    const context = buildKeePassReferenceContext([source, consumer]);
    const resolve = (code: string) =>
      resolveKeePassReferenceValue(`{REF:${code}@I:${ALICE_UUID}}`, consumer, context);

    expect(resolve("T")).toBe("GitHub");
    expect(resolve("U")).toBe("alice");
    expect(resolve("P")).toBe("hunter2");
    expect(resolve("A")).toBe("https://github.com");
    expect(resolve("N")).toBe("主账号");
  });

  it("matches the uuid with dashes and case ignored, the way KeePass writes them", () => {
    const source = alice();
    const consumer = entry(BOB_UUID, {});
    const context = buildKeePassReferenceContext([source, consumer]);

    for (const written of [ALICE_UUID, ALICE_UUID.toLowerCase(), ALICE_UUID.replace(/-/g, "")]) {
      expect(resolveKeePassReferenceValue(`{REF:U@I:${written}}`, consumer, context), written).toBe("alice");
    }
  });

  /**
   * The token regex stops at the first `}`, so a braced uuid ends the token early and its closing brace
   * is left as trailing text. The lookup still succeeds because the leading brace is normalized away.
   * Asserted rather than fixed: the same regex is what Android matches with.
   */
  it("resolves a braced uuid but leaves its closing brace as trailing text, as Android does", () => {
    const context = buildKeePassReferenceContext([alice()]);

    expect(resolveKeePassReferenceValue(`{REF:U@I:{${ALICE_UUID}}}`, entry(BOB_UUID, {}), context)).toBe("alice}");
  });

  it("accepts a lowercase token, since KeePass writes {ref:u@i:…} too", () => {
    const source = alice();
    const context = buildKeePassReferenceContext([source]);

    expect(resolveKeePassReferenceValue(`{ref:u@i:${ALICE_UUID}}`, entry(BOB_UUID, {}), context)).toBe("alice");
  });

  it("searches by any standard field, not just the uuid", () => {
    const source = alice();
    const consumer = entry(BOB_UUID, {});
    const context = buildKeePassReferenceContext([source, consumer]);

    expect(resolveKeePassReferenceValue("{REF:P@T:GitHub}", consumer, context)).toBe("hunter2");
    expect(resolveKeePassReferenceValue("{REF:P@U:alice}", consumer, context)).toBe("hunter2");
    expect(resolveKeePassReferenceValue("{REF:T@A:https://github.com}", consumer, context)).toBe("GitHub");
    expect(resolveKeePassReferenceValue("{REF:T@N:主账号}", consumer, context)).toBe("GitHub");
  });

  it("compares the search text case-insensitively", () => {
    const context = buildKeePassReferenceContext([alice()]);

    expect(resolveKeePassReferenceValue("{REF:U@T:github}", entry(BOB_UUID, {}), context)).toBe("alice");
  });

  it("resolves the whole field, leaving the surrounding text in place", () => {
    const context = buildKeePassReferenceContext([alice()]);

    expect(resolveKeePassReferenceValue(`user=${"{REF:U@I:" + ALICE_UUID + "}"} 结束`, entry(BOB_UUID, {}), context)).toBe(
      "user=alice 结束"
    );
  });

  it("resolves several tokens in one value", () => {
    const context = buildKeePassReferenceContext([alice()]);

    expect(
      resolveKeePassReferenceValue(`{REF:U@I:${ALICE_UUID}}@{REF:T@I:${ALICE_UUID}}`, entry(BOB_UUID, {}), context)
    ).toBe("alice@GitHub");
  });

  it("returns I as the referenced entry's uuid, spelled exactly as the entry spells it", () => {
    const context = buildKeePassReferenceContext([alice()]);

    expect(resolveKeePassReferenceValue("{REF:I@T:GitHub}", entry(BOB_UUID, {}), context)).toBe(ALICE_UUID);
  });

  /**
   * The search text is run through the resolver before searching, but a nested `{REF:…}` can never
   * survive the token regex: `[^}]+` stops at the inner closing brace, so the outer token captures an
   * unterminated fragment that matches nothing. Asserted rather than fixed — Android matches with the
   * same regex, and widening it here would resolve tokens Android leaves literal.
   */
  it("cannot span a reference nested in the search text, since the token stops at the first brace", () => {
    const naming = entry(BOB_UUID, { Title: "指针", Notes: "GitHub" });
    const context = buildKeePassReferenceContext([alice(), naming]);

    expect(resolveKeePassReferenceValue("{REF:U@T:{REF:N@T:指针}}", naming, context)).toBe("{REF:U@T:{REF:N@T:指针}}");
  });

  it("follows a reference stored inside the referenced field", () => {
    const source = alice();
    const middle = entry(BOB_UUID, { Title: "中转", UserName: `{REF:U@I:${ALICE_UUID}}` });
    const context = buildKeePassReferenceContext([source, middle]);

    expect(resolveKeePassReferenceValue("{REF:U@T:中转}", entry("99", {}), context)).toBe("alice");
  });

  describe("the O code, which means any field that is neither standard nor a plugin field", () => {
    it("returns the first such field", () => {
      const source = alice({ TOTP: "JBSWY3DPEHPK3PXP" });
      const context = buildKeePassReferenceContext([source]);

      expect(resolveKeePassReferenceValue("{REF:O@T:GitHub}", entry(BOB_UUID, {}), context)).toBe("JBSWY3DPEHPK3PXP");
    });

    it("skips a blank one and a _etm_ plugin field", () => {
      const source = alice({ _etm_template: "1", Blank: "", Recovery: "ABCD" });
      const context = buildKeePassReferenceContext([source]);

      expect(resolveKeePassReferenceValue("{REF:O@T:GitHub}", entry(BOB_UUID, {}), context)).toBe("ABCD");
    });

    it("searches by such a field too", () => {
      const source = alice({ Recovery: "ABCD" });
      const context = buildKeePassReferenceContext([source]);

      expect(resolveKeePassReferenceValue("{REF:U@O:ABCD}", entry(BOB_UUID, {}), context)).toBe("alice");
    });

    it("yields nothing when the entry carries only standard fields", () => {
      const context = buildKeePassReferenceContext([alice()]);

      expect(resolveKeePassReferenceValue("{REF:O@T:GitHub}", entry(BOB_UUID, {}), context)).toBe("{REF:O@T:GitHub}");
    });
  });

  describe("leaving the token as written rather than inventing a value", () => {
    it("when no entry matches", () => {
      const context = buildKeePassReferenceContext([alice()]);

      expect(resolveKeePassReferenceValue("{REF:U@T:不存在}", entry(BOB_UUID, {}), context)).toBe("{REF:U@T:不存在}");
    });

    it("when the search code is not one of TUPANOI", () => {
      const context = buildKeePassReferenceContext([alice()]);

      expect(resolveKeePassReferenceValue("{REF:U@X:GitHub}", entry(BOB_UUID, {}), context)).toBe("{REF:U@X:GitHub}");
    });

    it("when the target code is not one of TUPANOI", () => {
      const context = buildKeePassReferenceContext([alice()]);

      expect(resolveKeePassReferenceValue("{REF:X@T:GitHub}", entry(BOB_UUID, {}), context)).toBe("{REF:X@T:GitHub}");
    });

    it("when there is no context at all, which is how a caller opts out", () => {
      expect(resolveKeePassReferenceValue("{REF:U@T:GitHub}", alice(), undefined)).toBe("{REF:U@T:GitHub}");
    });
  });

  it("returns a value with no reference untouched, including one holding a lone brace", () => {
    const context = buildKeePassReferenceContext([alice()]);

    expect(resolveKeePassReferenceValue("plain", entry(BOB_UUID, {}), context)).toBe("plain");
    expect(resolveKeePassReferenceValue("{NOTAREF}", entry(BOB_UUID, {}), context)).toBe("{NOTAREF}");
    expect(resolveKeePassReferenceValue("", entry(BOB_UUID, {}), context)).toBe("");
  });

  describe("cycles, which must terminate rather than recurse forever", () => {
    it("leaves a self-reference as written", () => {
      const selfRef = entry(ALICE_UUID, { Title: "自引用", UserName: `{REF:U@I:${ALICE_UUID}}` });
      const context = buildKeePassReferenceContext([selfRef]);

      expect(resolveKeePassReferenceValue(`{REF:U@I:${ALICE_UUID}}`, selfRef, context)).toBe(`{REF:U@I:${ALICE_UUID}}`);
    });

    it("terminates on a pair of entries quoting each other", () => {
      const first = entry(ALICE_UUID, { Title: "A", UserName: `{REF:U@I:${BOB_UUID}}` });
      const second = entry(BOB_UUID, { Title: "B", UserName: `{REF:U@I:${ALICE_UUID}}` });
      const context = buildKeePassReferenceContext([first, second]);

      const resolved = resolveKeePassReferenceValue(`{REF:U@I:${ALICE_UUID}}`, entry("99", {}), context);

      expect(resolved).toContain("{REF:U@I:");
    });

    it("stops after eight hops down a chain of aliases", () => {
      const links = Array.from({ length: 12 }, (_, index) =>
        entry(`uuid-${index}`, { Title: `link-${index}`, UserName: index === 11 ? "终点" : `{REF:U@T:link-${index + 1}}` })
      );
      const context = buildKeePassReferenceContext(links);

      const resolved = resolveKeePassReferenceValue("{REF:U@T:link-0}", entry("caller", {}), context);

      expect(resolved).not.toBe("终点");
      expect(resolved).toContain("{REF:U@T:link-");
    });
  });

  it("picks the first entry when two share a uuid, rather than failing", () => {
    const first = alice({ UserName: "first" });
    const second = alice({ UserName: "second" });
    const context = buildKeePassReferenceContext([first, second]);

    expect(resolveKeePassReferenceValue(`{REF:U@I:${ALICE_UUID}}`, entry(BOB_UUID, {}), context)).toBe("first");
  });

  it("reads through a protected field, so a referenced password is not stringified", () => {
    const context = buildKeePassReferenceContext([alice({ Password: secret("受保护") })]);

    expect(resolveKeePassReferenceValue("{REF:P@T:GitHub}", entry(BOB_UUID, {}), context)).toBe("受保护");
  });
});

describe("resolveKeePassEntryFields", () => {
  it("expands every field that carries a reference", () => {
    const source = alice();
    const consumer = entry(BOB_UUID, {
      Title: "备用",
      UserName: `{REF:U@I:${ALICE_UUID}}`,
      Password: secret(`{REF:P@I:${ALICE_UUID}}`)
    });
    const context = buildKeePassReferenceContext([source, consumer]);

    const resolved = resolveKeePassEntryFields(consumer, context);

    expect(resolved.get("Title")).toBe("备用");
    expect(keePassFieldText(resolved.get("UserName"))).toBe("alice");
    expect(keePassFieldText(resolved.get("Password"))).toBe("hunter2");
  });

  /**
   * A resolver that returned strings everywhere would silently downgrade every protected field to
   * plaintext, so an unreferenced value must come back as the very same object.
   */
  it("keeps the exact value object of a field that held no reference", () => {
    const password = secret("hunter2");
    const consumer = entry(BOB_UUID, { Title: "备用", Password: password });
    const context = buildKeePassReferenceContext([alice(), consumer]);

    const resolved = resolveKeePassEntryFields(consumer, context);

    expect(resolved.get("Password")).toBe(password);
  });

  it("returns a plain string for a protected field that did expand, since the expansion is new text", () => {
    const consumer = entry(BOB_UUID, { Password: secret(`{REF:P@I:${ALICE_UUID}}`) });
    const context = buildKeePassReferenceContext([alice(), consumer]);

    expect(resolveKeePassEntryFields(consumer, context).get("Password")).toBe("hunter2");
  });

  it("passes every field through unchanged when there is no context", () => {
    const consumer = alice({ UserName: `{REF:U@I:${ALICE_UUID}}` });

    const resolved = resolveKeePassEntryFields(consumer, undefined);

    expect(resolved.get("UserName")).toBe(`{REF:U@I:${ALICE_UUID}}`);
    expect(resolved.get("Password")).toBe(consumer.fields.get("Password"));
  });
});

describe("normalizeUuid", () => {
  it("strips braces and dashes and folds case", () => {
    expect(normalizeUuid(`  {${ALICE_UUID}}  `)).toBe(ALICE_UUID.replace(/-/g, "").toLowerCase());
  });

  it("leaves an empty string empty", () => {
    expect(normalizeUuid("   ")).toBe("");
  });
});
