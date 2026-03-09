/**
 * Fetch community rules from known repositories.
 *
 * Sources:
 * - coderabbitai/ast-grep-essentials (ast-grep rules)
 * - semgrep/semgrep-rules (OpenGrep-compatible)
 * - ast-grep.github.io/catalog (curated rules)
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../../logger.js';

// --- Constants ---

const COMMUNITY_RULES_DIR = 'rules/community';
const OPENGREP_RULES_DIR = 'rules/opengrep';

interface RuleSource {
  name: string;
  repo: string;
  targetDir: string;
  languages: string[];
  filterGlob: string;
}

const RULE_SOURCES: RuleSource[] = [
  {
    name: 'ast-grep-essentials',
    repo: 'coderabbitai/ast-grep-essentials',
    targetDir: COMMUNITY_RULES_DIR,
    languages: ['rust', 'python'],
    filterGlob: '*.yml',
  },
  {
    name: 'semgrep-community',
    repo: 'semgrep/semgrep-rules',
    targetDir: OPENGREP_RULES_DIR,
    languages: ['rust', 'python'],
    filterGlob: '*.yaml',
  },
];

// --- Fetching ---

/** Fetch rules from a single source using sparse checkout */
export function fetchRulesFromSource(
  source: RuleSource,
  repoPath: string,
): { fetched: number; errors: string[] } {
  const errors: string[] = [];
  let fetched = 0;
  const targetDir = path.join(repoPath, source.targetDir, source.name);

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    // Use gh to download specific directories for each language
    for (const lang of source.languages) {
      try {
        // Download rules for this language using gh api
        const tempDir = `/tmp/nanoclaw-rules-${source.name}-${lang}`;

        // Clone shallowly with sparse checkout
        if (fs.existsSync(tempDir)) {
          execSync(`rm -rf "${tempDir}"`, { timeout: 10_000 });
        }

        execSync(
          `git clone --depth 1 --filter=blob:none --sparse "https://github.com/${source.repo}.git" "${tempDir}"`,
          { timeout: 60_000, encoding: 'utf-8' },
        );

        // Set sparse checkout for language directory
        execSync(`git sparse-checkout set "${lang}" "rules/${lang}"`, {
          cwd: tempDir,
          timeout: 10_000,
          encoding: 'utf-8',
        });

        // Copy YAML rule files to target
        const langDir = fs.existsSync(path.join(tempDir, lang))
          ? path.join(tempDir, lang)
          : fs.existsSync(path.join(tempDir, 'rules', lang))
            ? path.join(tempDir, 'rules', lang)
            : null;

        if (langDir) {
          const ruleFiles = findYamlFiles(langDir);
          const langTarget = path.join(targetDir, lang);
          fs.mkdirSync(langTarget, { recursive: true });

          for (const ruleFile of ruleFiles) {
            const destFile = path.join(langTarget, path.basename(ruleFile));
            fs.copyFileSync(ruleFile, destFile);
            fetched++;
          }
        }

        // Cleanup temp dir
        execSync(`rm -rf "${tempDir}"`, { timeout: 10_000 });
      } catch (err) {
        errors.push(`${source.name}/${lang}: ${String(err).slice(0, 100)}`);
      }
    }
  } catch (err) {
    errors.push(`${source.name}: ${String(err).slice(0, 200)}`);
  }

  logger.info(
    { source: source.name, fetched, errors: errors.length },
    'Rule fetch complete',
  );

  return { fetched, errors };
}

/** Fetch all rules from all sources */
export function fetchAllCommunityRules(repoPath: string): {
  totalFetched: number;
  errors: string[];
} {
  let totalFetched = 0;
  const allErrors: string[] = [];

  for (const source of RULE_SOURCES) {
    const result = fetchRulesFromSource(source, repoPath);
    totalFetched += result.fetched;
    allErrors.push(...result.errors);
  }

  return { totalFetched, errors: allErrors };
}

/** Recursively find YAML files in a directory */
function findYamlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findYamlFiles(fullPath));
    } else if (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Count existing community rules */
export function countCommunityRules(repoPath: string): number {
  let count = 0;
  for (const source of RULE_SOURCES) {
    const dir = path.join(repoPath, source.targetDir, source.name);
    if (fs.existsSync(dir)) {
      count += findYamlFiles(dir).length;
    }
  }
  return count;
}
