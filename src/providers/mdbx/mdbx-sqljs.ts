import type { MdbxSqliteDatabase, MdbxSqliteEngine, MdbxSqliteStatement } from "./mdbx-sqlite";

/**
 * `sql.js` binding. It is kept out of `mdbx-sqlite.ts` so nothing but an explicit MDBX open pulls the
 * ~640 KiB WASM module into a bundle.
 *
 * We use the pure-memory build on purpose: `export()` returns the whole file, so there is no WAL to
 * checkpoint before upload. `wa-sqlite` + OPFS would need an explicit `wal_checkpoint(TRUNCATE)` or
 * the uploaded `.mdbx` would silently lose the most recent writes (`MdbxVaultStore.kt:2778-2793`).
 */
export interface SqlJsFactoryOptions {
  locateFile?: (file: string) => string;
  wasmBinary?: ArrayBuffer;
}

type SqlJsFactory = (options?: SqlJsFactoryOptions) => Promise<{ Database: new (bytes?: Uint8Array) => SqlJsDatabase }>;

interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string, params?: unknown[]): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatement {
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  free(): void;
}

export async function createSqlJsEngine(factory: SqlJsFactory, options?: SqlJsFactoryOptions): Promise<MdbxSqliteEngine> {
  const sql = await factory(options);
  return { open: (bytes) => wrapDatabase(new sql.Database(bytes)) };
}

/**
 * Extension pages and the service worker both hit the MV3 CSP `script-src 'self' 'wasm-unsafe-eval'`.
 * Fetching the bytes ourselves and handing them over as `wasmBinary` avoids sql.js resolving a URL
 * relative to the document, which does not survive bundling.
 */
export async function createExtensionSqlJsEngine(factory: SqlJsFactory, wasmUrl: string): Promise<MdbxSqliteEngine> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`无法加载 SQLite 引擎（HTTP ${response.status}）。`);
  return createSqlJsEngine(factory, { wasmBinary: await response.arrayBuffer() });
}

function wrapDatabase(database: SqlJsDatabase): MdbxSqliteDatabase {
  return {
    run: (sql, params) => database.run(sql, params),
    prepare: (sql, params): MdbxSqliteStatement => {
      const statement = database.prepare(sql, params);
      return { step: () => statement.step(), getAsObject: () => statement.getAsObject(), free: () => statement.free() };
    },
    export: () => database.export(),
    close: () => database.close()
  };
}
