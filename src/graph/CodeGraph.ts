/**
 * CodeGraph: module dependency graph with graph-theoretic prioritization.
 */

export interface Module {
  id: string;
  path: string;
  dependencies: string[];
}

export interface ModuleMetrics {
  moduleId: string;
  betweennessCentrality: number;
  pagerank: number;
  compositeScore: number;
}

export interface ValidationResult {
  moduleId: string;
  valid: boolean;
  errors: string[];
}

export class CodeGraph {
  private modules: Map<string, Module> = new Map();

  addModule(module: Module): void {
    this.modules.set(module.id, module);
  }

  getModules(): Module[] {
    return Array.from(this.modules.values());
  }

  /**
   * Compute betweenness centrality for all modules using Brandes' algorithm.
   * Returns a map of moduleId -> betweenness score (normalized by (n-1)(n-2)/2).
   */
  private computeBetweennessCentrality(): Map<string, number> {
    const ids = Array.from(this.modules.keys());
    const n = ids.length;
    const centrality = new Map<string, number>(ids.map((id) => [id, 0]));

    if (n < 2) return centrality;

    for (const s of ids) {
      const stack: string[] = [];
      const pred = new Map<string, string[]>(ids.map((id) => [id, []]));
      const sigma = new Map<string, number>(ids.map((id) => [id, 0]));
      sigma.set(s, 1);
      const dist = new Map<string, number>(ids.map((id) => [id, -1]));
      dist.set(s, 0);

      const queue: string[] = [s];
      while (queue.length > 0) {
        const v = queue.shift()!;
        stack.push(v);
        const mod = this.modules.get(v);
        if (!mod) continue;
        for (const w of mod.dependencies) {
          if (!this.modules.has(w)) continue;
          if (dist.get(w) === -1) {
            queue.push(w);
            dist.set(w, (dist.get(v) ?? 0) + 1);
          }
          if (dist.get(w) === (dist.get(v) ?? 0) + 1) {
            sigma.set(w, (sigma.get(w) ?? 0) + (sigma.get(v) ?? 0));
            pred.get(w)!.push(v);
          }
        }
      }

      const delta = new Map<string, number>(ids.map((id) => [id, 0]));
      while (stack.length > 0) {
        const w = stack.pop()!;
        for (const v of pred.get(w) ?? []) {
          const sigmaV = sigma.get(v) ?? 1;
          const sigmaW = sigma.get(w) ?? 1;
          const deltaV = delta.get(v) ?? 0;
          const deltaW = delta.get(w) ?? 0;
          delta.set(v, deltaV + (sigmaV / sigmaW) * (1 + deltaW));
        }
        if (w !== s) {
          centrality.set(w, (centrality.get(w) ?? 0) + (delta.get(w) ?? 0));
        }
      }
    }

    // Normalize: divide by (n-1)(n-2)/2 for directed graphs
    const normFactor = (n - 1) * (n - 2);
    if (normFactor > 0) {
      for (const [id, score] of centrality) {
        centrality.set(id, score / normFactor);
      }
    }

    return centrality;
  }

  /**
   * Compute PageRank for all modules using the power iteration method.
   * Damping factor d = 0.85, 100 iterations.
   */
  private computePageRank(
    dampingFactor = 0.85,
    iterations = 100,
  ): Map<string, number> {
    const ids = Array.from(this.modules.keys());
    const n = ids.length;
    if (n === 0) return new Map();

    const rank = new Map<string, number>(ids.map((id) => [id, 1 / n]));
    const outDegree = new Map<string, number>();

    for (const mod of this.modules.values()) {
      const validDeps = mod.dependencies.filter((d) => this.modules.has(d));
      outDegree.set(mod.id, validDeps.length);
    }

    for (let i = 0; i < iterations; i++) {
      const newRank = new Map<string, number>(ids.map((id) => [id, 0]));

      for (const mod of this.modules.values()) {
        const validDeps = mod.dependencies.filter((d) => this.modules.has(d));
        const out = outDegree.get(mod.id) ?? 0;
        if (out === 0) {
          // Dangling node: distribute equally
          const contribution = (rank.get(mod.id) ?? 0) / n;
          for (const id of ids) {
            newRank.set(id, (newRank.get(id) ?? 0) + contribution);
          }
        } else {
          const contribution = (rank.get(mod.id) ?? 0) / out;
          for (const dep of validDeps) {
            newRank.set(dep, (newRank.get(dep) ?? 0) + contribution);
          }
        }
      }

      for (const id of ids) {
        rank.set(
          id,
          (1 - dampingFactor) / n + dampingFactor * (newRank.get(id) ?? 0),
        );
      }
    }

    return rank;
  }

  /**
   * Compute composite metrics (betweenness centrality + pagerank) for all modules.
   * The composite score is the average of the two normalized scores.
   */
  computeModuleMetrics(): ModuleMetrics[] {
    const betweenness = this.computeBetweennessCentrality();
    const pagerank = this.computePageRank();

    const metrics: ModuleMetrics[] = [];
    for (const id of this.modules.keys()) {
      const bc = betweenness.get(id) ?? 0;
      const pr = pagerank.get(id) ?? 0;
      metrics.push({
        moduleId: id,
        betweennessCentrality: bc,
        pagerank: pr,
        compositeScore: (bc + pr) / 2,
      });
    }

    return metrics;
  }

  /**
   * Sort modules by betweenness centrality + pagerank composite score (descending)
   * and run validations in that priority order.
   *
   * High-centrality modules are validated first because they represent the most
   * critical nodes in the dependency graph — failures there have the largest blast radius.
   */
  validatePrioritization(
    validate: (module: Module) => ValidationResult,
  ): ValidationResult[] {
    const metrics = this.computeModuleMetrics();
    metrics.sort((a, b) => b.compositeScore - a.compositeScore);

    const results: ValidationResult[] = [];
    for (const { moduleId } of metrics) {
      const module = this.modules.get(moduleId);
      if (!module) continue;
      results.push(validate(module));
    }

    return results;
  }
}
