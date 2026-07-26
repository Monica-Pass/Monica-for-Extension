/**
 * Minimal SQLite surface the MDBX provider needs, so the vault logic never imports `sql.js` directly.
 * The extension loads the engine from `chrome.runtime.getURL()` — the `.wasm` cannot be added to
 * `web_accessible_resources`, which `security-audit.mjs:20` pins to the logo alone — while tests
 * supply a Node-side loader. Both go through this interface.
 */
export interface MdbxSqliteStatement {
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
}

export interface MdbxSqliteDatabase {
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string, params?: unknown[]): MdbxSqliteStatement;
  export(): Uint8Array;
  close(): void;
}

export interface MdbxSqliteEngine {
  open(bytes?: Uint8Array): MdbxSqliteDatabase;
}

export type MdbxSqliteEngineLoader = () => Promise<MdbxSqliteEngine>;

let loader: MdbxSqliteEngineLoader | undefined;
let pending: Promise<MdbxSqliteEngine> | undefined;

export function setMdbxSqliteEngineLoader(next: MdbxSqliteEngineLoader | undefined): void {
  loader = next;
  pending = undefined;
}

/** Cached: the WASM module is ~640 KiB and instantiating it per database open is wasteful. */
export function loadMdbxSqliteEngine(): Promise<MdbxSqliteEngine> {
  if (!loader) return Promise.reject(new Error("MDBX SQLite 引擎尚未注册。"));
  pending ??= loader().catch((error) => {
    pending = undefined;
    throw error;
  });
  return pending;
}

/** Lists user tables. MDBX schema evolves via `ensureColumn`, so presence is checked, never shape. */
export function listMdbxTables(database: MdbxSqliteDatabase): string[] {
  return queryMdbxRows(database, "SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => String(row.name));
}

export function queryMdbxRows(database: MdbxSqliteDatabase, sql: string, params?: unknown[]): Record<string, unknown>[] {
  const statement = database.prepare(sql, params);
  try {
    const rows: Record<string, unknown>[] = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

export function queryMdbxRow(database: MdbxSqliteDatabase, sql: string, params?: unknown[]): Record<string, unknown> | undefined {
  return queryMdbxRows(database, sql, params)[0];
}

/**
 * A BLOB comes back as `Uint8Array`, but the same column can hold TEXT when Android wrote it without
 * an epoch key. Normalising here keeps every caller from re-deciding what a `_ct` column contains.
 */
export function mdbxColumnBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return new TextEncoder().encode(value);
  return undefined;
}
