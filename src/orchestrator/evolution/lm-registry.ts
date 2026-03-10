/**
 * LanguageModelRegistry<T>: DSPy-inspired registry for managing multiple LM
 * providers with runtime swapping.
 *
 * Usage:
 *   const registry = new LanguageModelRegistry<MiniMaxLM>();
 *   registry.register(new MiniMaxLM({ apiKey: '...' })).setDefault('minimax');
 *   const lm = registry.getDefault();
 *   const response = await lm.complete({ userMessage: 'Hello' });
 */

import { fetchWithTimeout } from '../minimax-client.js';
import { MINIMAX_BASE_URL, MINIMAX_MODEL } from '../types.js';

// --- Core interfaces ---

export interface LMRequest {
  userMessage: string;
  systemPrompt?: string;
  maxTokens?: number;
}

export interface LMResponse {
  text: string;
}

export interface LanguageModel {
  readonly name: string;
  complete(request: LMRequest): Promise<LMResponse>;
}

// --- LanguageModelRegistry ---

export class LanguageModelRegistry<T extends LanguageModel> {
  private readonly _providers = new Map<string, T>();
  private _defaultName?: string;

  /** Register a provider. Uses provider.name as the key. */
  register(provider: T): this {
    this._providers.set(provider.name, provider);
    return this;
  }

  /** Set the default provider by name. Throws if not registered. */
  setDefault(name: string): this {
    if (!this._providers.has(name)) {
      throw new Error(`LanguageModelRegistry: unknown provider '${name}'`);
    }
    this._defaultName = name;
    return this;
  }

  /** Get a provider by name. Throws if not registered. */
  get(name: string): T {
    const provider = this._providers.get(name);
    if (!provider) {
      throw new Error(`LanguageModelRegistry: unknown provider '${name}'`);
    }
    return provider;
  }

  /** Get the default provider. Throws if no default is set. */
  getDefault(): T {
    if (!this._defaultName) {
      throw new Error('LanguageModelRegistry: no default provider set');
    }
    return this.get(this._defaultName);
  }

  /** List registered provider names. */
  list(): string[] {
    return Array.from(this._providers.keys());
  }

  /** Whether a provider is registered under the given name. */
  has(name: string): boolean {
    return this._providers.has(name);
  }
}

// --- MiniMax provider ---

export interface MiniMaxLMConfig {
  apiKey: string;
  timeoutMs?: number;
}

export class MiniMaxLM implements LanguageModel {
  readonly name = 'minimax';
  private readonly _apiKey: string;
  private readonly _timeoutMs: number;

  constructor(config: MiniMaxLMConfig) {
    this._apiKey = config.apiKey;
    this._timeoutMs = config.timeoutMs ?? 60_000;
  }

  async complete(request: LMRequest): Promise<LMResponse> {
    const body: Record<string, unknown> = {
      model: MINIMAX_MODEL,
      max_tokens: request.maxTokens ?? 4096,
      messages: [{ role: 'user', content: request.userMessage }],
    };
    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    const response = await fetchWithTimeout(
      `${MINIMAX_BASE_URL}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this._apiKey,
          'anthropic-version': '2024-10-22',
        },
        body: JSON.stringify(body),
      },
      this._timeoutMs,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`MiniMaxLM API ${response.status}: ${text.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = data.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join('');

    return { text };
  }
}
