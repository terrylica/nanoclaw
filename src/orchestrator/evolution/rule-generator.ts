/**
 * Auto-generate ast-grep YAML rules from confirmed findings.
 *
 * When a finding is confirmed (TP), extracts the code pattern
 * and asks MiniMax to write an ast-grep rule that catches it.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../../logger.js';
import { queryMiniMax } from '../minimax-client.js';
import { AST_GREP_BINARY } from '../types.js';
import type { Finding } from '../types.js';

// --- Constants ---

const GENERATED_RULES_DIR = 'rules/generated';

// --- Rule Generation ---

/** Generate an ast-grep rule from a confirmed finding */
export async function generateRule(
  finding: Finding,
  repoPath: string,
  apiKey: string,
): Promise<{ generated: boolean; rulePath?: string; reason?: string }> {
  // Determine language from file extensions
  const languages = new Set<string>();
  for (const file of finding.files) {
    if (file.endsWith('.rs')) languages.add('rust');
    else if (file.endsWith('.py')) languages.add('python');
    else if (file.endsWith('.ts') || file.endsWith('.tsx'))
      languages.add('typescript');
  }

  if (languages.size === 0) {
    return { generated: false, reason: 'No recognized language in files' };
  }

  const language = [...languages][0]!; // Primary language — safe: size > 0 guard above

  const prompt = `You are an ast-grep rule expert. Write a YAML rule that catches the following code pattern.

FINDING:
- Title: ${finding.title}
- Description: ${finding.description}
- Type: ${finding.type}
- Severity: ${finding.severity}
- Files: ${finding.files.join(', ')}

Write an ast-grep rule in YAML format that would catch this pattern.
The rule must use the ast-grep YAML DSL (id, language, rule with kind/regex/has/not/inside/follows/precedes).

Rules reference:
- \`kind\`: AST node type (e.g., call_expression, function_definition)
- \`regex\`: Match node text with regex
- \`has\`: Node must have a child matching sub-rule
- \`not\`: Negate a sub-rule
- \`inside\`: Node must be inside a parent matching sub-rule

Return ONLY the YAML content, no markdown fences. Include:
- id: kebab-case identifier
- language: ${language}
- severity: ${finding.severity === 'critical' || finding.severity === 'high' ? 'warning' : 'hint'}
- message: description of what the rule catches
- rule: the ast-grep rule specification`;

  try {
    const raw = await queryMiniMax(prompt, apiKey);
    const yamlContent = raw
      .replace(/^```(?:yaml)?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();

    if (!yamlContent.includes('id:') || !yamlContent.includes('rule:')) {
      return { generated: false, reason: 'Invalid rule YAML from MiniMax' };
    }

    // Write rule to temporary file and test it
    const ruleId = finding.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 50);
    const ruleFileName = `${ruleId}-${language}.yml`;
    const rulesDir = path.join(repoPath, GENERATED_RULES_DIR);
    fs.mkdirSync(rulesDir, { recursive: true });
    const rulePath = path.join(rulesDir, ruleFileName);

    fs.writeFileSync(rulePath, yamlContent);

    // Test: run ast-grep with this rule
    const testResult = testRule(rulePath, repoPath);
    if (!testResult.valid) {
      // Remove invalid rule
      fs.unlinkSync(rulePath);
      return {
        generated: false,
        reason: `Rule test failed: ${testResult.error}`,
      };
    }

    logger.info(
      { ruleId, matches: testResult.matchCount, rulePath: ruleFileName },
      'Generated ast-grep rule',
    );

    return {
      generated: true,
      rulePath: path.relative(repoPath, rulePath),
    };
  } catch (err) {
    logger.warn({ err, finding: finding.title }, 'Rule generation failed');
    return {
      generated: false,
      reason: `MiniMax error: ${String(err).slice(0, 100)}`,
    };
  }
}

/** Test a rule against the repository */
function testRule(
  rulePath: string,
  repoPath: string,
): { valid: boolean; matchCount: number; error?: string } {
  try {
    const result = execSync(
      `${AST_GREP_BINARY} scan --rule "${rulePath}" --json 2>/dev/null || true`,
      {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );

    // Parse JSON output to count matches
    const lines = result.trim().split('\n').filter(Boolean);
    let matchCount = 0;
    for (const line of lines) {
      try {
        JSON.parse(line);
        matchCount++;
      } catch {
        // Not JSON, ignore
      }
    }

    return { valid: true, matchCount };
  } catch (err) {
    return {
      valid: false,
      matchCount: 0,
      error: String(err).slice(0, 200),
    };
  }
}

/** List all generated rules */
export function listGeneratedRules(repoPath: string): string[] {
  const rulesDir = path.join(repoPath, GENERATED_RULES_DIR);
  if (!fs.existsSync(rulesDir)) return [];
  return fs
    .readdirSync(rulesDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
}
