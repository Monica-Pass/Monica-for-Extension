/** M3E focus-ring resolves `for` using a CSS selector; raw provider IDs may contain ':'. */
export function vaultRowDomId(id: string): string {
  return 'vault-row-' + [...new TextEncoder().encode(id)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
