/**
 * EmbeddingService: semantic code similarity search using xenova-transformers
 * and a cosine-similarity flat index (768-dimensional vector space).
 *
 * Uses Xenova/codebert-base for feature extraction. hnswlib-node is not a
 * declared dependency, so similarity search is implemented as a brute-force
 * cosine scan, which is sufficient for small-to-medium corpora.
 */

import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';

const MODEL = 'Xenova/codebert-base';
const DIMENSION = 768;

export interface SimilarityResult {
  id: string;
  score: number;
  metadata?: Record<string, string | number | boolean>;
}

interface IndexEntry {
  id: string;
  vector: Float32Array;
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Mean-pool a 2-D tensor output (tokens × hidden) into a single 768-dim vector.
 */
function meanPool(
  data: Float32Array,
  tokenCount: number,
  hiddenSize: number,
): Float32Array {
  const result = new Float32Array(hiddenSize);
  for (let t = 0; t < tokenCount; t++) {
    const offset = t * hiddenSize;
    for (let h = 0; h < hiddenSize; h++) {
      result[h] += data[offset + h];
    }
  }
  for (let h = 0; h < hiddenSize; h++) {
    result[h] /= tokenCount;
  }
  return result;
}

/** Normalise a vector in-place (L2). */
function normalise(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** Cosine similarity between two already-normalised vectors. */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export class EmbeddingService {
  private extractor: FeatureExtractionPipeline | null = null;
  private index: IndexEntry[] = [];

  /** Lazily initialise the transformers pipeline. */
  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      this.extractor = (await pipeline(
        'feature-extraction',
        MODEL,
      )) as FeatureExtractionPipeline;
    }
    return this.extractor;
  }

  /**
   * Embed a text snippet into a 768-dimensional normalised vector.
   */
  async embed(text: string): Promise<Float32Array> {
    const extractor = await this.getExtractor();
    // Output shape: [1, tokenCount, hiddenSize]
    const output = await extractor(text, { pooling: 'none' });
    const raw = output.data as Float32Array;
    const tokenCount = output.dims[1] as number;
    const hiddenSize = output.dims[2] as number;

    if (hiddenSize !== DIMENSION) {
      throw new Error(
        `Expected hidden size ${DIMENSION} but got ${hiddenSize} from ${MODEL}`,
      );
    }

    return normalise(meanPool(raw, tokenCount, hiddenSize));
  }

  /**
   * Add a text entry to the in-memory cosine index.
   */
  async add(
    id: string,
    text: string,
    metadata?: Record<string, string | number | boolean>,
  ): Promise<void> {
    const vector = await this.embed(text);
    // Replace if id already exists
    const existing = this.index.findIndex((e) => e.id === id);
    if (existing !== -1) {
      this.index[existing] = { id, vector, metadata };
    } else {
      this.index.push({ id, vector, metadata });
    }
  }

  /**
   * Remove an entry from the index by id.
   */
  remove(id: string): void {
    this.index = this.index.filter((e) => e.id !== id);
  }

  /**
   * Query the index for the top-k most similar entries to the given text.
   */
  async query(text: string, topK: number = 5): Promise<SimilarityResult[]> {
    if (this.index.length === 0) return [];

    const queryVec = await this.embed(text);

    const scored = this.index.map((entry) => ({
      id: entry.id,
      score: cosineSimilarity(queryVec, entry.vector),
      metadata: entry.metadata,
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Return the number of entries in the index. */
  get size(): number {
    return this.index.length;
  }

  /** Clear all entries from the index. */
  clear(): void {
    this.index = [];
  }
}
