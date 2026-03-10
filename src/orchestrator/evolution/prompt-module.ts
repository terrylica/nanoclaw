/**
 * Declarative PromptModule class for composing prompt templates with typed input/output schemas.
 *
 * Usage:
 *   const mod = new PromptModule({
 *     id: 'my-prompt',
 *     systemPrompt: 'You are a helpful assistant.',
 *     userTemplate: 'Analyze: {{code}}',
 *     parseOutput: (text) => ({ summary: text }),
 *   });
 *   const rendered = mod.render({ code: 'console.log(x)' });
 *   const result = mod.parse(rawLlmText);
 */

import type { PromptEntry, PromptMetrics } from './prompt-registry.js';

// --- Types ---

/** Typed input record: keys are template variable names, values are strings */
export type PromptInputs = Record<string, string>;

/** Options for constructing a PromptModule */
export interface PromptModuleOptions<TInput extends PromptInputs, TOutput> {
  id: string;
  name?: string;
  version?: number;
  systemPrompt: string;
  /** Template string with {{variable}} placeholders matching keys of TInput */
  userTemplate: string;
  /** Parse raw LLM text into typed output */
  parseOutput: (raw: string) => TOutput;
}

/** Rendered prompt ready to send to an LLM */
export interface RenderedPrompt {
  system: string;
  user: string;
}

// --- PromptModule class ---

export class PromptModule<TInput extends PromptInputs, TOutput> {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly systemPrompt: string;
  readonly userTemplate: string;
  private readonly _parseOutput: (raw: string) => TOutput;

  constructor(options: PromptModuleOptions<TInput, TOutput>) {
    this.id = options.id;
    this.name = options.name ?? options.id;
    this.version = options.version ?? 1;
    this.systemPrompt = options.systemPrompt;
    this.userTemplate = options.userTemplate;
    this._parseOutput = options.parseOutput;
  }

  /**
   * Render the user template by substituting {{key}} placeholders with input values.
   * Throws if a required placeholder has no corresponding input key.
   */
  render(inputs: TInput): RenderedPrompt {
    const user = this.userTemplate.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      if (!(key in inputs)) {
        throw new Error(
          `PromptModule '${this.id}': missing required input '${key}'`,
        );
      }
      return inputs[key];
    });
    return { system: this.systemPrompt, user };
  }

  /** Parse raw LLM response text into typed output */
  parse(raw: string): TOutput {
    return this._parseOutput(raw);
  }

  /**
   * Convert to a PromptEntry for compatibility with the prompt registry.
   * Metrics are initialised to zero so the entry can be seeded or tracked.
   */
  toPromptEntry(): PromptEntry {
    const metrics: PromptMetrics = {
      uses: 0,
      tpCount: 0,
      fpCount: 0,
      avgConfidence: 0,
      lastUsed: '',
    };
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      systemPrompt: this.systemPrompt,
      userPromptTemplate: this.userTemplate,
      metrics,
    };
  }

  /**
   * Create a PromptModule from an existing PromptEntry (e.g. loaded from YAML).
   * A generic passthrough parser is used unless overridden.
   */
  static fromPromptEntry(
    entry: PromptEntry,
    parseOutput?: (raw: string) => string,
  ): PromptModule<PromptInputs, string> {
    return new PromptModule<PromptInputs, string>({
      id: entry.id,
      name: entry.name,
      version: entry.version,
      systemPrompt: entry.systemPrompt,
      userTemplate: entry.userPromptTemplate,
      parseOutput: parseOutput ?? ((raw) => raw),
    });
  }
}
