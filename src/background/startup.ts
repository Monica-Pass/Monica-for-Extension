type SessionAccessLevelSetter = (options: { accessLevel: "TRUSTED_CONTEXTS" }) => Promise<void> | void;

export async function configureSessionStorageAccess(setAccessLevel: SessionAccessLevelSetter | undefined): Promise<void> {
  if (!setAccessLevel) return;
  try {
    await setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // TRUSTED_CONTEXTS is the default. Keep startup usable when this optional
    // browser method is unavailable or rejects the request.
  }
}
