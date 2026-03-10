/**
 * Multi-repo expansion: discover and score repos for monitoring.
 *
 * Scans ~/eon/ for repos, scores by activity and relevance,
 * proposes new repos for NanoClaw monitoring.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// --- Constants ---

const EON_DIR = path.join(os.homedir(), 'eon');

// --- Types ---

export interface RepoCandidate {
  path: string;
  name: string;
  lastCommitDate: string;
  commitCount30d: number;
  languages: string[];
  score: number;
}

// --- Discovery ---

/** Scan ~/eon/ for git repositories */
export function discoverRepos(): RepoCandidate[] {
  if (!fs.existsSync(EON_DIR)) return [];

  const candidates: RepoCandidate[] = [];
  const entries = fs.readdirSync(EON_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repoPath = path.join(EON_DIR, entry.name);
    const gitDir = path.join(repoPath, '.git');

    if (!fs.existsSync(gitDir)) continue;

    try {
      // Get last commit date
      const lastCommitDate = execSync(
        'git log -1 --format=%ci 2>/dev/null || echo "unknown"',
        { cwd: repoPath, encoding: 'utf-8', timeout: 30_000 },
      ).trim();

      // Get commit count in last 30 days
      const commitCount = parseInt(
        execSync(
          'git rev-list --count --since="30 days ago" HEAD 2>/dev/null || echo 0',
          { cwd: repoPath, encoding: 'utf-8', timeout: 30_000 },
        ).trim(),
        10,
      );

      // Detect primary languages by file extensions
      const languages = detectLanguages(repoPath);

      candidates.push({
        path: repoPath,
        name: entry.name,
        lastCommitDate,
        commitCount30d: commitCount,
        languages,
        score: 0,
      });
    } catch {
      // Skip repos we can't read
    }
  }

  // Sort by recent activity
  return candidates.sort((a, b) => b.commitCount30d - a.commitCount30d);
}

/** Detect primary languages in a repo */
function detectLanguages(repoPath: string): string[] {
  const languages = new Set<string>();
  try {
    const files = execSync('git ls-files --cached | head -100', {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 30_000,
    })
      .trim()
      .split('\n');

    for (const file of files) {
      if (file.endsWith('.rs')) languages.add('rust');
      else if (file.endsWith('.py')) languages.add('python');
      else if (file.endsWith('.ts') || file.endsWith('.tsx'))
        languages.add('typescript');
      else if (file.endsWith('.go')) languages.add('go');
      else if (file.endsWith('.js') || file.endsWith('.jsx'))
        languages.add('javascript');
    }
  } catch {
    // ignore
  }
  return [...languages];
}
