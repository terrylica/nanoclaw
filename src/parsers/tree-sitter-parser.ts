import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface QueryMatch {
  /** The capture name (without leading @) */
  capture: string;
  /** The matched source text */
  text: string;
  /** Start position [row, column] */
  start: [number, number];
  /** End position [row, column] */
  end: [number, number];
}

export interface ParseResult {
  /** Whether parsing succeeded without errors */
  success: boolean;
  /** Raw S-expression AST string from tree-sitter parse */
  ast: string;
  /** Any parse errors reported by tree-sitter */
  errors: string[];
}

export interface QueryResult {
  /** Whether the query executed successfully */
  success: boolean;
  /** Matched captures */
  matches: QueryMatch[];
  /** Error message if query failed */
  error?: string;
}

/**
 * Checks if the tree-sitter CLI is available on PATH.
 */
export function isTreeSitterAvailable(): boolean {
  const result = spawnSync('tree-sitter', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

/**
 * Parses a TypeScript or TSX file using the tree-sitter CLI.
 *
 * Requires `tree-sitter` CLI and `tree-sitter-typescript` grammar to be installed.
 * Returns the S-expression AST and any ERROR nodes found in the tree.
 */
export function parseFile(filePath: string): ParseResult {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    return { success: false, ast: '', errors: [`File not found: ${absPath}`] };
  }

  let ast: string;
  try {
    ast = execSync(`tree-sitter parse ${JSON.stringify(absPath)}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, ast: '', errors: [message] };
  }

  // tree-sitter parse exits 0 even with ERROR nodes; detect them in output
  const errorLines = ast
    .split('\n')
    .filter((line) => line.includes('(ERROR') || line.includes('(MISSING'));

  return {
    success: errorLines.length === 0,
    ast,
    errors: errorLines,
  };
}

/**
 * Runs a tree-sitter query against a TypeScript/TSX file.
 *
 * @param filePath - Path to the .ts or .tsx source file
 * @param queryPattern - A tree-sitter query string, e.g. `(import_statement) @import`
 * @returns QueryResult with matched captures
 */
export function runQuery(filePath: string, queryPattern: string): QueryResult {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    return { success: false, matches: [], error: `File not found: ${absPath}` };
  }

  // Write the query to a temp file so we avoid shell quoting issues
  const tmpQuery = path.join(os.tmpdir(), `ts-query-${process.pid}.scm`);
  try {
    fs.writeFileSync(tmpQuery, queryPattern, 'utf8');

    let output: string;
    try {
      output = execSync(
        `tree-sitter query ${JSON.stringify(tmpQuery)} ${JSON.stringify(absPath)}`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, matches: [], error: message };
    }

    return { success: true, matches: parseQueryOutput(output) };
  } finally {
    try {
      fs.unlinkSync(tmpQuery);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Parses the text output of `tree-sitter query` into structured QueryMatch objects.
 *
 * The CLI emits blocks like:
 * ```
 *   pattern: 0
 *     capture: @import
 *       import_statement [0, 0] - [0, 34]
 *         ...
 * ```
 * We extract the capture name and position from these blocks.
 */
function parseQueryOutput(output: string): QueryMatch[] {
  const matches: QueryMatch[] = [];
  const lines = output.split('\n');

  let currentCapture: string | null = null;

  for (const line of lines) {
    // Capture name line: "    capture: @foo"
    const captureMatch = line.match(/^\s+capture:\s+@(\S+)/);
    if (captureMatch) {
      currentCapture = captureMatch[1];
      continue;
    }

    // Node position line: "      node_type [row, col] - [row, col]"
    // Also handles: "        text: \"...\""
    if (currentCapture !== null) {
      const posMatch = line.match(
        /\[(\d+),\s*(\d+)\]\s*-\s*\[(\d+),\s*(\d+)\]/,
      );
      if (posMatch) {
        // Extract the text fragment between the position markers if present
        const textMatch = line.match(/^\s+\S.*?\[.*\]\s*-\s*\[.*\]\s*(.*)?$/);
        const text = textMatch?.[1]?.trim() ?? '';
        matches.push({
          capture: currentCapture,
          text,
          start: [parseInt(posMatch[1], 10), parseInt(posMatch[2], 10)],
          end: [parseInt(posMatch[3], 10), parseInt(posMatch[4], 10)],
        });
        currentCapture = null;
      }
    }
  }

  return matches;
}

/**
 * Convenience: find all import statements in a TypeScript/TSX file.
 */
export function findImports(filePath: string): QueryResult {
  return runQuery(filePath, '(import_statement) @import');
}

/**
 * Convenience: find all function/method declarations in a TypeScript/TSX file.
 */
export function findFunctions(filePath: string): QueryResult {
  return runQuery(
    filePath,
    [
      '(function_declaration name: (identifier) @fn)',
      '(method_definition name: (property_identifier) @fn)',
      '(arrow_function) @fn',
    ].join('\n'),
  );
}
