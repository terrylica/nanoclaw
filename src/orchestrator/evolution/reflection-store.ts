/**
 * Lightweight feedback/trajectory memory store using bun:sqlite.
 *
 * Persists self-reflection entries from the evolution pipeline for:
 *   - Debugging what the system "thought" at each decision point
 *   - Building labelled trajectory datasets for future training
 *   - Correlating feedback signals (TP/FP) with prior reasoning
 *
 * Usage:
 *   addReflection('thought', 'triage:scan', 'Skipped low-confidence finding');
 *   addReflection('feedback', 'prompt:refine', 'User rejected suggestion', -1);
 *   const recent = getRecentReflections('thought', 20);
 */

import { Database } from 'bun:sqlite';
import path from 'path';

import { DATA_DIR } from '../../config.js';

// --- Types ---

export type ReflectionKind = 'thought' | 'feedback' | 'trajectory' | 'outcome';

export interface ReflectionEntry {
  id: number;
  kind: ReflectionKind;
  /** Short label for what was being evaluated (e.g. 'triage:scan', 'prompt:refine') */
  context: string;
  /** The reflection/thought text */
  content: string;
  /** Optional feedback signal in [-1, 1]: negative = bad, positive = good */
  score: number | null;
  createdAt: string;
}

// --- DB bootstrap ---

const DB_FILE = path.join(DATA_DIR, 'reflections.sqlite');

let _db: Database | null = null;

function getDb(): Database {
  if (_db) return _db;

  _db = new Database(DB_FILE, { create: true });
  _db.exec(`
    CREATE TABLE IF NOT EXISTS reflections (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT    NOT NULL,
      context    TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      score      REAL,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reflections_kind    ON reflections(kind);
    CREATE INDEX IF NOT EXISTS idx_reflections_created ON reflections(created_at);
  `);

  return _db;
}

// --- Public API ---

/** Append a reflection entry to the store and return the saved row. */
export function addReflection(
  kind: ReflectionKind,
  context: string,
  content: string,
  score?: number,
): ReflectionEntry {
  const db = getDb();
  const stmt = db.prepare<
    ReflectionEntry,
    [string, string, string, number | null]
  >(`
    INSERT INTO reflections (kind, context, content, score)
    VALUES (?, ?, ?, ?)
    RETURNING id, kind, context, content, score,
              created_at AS createdAt
  `);
  return stmt.get(kind, context, content, score ?? null)!;
}

/**
 * Retrieve the most recent reflections, optionally filtered by kind.
 * Results are ordered newest-first.
 */
export function getRecentReflections(
  kind?: ReflectionKind,
  limit = 50,
): ReflectionEntry[] {
  const db = getDb();

  if (kind !== undefined) {
    const stmt = db.prepare<ReflectionEntry, [string, number]>(`
      SELECT id, kind, context, content, score, created_at AS createdAt
      FROM reflections
      WHERE kind = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(kind, limit);
  }

  const stmt = db.prepare<ReflectionEntry, [number]>(`
    SELECT id, kind, context, content, score, created_at AS createdAt
    FROM reflections
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return stmt.all(limit);
}

/** Close the database connection (call on graceful shutdown). */
export function closeReflectionStore(): void {
  _db?.close();
  _db = null;
}
