/**
 * IssueChunker: semantic clustering of code issues following Miller's Law.
 *
 * Groups issues by category → file → related issues.
 * Limits: max 5 items per chunk, max cognitive load 7 per chunk.
 */
import type { Finding } from '../orchestrator/types.js';

export interface IssueChunk {
  category: Finding['type'];
  primaryFile: string;
  items: Finding[];
  cognitiveLoad: number;
}

const MAX_CHUNK_SIZE = 5;
const MAX_COGNITIVE_LOAD = 7;

/** Estimate cognitive load for a finding (1–3 based on severity). */
function findingLoad(finding: Finding): number {
  switch (finding.severity) {
    case 'critical':
      return 3;
    case 'high':
      return 2;
    default:
      return 1;
  }
}

/** Pick the most representative file for a finding. */
function primaryFile(finding: Finding): string {
  return finding.files[0] ?? '(unknown)';
}

export class IssueChunker {
  /**
   * Cluster findings into semantically coherent chunks.
   * Groups by category first, then by primary file, respecting size and
   * cognitive-load limits (Miller's Law: 7 ± 2 items in working memory).
   */
  chunk(findings: Finding[]): IssueChunk[] {
    // Group by category → primaryFile
    const byCategory = new Map<Finding['type'], Map<string, Finding[]>>();

    for (const finding of findings) {
      const category = finding.type;
      if (!byCategory.has(category)) {
        byCategory.set(category, new Map());
      }
      const byFile = byCategory.get(category)!;
      const file = primaryFile(finding);
      if (!byFile.has(file)) {
        byFile.set(file, []);
      }
      byFile.get(file)!.push(finding);
    }

    const chunks: IssueChunk[] = [];

    for (const [category, byFile] of byCategory) {
      for (const [file, items] of byFile) {
        // Split items into sub-chunks respecting size and cognitive load limits
        let current: Finding[] = [];
        let currentLoad = 0;

        for (const item of items) {
          const load = findingLoad(item);
          const wouldExceedSize = current.length >= MAX_CHUNK_SIZE;
          const wouldExceedLoad = currentLoad + load > MAX_COGNITIVE_LOAD;

          if (current.length > 0 && (wouldExceedSize || wouldExceedLoad)) {
            chunks.push({
              category,
              primaryFile: file,
              items: current,
              cognitiveLoad: currentLoad,
            });
            current = [];
            currentLoad = 0;
          }

          current.push(item);
          currentLoad += load;
        }

        if (current.length > 0) {
          chunks.push({
            category,
            primaryFile: file,
            items: current,
            cognitiveLoad: currentLoad,
          });
        }
      }
    }

    return chunks;
  }
}
