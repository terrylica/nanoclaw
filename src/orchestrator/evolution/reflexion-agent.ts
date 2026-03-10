/**
 * ReflexionAgent: evaluates recent task outcomes and stores verbal feedback.
 *
 * Inspired by Reflexion (Shinn et al., 2023) — the agent generates a verbal
 * self-evaluation after each task, which is persisted in the reflection store
 * and can inform subsequent evolution steps.
 *
 * Usage:
 *   const agent = new ReflexionAgent('prompt:refine');
 *   const entry = await agent.reflect(outcomes);
 */

import {
  addReflection,
  getRecentReflections,
  type ReflectionEntry,
} from './reflection-store.js';

// --- Types ---

export interface TaskOutcome {
  /** Short label for the task (e.g. 'goal-fix', 'prompt-refine') */
  task: string;
  /** Whether the task succeeded */
  success: boolean;
  /** Optional detail about what happened */
  detail?: string;
}

// --- ReflexionAgent ---

export class ReflexionAgent {
  /**
   * @param context Short label applied to all reflections from this agent
   *   (e.g. 'evolution:cycle', 'prompt:refine')
   */
  constructor(private readonly context: string) {}

  /**
   * Evaluate a batch of task outcomes and store a verbal feedback entry.
   *
   * The verbal feedback summarises successes and failures and assigns a
   * numeric score in [-1, 1] proportional to the success rate.
   *
   * @returns The persisted ReflectionEntry
   */
  reflect(outcomes: TaskOutcome[]): ReflectionEntry {
    if (outcomes.length === 0) {
      return addReflection(
        'feedback',
        this.context,
        'No outcomes to reflect on.',
        null as unknown as number,
      );
    }

    const successes = outcomes.filter((o) => o.success);
    const failures = outcomes.filter((o) => !o.success);
    const score = (successes.length - failures.length) / outcomes.length;

    const lines: string[] = [];

    if (successes.length > 0) {
      lines.push(
        `Succeeded (${successes.length}): ${successes.map((o) => o.task + (o.detail ? ` — ${o.detail}` : '')).join('; ')}.`,
      );
    }
    if (failures.length > 0) {
      lines.push(
        `Failed (${failures.length}): ${failures.map((o) => o.task + (o.detail ? ` — ${o.detail}` : '')).join('; ')}.`,
      );
    }

    const verdict =
      score >= 0
        ? 'Overall positive result.'
        : 'Overall negative result — adjustments needed.';
    lines.push(verdict);

    const content = lines.join(' ');
    return addReflection('feedback', this.context, content, score);
  }

  /**
   * Retrieve recent reflections for this agent's context.
   * Returns newest-first, up to `limit` entries.
   */
  recentFeedback(limit = 20): ReflectionEntry[] {
    return getRecentReflections('feedback', limit).filter(
      (e) => e.context === this.context,
    );
  }
}
