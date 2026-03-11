/**
 * Pinecone vector database client for 768-dimensional code embeddings.
 * Uses the Pinecone REST API directly (no SDK dependency).
 */

export interface VectorRecord {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
}

export interface QueryMatch {
  id: string;
  score: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface QueryResult {
  matches: QueryMatch[];
}

const EMBEDDING_DIMENSION = 768;

export class PineconeVectorDB {
  private readonly apiKey: string;
  private readonly indexHost: string;
  private readonly namespace: string;

  constructor(params: {
    apiKey: string;
    indexHost: string;
    namespace?: string;
  }) {
    this.apiKey = params.apiKey;
    this.indexHost = params.indexHost.replace(/\/$/, '');
    this.namespace = params.namespace ?? 'default';
  }

  static fromEnv(namespace?: string): PineconeVectorDB {
    const apiKey = process.env['PINECONE_API_KEY'];
    const indexHost = process.env['PINECONE_INDEX_HOST'];
    if (!apiKey)
      throw new Error('PINECONE_API_KEY environment variable is not set');
    if (!indexHost)
      throw new Error('PINECONE_INDEX_HOST environment variable is not set');
    return new PineconeVectorDB({ apiKey, indexHost, namespace });
  }

  private headers(): Record<string, string> {
    return {
      'Api-Key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.indexHost}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Pinecone ${method} ${path} failed (${res.status}): ${text}`,
      );
    }
    return res.json() as Promise<T>;
  }

  /**
   * Upsert vectors into Pinecone. Each vector must have exactly 768 dimensions.
   */
  async upsert(vectors: VectorRecord[]): Promise<void> {
    if (vectors.length === 0) return;
    for (const v of vectors) {
      if (v.values.length !== EMBEDDING_DIMENSION) {
        throw new Error(
          `Vector "${v.id}" has ${v.values.length} dimensions, expected ${EMBEDDING_DIMENSION}`,
        );
      }
    }
    await this.request<unknown>('/vectors/upsert', 'POST', {
      vectors,
      namespace: this.namespace,
    });
  }

  /**
   * Delete vectors by ID from Pinecone.
   */
  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.request<unknown>('/vectors/delete', 'POST', {
      ids,
      namespace: this.namespace,
    });
  }

  /**
   * Query Pinecone for the top-k nearest neighbours to the given 768-dim vector.
   */
  async query(params: {
    vector: number[];
    topK: number;
    includeMetadata?: boolean;
    filter?: Record<string, unknown>;
  }): Promise<QueryResult> {
    if (params.vector.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `Query vector has ${params.vector.length} dimensions, expected ${EMBEDDING_DIMENSION}`,
      );
    }
    return this.request<QueryResult>('/query', 'POST', {
      vector: params.vector,
      topK: params.topK,
      namespace: this.namespace,
      includeMetadata: params.includeMetadata ?? true,
      ...(params.filter ? { filter: params.filter } : {}),
    });
  }
}
