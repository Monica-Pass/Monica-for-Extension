/** Preserve exact source values when a form's display projection was not edited. */
export function preserveUneditedProjection<T>(original: T, baseline: unknown, edited: T): T {
  if (JSON.stringify(baseline) === JSON.stringify(edited)) return original;
  if (!edited || typeof edited !== "object" || Array.isArray(edited) || !original || typeof original !== "object" || Array.isArray(original) || !baseline || typeof baseline !== "object") return edited;
  const before=baseline as Record<string,unknown>, source=original as Record<string,unknown>;
  const result = { ...source };
  for (const [key, value] of Object.entries(edited)) {
    if (JSON.stringify(before[key]) === JSON.stringify(value)) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) delete result[key];
    } else result[key] = preserveUneditedProjection(source[key], before[key], value);
  }
  // An omitted editable field is an explicit removal. Source-only future keys remain untouched.
  for (const key of Object.keys(before)) if (!Object.prototype.hasOwnProperty.call(edited, key)) delete result[key];
  return result as T;
}
