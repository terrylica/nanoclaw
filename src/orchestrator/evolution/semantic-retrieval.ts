/**
 * Semantic retrieval over past reflections using bge-small-en-v1.5 embeddings
 * loaded via the ONNX runtime bundled in @xenova/transformers.
 *
 * The module maintains a `semantic_embeddings` table in the same SQLite file as
 * the reflection store.  Entries are linked by `reflection_id` so that they can
 * be joined on demand.
 *
 * Usage:
 *   await indexReflection(entry.id, entry.content);
 *   const hits = await semanticRetrieve('prompt refinement succeeded', 5);
 */

import { Database } from 'bun:sqlite';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { type ReflectionEntry } from './reflection-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SemanticHit {
  reflection: ReflectionEntry;
  score: number; // cosine similarity [0, 1]
}

// ---------------------------------------------------------------------------
// ONNX / model loading  (lazy – model is fetched on first use)
// ---------------------------------------------------------------------------

// `@xenova/transformers` ships its own ONNX runtime; the `pipeline` helper
// returns a callable that accepts text and options.
type EmbeddingPipeline = (
  texts: string | string[],
  opts?: { pooling: string; normalize: boolean },
) => Promise<{ data: Float32Array }>;

let _pipeline: EmbeddingPipeline | null = null;

async function getEmbeddingPipeline(): Promise<EmbeddingPipeline> {
  if (_pipeline) return _pipeline;

  // Dynamic import keeps startup cost zero when semantic retrieval is unused.
  const { pipeline } = await import('@xenova/transformers');
  _pipeline = (await pipeline(
    'feature-extraction',
    'Xenova/bge-small-en-v1.5',
  )) as unknown as EmbeddingPipeline;
  return _pipeline;
}

/** Embed a single string → Float32Array (384-dim, L2-normalised). */
async function embed(text: string): Promise<Float32Array> {
  const pipe = await getEmbeddingPipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return output.data;
}

// ---------------------------------------------------------------------------
// SQLite helpers
// ---------------------------------------------------------------------------

const DB_FILE = path.join(DATA_DIR, 'reflections.sqlite');

let _db: Database | null = null;

function getDb(): Database {
  if (_db) return _db;

  _db = new Database(DB_FILE, { create: true });
  _db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_embeddings (
      reflection_id INTEGER PRIMARY KEY REFERENCES reflections(id) ON DELETE CASCADE,
      embedding     BLOB NOT NULL
    );
  `);

  return _db;
}

function serializeVector(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

function deserializeVector(blob: Uint8Array): Float32Array {
  // bun:sqlite may return a Buffer; ensure we read it as Float32Array
  const buf =
    blob instanceof Uint8Array ? blob : new Uint8Array(blob as ArrayBufferLike);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/** Cosine similarity of two pre-normalised vectors (dot product). */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are already L2-normalised
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate and store an embedding for `reflectionId`.
 * Safe to call multiple times – existing entries are replaced (UPSERT).
 */
export async function indexReflection(
  reflectionId: number,
  text: string,
): Promise<void> {
  const vector = await embed(text);
  const db = getDb();
  const stmt = db.prepare<void, [number, Uint8Array]>(`
    INSERT OR REPLACE INTO semantic_embeddings (reflection_id, embedding)
    VALUES (?, ?)
  `);
  stmt.run(reflectionId, serializeVector(vector));
}

/**
 * Return the `limit` most semantically similar past reflections for `query`.
 *
 * Only reflections that have been indexed (via `indexReflection`) are
 * considered.  Scoring is done in-process with cosine similarity; this is
 * fast enough for the expected table size (< 10 k rows).
 */
export async function semanticRetrieve(
  query: string,
  limit = 5,
): Promise<SemanticHit[]> {
  const db = getDb();

  // Fetch all stored embeddings with their parent reflection in one join.
  const rows = db
    .prepare<
      {
        id: number;
        kind: string;
        context: string;
        content: string;
        score: number | null;
        createdAt: string;
        embedding: Uint8Array;
      },
      []
    >(
      `
      SELECT r.id, r.kind, r.context, r.content, r.score,
             r.created_at AS createdAt, e.embedding
      FROM   reflections r
      JOIN   semantic_embeddings e ON e.reflection_id = r.id
    `,
    )
    .all();

  if (rows.length === 0) return [];

  const queryVec = await embed(query);

  const scored = rows.map((row) => {
    const vec = deserializeVector(row.embedding);
    const sim = cosineSimilarity(queryVec, vec);
    const reflection: ReflectionEntry = {
      id: row.id,
      kind: row.kind as ReflectionEntry['kind'],
      context: row.context,
      content: row.content,
      score: row.score,
      createdAt: row.createdAt,
    };
    return { reflection, score: sim };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Close the embeddings database connection (call on graceful shutdown). */
export function closeSemanticStore(): void {
  _db?.close();
  _db = null;
}
