import { describe, expect, it } from "vitest";
import { bitwardenNotificationUrl, parseBitwardenNotification } from "./bitwarden-notifications";

describe("official Bitwarden notification compatibility", () => {
  it.each([
    ["https://vault.bitwarden.com", "https://notifications.bitwarden.com/hub"],
    ["https://vault.bitwarden.eu", "https://notifications.bitwarden.eu/hub"],
    ["https://self.example.test/prefix/", "https://self.example.test/prefix/notifications/hub"],
    ["http://127.0.0.1:9123", "http://127.0.0.1:9123/notifications/hub"]
  ])("uses the official hub for %s", (vault, expected) => expect(bitwardenNotificationUrl(vault)).toBe(expected));

  it("rejects credential-bearing, insecure and parameterized endpoints", () => {
    for (const url of ["http://self.example.test", "https://user:secret@example.test", "https://example.test?access_token=secret"]) {
      expect(() => bitwardenNotificationUrl(url)).toThrow();
    }
  });

  it.each([0, 1, 2, 9])("treats type %i as a fetch hint, including legacy and modern deletes", type => {
    expect(parseBitwardenNotification({ Type: type, ContextId: "phone", Payload: { UserId: "user", Id: "cipher", Password: "untrusted" } }, "user", "browser"))
      .toEqual({ type: "ciphers", ids: ["cipher"] });
    expect(parseBitwardenNotification({ type, contextId: "phone", payload: { userId: "user", id: "cipher" } }, "user", "browser"))
      .toEqual({ type: "ciphers", ids: ["cipher"] });
  });

  it("isolates accounts and ignores this device's notifications", () => {
    expect(parseBitwardenNotification({ type: 0, payload: { userId: "other", id: "cipher" } }, "user", "browser")).toBeUndefined();
    expect(parseBitwardenNotification({ type: 0, contextId: "browser", payload: { userId: "user", id: "cipher" } }, "user", "browser")).toBeUndefined();
  });

  it("reconciles context changes and recognizes session revocation", () => {
    for (const type of [3, 4, 5, 6, 7, 8, 10, 17, 18, 19, 25]) {
      expect(parseBitwardenNotification({ type, payload: { userId: "user" } }, "user", "browser")).toEqual({ type: "full" });
    }
    expect(parseBitwardenNotification({ type: 11 }, "user", "browser")).toEqual({ type: "logout" });
    for (const input of [null, [], { type: 0, payload: { id: "" } }, { type: "0", payload: { id: "cipher" } }, { type: 15 }, { type: 999 }]) {
      expect(parseBitwardenNotification(input, "user", "browser")).toBeUndefined();
    }
  });
});
