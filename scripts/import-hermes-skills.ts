#!/usr/bin/env tsx
/**
 * import-hermes-skills.ts — CLI for importing NousResearch/hermes-agent skills locally.
 *
 * Usage:
 *   npm run import-hermes-skills
 *   npm run import-hermes-skills -- --dry-run
 *   npm run import-hermes-skills -- --no-cleanup
 *
 * What it does:
 *   1. Shallow-clones https://github.com/NousResearch/hermes-agent.git into a temp dir
 *   2. Walks skills/ and optional-skills/ recursively for SKILL.md files
 *   3. Copies each skill to two destinations:
 *        ~/.claude/skills/hermes-<cat>--<skill>/            (runtime, Claude Code auto-load)
 *        ~/.claude/skill-wiki/imported-skills/hermes/<cat>--<skill>/  (ctx KG index)
 *   4. Writes a SHA manifest to ~/.claude/skills/_hermes_manifest.json
 *      (idempotent: skips unchanged skills on re-runs)
 *
 * Flags:
 *   --dry-run     Show what would change without writing any files
 *   --no-cleanup  Keep the temp clone dir after import (useful for debugging)
 */

import { runHermesImport } from '../src/skill-import/hermes-importer.js';
import type { ImportOptions } from '../src/skill-import/types.js';

function parseArgs(): ImportOptions {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    noCleanup: args.includes('--no-cleanup'),
  };
}

async function main(): Promise<void> {
  const options = parseArgs();

  if (options.dryRun) {
    console.log('[mode] dry-run — no files will be written');
  }

  try {
    await runHermesImport(options);
    process.exit(0);
  } catch (err) {
    console.error('[error]', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
