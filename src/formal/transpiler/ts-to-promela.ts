import * as ts from 'typescript';
import * as fs from 'fs';

/** An extracted async function with its concurrency primitives */
export interface AsyncFunction {
  name: string;
  awaitCount: number;
  promiseAllSites: number;
  channelSends: string[];
  channelReceives: string[];
}

/** Result of transpiling a TypeScript file to a Promela model */
export interface TranspileResult {
  /** Raw Promela model source */
  promela: string;
  /** Extracted async functions */
  asyncFunctions: AsyncFunction[];
  /** Errors encountered during extraction */
  errors: string[];
}

/**
 * Transpiles TypeScript source to a Promela model suitable for SPIN verification.
 *
 * Extracts:
 * - `async` function declarations and arrow functions
 * - `await` expressions (modelled as synchronization points)
 * - `Promise.all(...)` calls (modelled as parallel proctypes)
 * - Channel send/receive patterns (`ch.send(...)` / `ch.recv(...)` or similar)
 */
export class TsToPromelaTranspiler {
  private readonly source: string;
  private readonly sourceFile: ts.SourceFile;

  constructor(source: string, fileName = 'input.ts') {
    this.source = source;
    this.sourceFile = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.ES2022,
      true,
    );
  }

  /** Convenience factory: read file from disk then construct transpiler */
  static fromFile(filePath: string): TsToPromelaTranspiler {
    const source = fs.readFileSync(filePath, 'utf8');
    return new TsToPromelaTranspiler(source, filePath);
  }

  /** Extract all async functions and their concurrency primitives */
  extractAsyncFunctions(): AsyncFunction[] {
    const results: AsyncFunction[] = [];
    this.visitNode(this.sourceFile, results, null);
    return results;
  }

  /** Transpile to a Promela model string */
  transpile(): TranspileResult {
    const asyncFunctions = this.extractAsyncFunctions();
    const errors: string[] = [];

    if (asyncFunctions.length === 0) {
      return {
        promela:
          '/* No async functions found — no Promela model generated */\n',
        asyncFunctions,
        errors,
      };
    }

    const lines: string[] = [];

    // Channel declarations inferred from send/receive sites
    const allChannels = new Set<string>();
    for (const fn of asyncFunctions) {
      for (const ch of [...fn.channelSends, ...fn.channelReceives]) {
        allChannels.add(ch);
      }
    }

    lines.push('/* Auto-generated Promela model from TypeScript source */');
    lines.push(
      '/* Verify with: spin -a model.pml && gcc -o pan pan.c && ./pan */',
    );
    lines.push('');

    for (const ch of allChannels) {
      lines.push(`chan ${sanitizeId(ch)} = [1] of { bit };`);
    }
    if (allChannels.size > 0) lines.push('');

    // One proctype per async function
    for (const fn of asyncFunctions) {
      lines.push(`proctype ${sanitizeId(fn.name)}() {`);

      // Model each await as a non-deterministic progress label
      for (let i = 0; i < fn.awaitCount; i++) {
        lines.push(`  /* await point ${i + 1} */`);
        lines.push(`  skip;`);
      }

      // Model Promise.all as inline parallel runs (approximated via atomic)
      for (let i = 0; i < fn.promiseAllSites; i++) {
        lines.push(
          `  /* Promise.all site ${i + 1} — parallel tasks complete atomically */`,
        );
        lines.push(`  atomic { skip };`);
      }

      // Channel sends
      for (const ch of fn.channelSends) {
        lines.push(`  ${sanitizeId(ch)} ! 1;   /* channel send */`);
      }

      // Channel receives
      for (const ch of fn.channelReceives) {
        lines.push(`  ${sanitizeId(ch)} ? _;   /* channel receive */`);
      }

      lines.push('}');
      lines.push('');
    }

    // init block runs all proctypes
    lines.push('init {');
    for (const fn of asyncFunctions) {
      lines.push(`  run ${sanitizeId(fn.name)}();`);
    }
    lines.push('}');
    lines.push('');

    return { promela: lines.join('\n'), asyncFunctions, errors };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private visitNode(
    node: ts.Node,
    results: AsyncFunction[],
    currentFn: AsyncFunction | null,
  ): void {
    const isAsyncFn = this.isAsyncFunctionNode(node);

    if (isAsyncFn) {
      const fn: AsyncFunction = {
        name: this.getFunctionName(node),
        awaitCount: 0,
        promiseAllSites: 0,
        channelSends: [],
        channelReceives: [],
      };
      results.push(fn);
      // Recurse with this function as context
      ts.forEachChild(node, (child: ts.Node) =>
        this.visitNode(child, results, fn),
      );
      return;
    }

    if (currentFn !== null) {
      // Count await expressions
      if (ts.isAwaitExpression(node)) {
        currentFn.awaitCount++;
        // Check if the awaited expression is Promise.all(...)
        if (this.isPromiseAllCall(node.expression)) {
          currentFn.promiseAllSites++;
        }
      }

      // Detect channel-like calls: x.send(...) / x.recv(...) / x.receive(...)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const prop = node.expression.name.text;
        const obj = node.expression.expression.getText(this.sourceFile);
        if (prop === 'send' || prop === 'write' || prop === 'push') {
          currentFn.channelSends.push(obj);
        } else if (prop === 'recv' || prop === 'receive' || prop === 'read') {
          currentFn.channelReceives.push(obj);
        }
      }
    }

    ts.forEachChild(node, (child: ts.Node) =>
      this.visitNode(child, results, currentFn),
    );
  }

  private isAsyncFunctionNode(node: ts.Node): boolean {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const mods = ts.canHaveModifiers(node)
        ? ts.getModifiers(node)
        : undefined;
      return (
        mods?.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.AsyncKeyword) ??
        false
      );
    }
    return false;
  }

  private getFunctionName(node: ts.Node): string {
    if (ts.isFunctionDeclaration(node) && node.name) {
      return node.name.text;
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      return node.name.text;
    }
    if (
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
    ) {
      return node.parent.name.text;
    }
    if (
      ts.isPropertyDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
    ) {
      return node.parent.name.text;
    }
    // Fallback: use source position for uniqueness
    return `anon_${node.getStart(this.sourceFile)}`;
  }

  private isPromiseAllCall(node: ts.Node): boolean {
    return (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Promise' &&
      node.expression.name.text === 'all'
    );
  }
}

/** Make an identifier safe for Promela (alphanumeric + underscore, starts with letter) */
function sanitizeId(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[0-9]/.test(cleaned) ? `fn_${cleaned}` : cleaned || 'unknown';
}
