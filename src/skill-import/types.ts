/**
 * Types for the Hermes skill importer.
 *
 * Ported from ~/.claude/scripts/hermes-import/hermes_import.py
 * Source subdirs: skills/ and optional-skills/ inside the hermes-agent repo.
 * Slug convention: hermes-<category>--<skill>  (double-dash separator)
 */

/** A single discovered skill leaf from the hermes-agent repo. */
export interface DiscoveredSkill {
  /** Source subdir inside the repo: "skills" | "optional-skills" */
  sourceSubdir: string;
  /**
   * Derived slug: hermes-<category>--<skill> for nested paths,
   * or hermes-<name> for flat (1-part) paths.
   */
  slug: string;
  /** Absolute path to the skill directory inside the (temp) clone. */
  srcDir: string;
}

/**
 * Per-skill entry stored in the manifest JSON.
 * Written to ~/.claude/skills/_hermes_manifest.json
 */
export interface ManifestEntry {
  /** SHA-256 of the SKILL.md file at import time. */
  sha: string;
  /** "skills" | "optional-skills" */
  sourceSubdir: string;
  /** Relative path inside the clone, e.g. "skills/code-tools/my-linter" */
  sourcePath: string;
  /** ISO-8601 UTC timestamp of the import. */
  importedAt: string;
}

/** The top-level manifest file written to ~/.claude/skills/_hermes_manifest.json */
export interface SkillManifest {
  version: 1;
  lastRun: string | null;
  /** Map of slug → ManifestEntry */
  skills: Record<string, ManifestEntry>;
}

/** Counters returned by the core import function. */
export interface ImportResult {
  added: number;
  updated: number;
  unchanged: number;
  /** Slugs present in the manifest but absent from the upstream clone. */
  upstreamGone: string[];
  /** Total skills now in the manifest. */
  totalInManifest: number;
}

/** Options passed to runHermesImport (and the CLI). */
export interface ImportOptions {
  /** If true, do not write any files. Just report what would change. */
  dryRun: boolean;
  /** If true, keep the temp clone directory after import (for debugging). */
  noCleanup: boolean;
  /** Override the default runtime destination (~/.claude/skills/). */
  runtimeDir?: string;
  /** Override the default KG index destination (~/.claude/skill-wiki/imported-skills/hermes/). */
  kgDir?: string;
  /** Override the default manifest path (~/.claude/skills/_hermes_manifest.json). */
  manifestPath?: string;
}
