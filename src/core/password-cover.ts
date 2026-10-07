/** Only the version-one boolean spelling is owned; future and malformed data stays opaque. */
export function parsePasswordCoverField(value: unknown): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}
