/**
 * Ant Colony Optimizer for self-adaptive validation rule prioritization.
 *
 * Models rule selection as a graph traversal problem where pheromone trails
 * accumulate on effective rule sequences and evaporate over time, biasing
 * future selections toward high-yield validation paths.
 *
 * Usage:
 *   const aco = new AntColonyOptimizer(rules);
 *   const next = aco.selectNext(currentRule, candidateRules);
 *   aco.reinforce(appliedPath, qualityScore);
 */

export interface AcoConfig {
  /** Pheromone importance exponent (default: 1.0) */
  alpha?: number;
  /** Heuristic importance exponent (default: 2.0) */
  beta?: number;
  /** Pheromone evaporation rate per call to evaporate() 0–1 (default: 0.1) */
  evaporation?: number;
  /** Pheromone deposit multiplier (default: 1.0) */
  Q?: number;
  /** Initial pheromone level for unseen edges (default: 0.1) */
  initialPheromone?: number;
  /** Exploitation probability threshold for ε-greedy (default: 0.7) */
  exploitationRate?: number;
}

export class AntColonyOptimizer {
  private readonly alpha: number;
  private readonly beta: number;
  private readonly evaporationRate: number;
  private readonly Q: number;
  private readonly initialPheromone: number;
  private readonly exploitationRate: number;

  /**
   * Pheromone matrix: pheromones[from][to] = trail strength.
   * Stored as nested Map for sparse rule sets.
   */
  private readonly pheromones: Map<string, Map<string, number>> = new Map();

  /**
   * Heuristic desirability per rule (static, set at construction).
   * Defaults to 1.0 for all rules; can be updated via setHeuristic().
   */
  private readonly heuristics: Map<string, number> = new Map();

  constructor(rules: string[], config: AcoConfig = {}) {
    this.alpha = config.alpha ?? 1.0;
    this.beta = config.beta ?? 2.0;
    this.evaporationRate = config.evaporation ?? 0.1;
    this.Q = config.Q ?? 1.0;
    this.initialPheromone = config.initialPheromone ?? 0.1;
    this.exploitationRate = config.exploitationRate ?? 0.7;

    for (const rule of rules) {
      this.heuristics.set(rule, 1.0);
    }
  }

  // --- Public API ---

  /**
   * Select the next rule from candidates given the current rule context.
   * Balances exploitation (greedy best trail) with exploration (roulette wheel).
   *
   * @param current - Current rule node (empty string for start-of-sequence)
   * @param candidates - Available next rules to choose from
   * @returns Selected rule ID
   */
  selectNext(current: string, candidates: string[]): string {
    if (candidates.length === 0) {
      throw new Error('AntColonyOptimizer.selectNext: candidates must not be empty');
    }
    if (candidates.length === 1) {
      return candidates[0]!;
    }

    // ε-greedy: exploit with probability exploitationRate, else explore
    if (Math.random() < this.exploitationRate) {
      return this.greedySelect(current, candidates);
    }
    return this.rouletteWheelSelect(current, candidates);
  }

  /**
   * Reinforce pheromone trails along a completed path proportional to quality.
   * Call after evaluating how effective a rule sequence was.
   *
   * @param path - Ordered list of rule IDs that were applied
   * @param quality - Outcome quality score (higher = more pheromone deposited)
   */
  reinforce(path: string[], quality: number): void {
    if (path.length < 2 || quality <= 0) return;

    const deposit = this.Q * quality;
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i]!;
      const to = path[i + 1]!;
      const current = this.getPheromone(from, to);
      this.setPheromone(from, to, current + deposit);
    }
  }

  /**
   * Apply global pheromone evaporation across all trails.
   * Call once per optimization cycle to prevent trail saturation.
   */
  evaporate(): void {
    for (const [from, edges] of this.pheromones) {
      for (const [to, level] of edges) {
        const decayed = level * (1 - this.evaporationRate);
        // Clamp to initialPheromone floor to keep edges traversable
        edges.set(to, Math.max(decayed, this.initialPheromone));
      }
      this.pheromones.set(from, edges);
    }
  }

  /**
   * Update the static heuristic desirability for a rule.
   * Higher heuristic = more attractive when pheromone trails are equal.
   */
  setHeuristic(rule: string, value: number): void {
    if (value <= 0) throw new RangeError(`Heuristic must be positive, got ${value}`);
    this.heuristics.set(rule, value);
  }

  /** Get current pheromone level on edge from → to */
  getPheromone(from: string, to: string): number {
    return this.pheromones.get(from)?.get(to) ?? this.initialPheromone;
  }

  /** Snapshot of all pheromone trails for persistence / inspection */
  exportPheromones(): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};
    for (const [from, edges] of this.pheromones) {
      result[from] = {};
      for (const [to, level] of edges) {
        result[from]![to] = level;
      }
    }
    return result;
  }

  /** Restore pheromone trails from a prior snapshot */
  importPheromones(snapshot: Record<string, Record<string, number>>): void {
    this.pheromones.clear();
    for (const [from, edges] of Object.entries(snapshot)) {
      const edgeMap = new Map<string, number>();
      for (const [to, level] of Object.entries(edges)) {
        edgeMap.set(to, level);
      }
      this.pheromones.set(from, edgeMap);
    }
  }

  // --- Private helpers ---

  /** Greedy (exploitation): pick candidate with highest combined attractiveness */
  private greedySelect(current: string, candidates: string[]): string {
    let bestRule = candidates[0]!;
    let bestScore = -Infinity;

    for (const candidate of candidates) {
      const score = this.attractiveness(current, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestRule = candidate;
      }
    }
    return bestRule;
  }

  /**
   * Roulette wheel (exploration): probabilistic selection weighted by
   * combined pheromone and heuristic attractiveness.
   */
  private rouletteWheelSelect(current: string, candidates: string[]): string {
    const scores = candidates.map((c) => this.attractiveness(current, c));
    const total = scores.reduce((sum, s) => sum + s, 0);

    if (total === 0) {
      // Uniform fallback when all scores are zero
      return candidates[Math.floor(Math.random() * candidates.length)]!;
    }

    let threshold = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
      threshold -= scores[i]!;
      if (threshold <= 0) {
        return candidates[i]!;
      }
    }

    // Floating-point safety: return last candidate
    return candidates[candidates.length - 1]!;
  }

  /**
   * Combined attractiveness of moving from → to:
   *   τ(from,to)^α × η(to)^β
   */
  private attractiveness(from: string, to: string): number {
    const tau = this.getPheromone(from, to);
    const eta = this.heuristics.get(to) ?? 1.0;
    return Math.pow(tau, this.alpha) * Math.pow(eta, this.beta);
  }

  private setPheromone(from: string, to: string, level: number): void {
    let edges = this.pheromones.get(from);
    if (!edges) {
      edges = new Map();
      this.pheromones.set(from, edges);
    }
    edges.set(to, level);
  }
}
