/**
 * hermes-importer.ts — Core logic for importing skills from NousResearch/hermes-agent.
 *
 * Ported from ~/.claude/scripts/hermes-import/hermes_import.py
 *
 * Two destinations per skill:
 *   RUNTIME:  ~/.claude/skills/hermes-<cat>--<skill>/      (Claude Code discovers at depth 1)
 *   KG INDEX: ~/.claude/skill-wiki/imported-skills/hermes/<cat>--<skill>/  (ctx-indexable)
 *
 * Idempotency: manifest at ~/.claude/skills/_hermes_manifest.json maps slug → SHA-256 of SKILL.md.
 * Skills whose SHA is unchanged are skipped. Removed-upstream skills are reported but NOT deleted.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

import type {
  DiscoveredSkill,
  ImportOptions,
  ImportResult,
  ManifestEntry,
  SkillManifest,
} from './types.js';

const execFileAsync = promisify(execFile);

const REPO_URL = 'https://github.com/NousResearch/hermes-agent.git';
const SOURCE_SUBDIRS = ['skills', 'optional-skills'] as const;

// Default paths — match the Python original exactly.
const DEFAULT_RUNTIME_DIR = path.join(os.homedir(), '.claude', 'skills');
const DEFAULT_KG_DIR = path.join(
  os.homedir(),
  '.claude',
  'skill-wiki',
  'imported-skills',
  'hermes',
);
const DEFAULT_MANIFEST_PATH = path.join(
  os.homedir(),
  '.claude',
  'skills',
  '_hermes_manifest.json',
);

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex digest of a file. */
export async function sha256File(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Shallow-clone the hermes-agent repo into `targetDir`.
 * Uses --depth=1 --filter=blob:none to minimise bandwidth.
 */
export async function shallowClone(targetDir: string): Promise<void> {
  await execFileAsync('git', [
    'clone',
    '--depth=1',
    '--filter=blob:none',
    REPO_URL,
    targetDir,
  ]);
}

/**
 * Recursively walk `baseDir` and collect every path named "SKILL.md".
 * Returns an array of absolute file paths.
 */
async function findSkillMds(baseDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      // Cast needed because @types/node overloads differ across minor versions.
      entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as Dirent[];
    } catch {
      return; // directory disappeared — skip
    }
    for (const entry of entries) {
      const name = String(entry.name);
      const fullPath = path.join(dir, name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
  }

  await walk(baseDir);
  return results;
}

/**
 * Discover every leaf SKILL.md under `repoRoot`/skills/ and `repoRoot`/optional-skills/.
 * Returns a list of DiscoveredSkill objects.
 *
 * Slug derivation (matches Python logic):
 *   - 1-part path:   hermes-<name>
 *   - N-part path:   hermes-<part0>--<part1>--...
 */
export async function discoverSkills(repoRoot: string): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = [];

  for (const sub of SOURCE_SUBDIRS) {
    const base = path.join(repoRoot, sub);

    // Skip if the subdir doesn't exist in this clone.
    try {
      await fs.access(base);
    } catch {
      continue;
    }

    const skillMds = await findSkillMds(base);

    for (const skillMdPath of skillMds) {
      const skillDir = path.dirname(skillMdPath);
      const rel = path.relative(base, skillDir);
      const parts = rel.split(path.sep).filter(Boolean);

      if (parts.length === 0) continue; // SKILL.md directly in base — skip

      const slug =
        parts.length === 1
          ? `hermes-${parts[0]}`
          : `hermes-${parts.join('--')}`;

      out.push({ sourceSubdir: sub, slug, srcDir: skillDir });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

export async function loadManifest(manifestPath: string): Promise<SkillManifest> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    return JSON.parse(raw) as SkillManifest;
  } catch {
    return { version: 1, lastRun: null, skills: {} };
  }
}

export async function writeManifest(
  manifest: SkillManifest,
  manifestPath: string,
  dry: boolean,
): Promise<void> {
  if (dry) return;
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Copy helper
// ---------------------------------------------------------------------------

/** Recursively copy `src` → `dst`, replacing dst if it exists. */
async function copyTree(src: string, dst: string): Promise<void> {
  // Remove existing destination so we get a clean copy.
  await fs.rm(dst, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await copyDir(src, dst);
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, dstPath);
    } else {
      await fs.copyFile(srcPath, dstPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Core import function
// ---------------------------------------------------------------------------

/**
 * Run the full Hermes import pipeline.
 *
 * @param cloneRoot  - Absolute path to an already-cloned hermes-agent repo.
 * @param options    - Import options (dryRun, paths, etc.)
 * @returns ImportResult with added/updated/unchanged/upstreamGone counts.
 */
export async function importFromClone(
  cloneRoot: string,
  options: ImportOptions,
): Promise<ImportResult> {
  const runtimeDir = options.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const kgDir = options.kgDir ?? DEFAULT_KG_DIR;
  const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;

  if (!options.dryRun) {
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.mkdir(kgDir, { recursive: true });
  }

  const manifest = await loadManifest(manifestPath);
  const seenSlugs = new Set<string>();
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  const skills = await discoverSkills(cloneRoot);

  for (const { sourceSubdir, slug, srcDir } of skills) {
    seenSlugs.add(slug);

    const skillMdPath = path.join(srcDir, 'SKILL.md');
    const sha = await sha256File(skillMdPath);
    const prev = manifest.skills[slug];

    if (prev?.sha === sha) {
      unchanged++;
      continue;
    }

    const runtimeDst = path.join(runtimeDir, slug);
    // KG destination strips the "hermes-" prefix (matches Python: slug.removeprefix("hermes-"))
    const kgSlug = slug.startsWith('hermes-') ? slug.slice('hermes-'.length) : slug;
    const kgDst = path.join(kgDir, kgSlug);

    if (!options.dryRun) {
      await copyTree(srcDir, runtimeDst);
      await copyTree(srcDir, kgDst);
    }

    const relSrcPath = path.relative(cloneRoot, srcDir);

    manifest.skills[slug] = {
      sha,
      sourceSubdir,
      sourcePath: relSrcPath,
      importedAt: new Date().toISOString(),
    } satisfies ManifestEntry;

    if (prev) {
      updated++;
    } else {
      added++;
    }
  }

  manifest.lastRun = new Date().toISOString();

  const upstreamGone = Object.keys(manifest.skills).filter(
    (s) => !seenSlugs.has(s),
  );

  await writeManifest(manifest, manifestPath, options.dryRun);

  return {
    added,
    updated,
    unchanged,
    upstreamGone,
    totalInManifest: Object.keys(manifest.skills).length,
  };
}

// ---------------------------------------------------------------------------
// High-level runner (used by the CLI)
// ---------------------------------------------------------------------------

/**
 * Full pipeline: create temp dir → shallow clone → import → cleanup.
 * Logs progress to stdout/stderr.
 */
export async function runHermesImport(options: ImportOptions): Promise<ImportResult> {
  // Create temp directory for the clone.
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-import-'));
  const cloneTarget = path.join(tmpBase, 'hermes-agent');

  try {
    console.log(`[clone] shallow → ${cloneTarget}`);
    await shallowClone(cloneTarget);

    const skills = await discoverSkills(cloneTarget);
    console.log(`[discover] ${skills.length} leaf SKILL.md files`);

    const result = await importFromClone(cloneTarget, options);

    // Report added/updated
    if (!options.dryRun) {
      const manifestPath = options.manifestPath ?? DEFAULT_MANIFEST_PATH;
      const manifest = await loadManifest(manifestPath);
      for (const [slug, entry] of Object.entries(manifest.skills)) {
        // We can't easily distinguish add vs update here post-hoc; the caller logs this.
        void slug;
        void entry;
      }
    }

    if (result.upstreamGone.length > 0) {
      console.warn(
        `[upstream] ${result.upstreamGone.length} skills no longer in upstream (kept locally for safety):`,
      );
      for (const s of result.upstreamGone) {
        console.warn(`  ? gone     ${s}`);
      }
    }

    console.log(
      `\n[summary] added=${result.added} updated=${result.updated} unchanged=${result.unchanged} ` +
        `upstream_gone=${result.upstreamGone.length} total_in_manifest=${result.totalInManifest}`,
    );

    if (options.dryRun) {
      console.log('[dry-run] no files written');
    }

    return result;
  } finally {
    if (!options.noCleanup) {
      await fs.rm(tmpBase, { recursive: true, force: true });
    } else {
      console.log(`[no-cleanup] temp dir preserved at: ${tmpBase}`);
    }
  }
}
