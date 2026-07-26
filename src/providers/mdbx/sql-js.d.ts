/**
 * `sql.js` ships no types. Declaring the narrow surface we use here instead of adding `@types/sql.js`
 * keeps the dependency count down and keeps the declaration honest: anything beyond these members is
 * a compile error rather than silently typed `any`.
 */
declare module "sql.js" {
  interface SqlJsStatement {
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  }

  interface SqlJsDatabase {
    run(sql: string, params?: unknown[]): void;
    prepare(sql: string, params?: unknown[]): SqlJsStatement;
    export(): Uint8Array;
    close(): void;
  }

  interface SqlJsStatic {
    Database: new (bytes?: Uint8Array) => SqlJsDatabase;
  }

  interface SqlJsConfig {
    locateFile?: (file: string) => string;
    wasmBinary?: ArrayBuffer;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
