/**
 * Minimal type declarations for the bun:sqlite built-in module.
 * This allows TypeScript (NodeNext) to resolve the bun:sqlite import
 * when the reflection-store is compiled alongside Node.js types.
 */
declare module 'bun:sqlite' {
  export interface DatabaseOptions {
    readonly?: boolean;
    create?: boolean;
    readwrite?: boolean;
  }

  export interface StatementOptions {
    strict?: boolean;
  }

  export interface Statement<T, P extends unknown[] = unknown[]> {
    get(...params: P): T | null;
    all(...params: P): T[];
    run(...params: P): void;
    finalize(): void;
  }

  export class Database {
    constructor(filename: string, options?: DatabaseOptions);
    exec(sql: string): void;
    prepare<T = unknown, P extends unknown[] = unknown[]>(
      sql: string,
      options?: StatementOptions,
    ): Statement<T, P>;
    close(throwOnError?: boolean): void;
    readonly filename: string;
  }
}
