import { describe, expect, it, vi } from "vitest";
import { configureSessionStorageAccess } from "./startup";

describe("background startup", () => {
  it("keeps the service worker alive when session access control is unavailable", async () => {
    await expect(configureSessionStorageAccess(undefined)).resolves.toBeUndefined();
  });

  it("contains a rejected session access control request", async () => {
    const setAccessLevel = vi.fn().mockRejectedValue(new Error("unsupported access level"));

    await expect(configureSessionStorageAccess(setAccessLevel)).resolves.toBeUndefined();
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });
});
