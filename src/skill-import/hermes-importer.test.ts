/**
 * Tests for hermes-importer.ts
 *
 * Uses real filesystem with tmp directories — no mocking of fs or crypto.
 * The shallowClone function is NOT tested here (requires network + git).
 * Instead we call importFromClone() directly with a pre-built mock tree.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  discoverSkills,
  importFromClone,
  loadManifest,
  sha256File,
} from './hermes-importer.js';
import type { ImportOptions } from './types.js';

// Absolute path to the mock hermes-agent tree used across all tests.
const FIXTURE_REPO = path.resolve(
  import.meta.dirname,
  'tests/fixtures/mock-hermes-tree',
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

async function makeTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hermes-test-'));
}

async function defaultOptions(dir: string): Promise<ImportOptions> {
  return {
    dryRun: false,
    noCleanup: true, // never rm in tests — we control the clone fixture
    runtimeDir: path.join(dir, 'runtime'),
    kgDir: path.join(dir, 'kg'),
    manifestPath: path.join(dir, '_hermes_manifest.json'),
  };
}

// ---------------------------------------------------------------------------
// sha256File
// ---------------------------------------------------------------------------

describe('sha256File', () => {
  it('returns a 64-char hex string', async () => {
    const fixtureMd = path.join(
      FIXTURE_REPO,
      'skills',
      'code-tools',
      'my-linter',
      'SKILL.md',
    );
    const hash = await sha256File(fixtureMd);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same file', async () => {
    const fixtureMd = path.join(
      FIXTURE_REPO,
      'skills',
      'research',
      'web-search',
      'SKILL.md',
    );
    const h1 = await sha256File(fixtureMd);
    const h2 = await sha256File(fixtureMd);
    expect(h1).toBe(h2);
  });

  it('differs for different files', async () => {
    const a = path.join(FIXTURE_REPO, 'skills', 'code-tools', 'my-linter', 'SKILL.md');
    const b = path.join(FIXTURE_REPO, 'skills', 'research', 'web-search', 'SKILL.md');
    const ha = await sha256File(a);
    const hb = await sha256File(b);
    expect(ha).not.toBe(hb);
  });
});

// ---------------------------------------------------------------------------
// discoverSkills
// ---------------------------------------------------------------------------

describe('discoverSkills', () => {
  it('finds all three SKILL.md leaves in the mock tree', async () => {
    const skills = await discoverSkills(FIXTURE_REPO);
    expect(skills).toHaveLength(3);
  });

  it('derives slugs correctly for 2-part paths', async () => {
    const skills = await discoverSkills(FIXTURE_REPO);
    const slugs = skills.map((s) => s.slug).sort();
    expect(slugs).toContain('hermes-code-tools--my-linter');
    expect(slugs).toContain('hermes-research--web-search');
    expect(slugs).toContain('hermes-experimental--alpha-tool');
  });

  it('assigns correct sourceSubdir values', async () => {
    const skills = await discoverSkills(FIXTURE_REPO);
    const bySlug = Object.fromEntries(skills.map((s) => [s.slug, s.sourceSubdir]));
    expect(bySlug['hermes-code-tools--my-linter']).toBe('skills');
    expect(bySlug['hermes-research--web-search']).toBe('skills');
    expect(bySlug['hermes-experimental--alpha-tool']).toBe('optional-skills');
  });

  it('returns empty array when repo root does not exist', async () => {
    const skills = await discoverSkills('/tmp/does-not-exist-hermes-9999');
    expect(skills).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// importFromClone — first run
// ---------------------------------------------------------------------------

describe('importFromClone — first run', () => {
  beforeEach(async () => {
    tmpDir = await makeTmp();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('adds all skills on a fresh manifest', async () => {
    const opts = await defaultOptions(tmpDir);
    const result = await importFromClone(FIXTURE_REPO, opts);

    expect(result.added).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.upstreamGone).toHaveLength(0);
    expect(result.totalInManifest).toBe(3);
  });

  it('writes SKILL.md to the runtime destination', async () => {
    const opts = await defaultOptions(tmpDir);
    await importFromClone(FIXTURE_REPO, opts);

    const linterMd = path.join(
      opts.runtimeDir!,
      'hermes-code-tools--my-linter',
      'SKILL.md',
    );
    await expect(fs.access(linterMd)).resolves.toBeUndefined();
  });

  it('writes SKILL.md to the KG destination (strips hermes- prefix)', async () => {
    const opts = await defaultOptions(tmpDir);
    await importFromClone(FIXTURE_REPO, opts);

    const kgMd = path.join(opts.kgDir!, 'code-tools--my-linter', 'SKILL.md');
    await expect(fs.access(kgMd)).resolves.toBeUndefined();
  });

  it('persists manifest with correct SHA', async () => {
    const opts = await defaultOptions(tmpDir);
    await importFromClone(FIXTURE_REPO, opts);

    const manifest = await loadManifest(opts.manifestPath!);
    expect(manifest.version).toBe(1);
    expect(manifest.lastRun).not.toBeNull();
    expect(Object.keys(manifest.skills)).toHaveLength(3);

    const entry = manifest.skills['hermes-code-tools--my-linter'];
    expect(entry).toBeDefined();
    expect(entry.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.sourceSubdir).toBe('skills');
  });
});

// ---------------------------------------------------------------------------
// importFromClone — idempotency (re-run)
// ---------------------------------------------------------------------------

describe('importFromClone — idempotency', () => {
  beforeEach(async () => {
    tmpDir = await makeTmp();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports all unchanged on second run with same files', async () => {
    const opts = await defaultOptions(tmpDir);

    const r1 = await importFromClone(FIXTURE_REPO, opts);
    expect(r1.added).toBe(3);

    const r2 = await importFromClone(FIXTURE_REPO, opts);
    expect(r2.added).toBe(0);
    expect(r2.updated).toBe(0);
    expect(r2.unchanged).toBe(3);
  });

  it('detects an update when SKILL.md content changes', async () => {
    const opts = await defaultOptions(tmpDir);

    // First run.
    await importFromClone(FIXTURE_REPO, opts);

    // Patch the manifest to simulate stale SHA for one skill.
    const manifest = await loadManifest(opts.manifestPath!);
    manifest.skills['hermes-code-tools--my-linter'].sha = 'stale-sha';
    await fs.writeFile(opts.manifestPath!, JSON.stringify(manifest, null, 2), 'utf8');

    // Second run — should pick up the "changed" skill.
    const r2 = await importFromClone(FIXTURE_REPO, opts);
    expect(r2.updated).toBe(1);
    expect(r2.unchanged).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// importFromClone — dry-run
// ---------------------------------------------------------------------------

describe('importFromClone — dry-run', () => {
  beforeEach(async () => {
    tmpDir = await makeTmp();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports correct counts but writes no files', async () => {
    const opts: ImportOptions = {
      ...(await defaultOptions(tmpDir)),
      dryRun: true,
    };

    const result = await importFromClone(FIXTURE_REPO, opts);
    expect(result.added).toBe(3);

    // No runtime files should exist.
    const runtimeExists = await fs
      .access(opts.runtimeDir!)
      .then(() => true)
      .catch(() => false);
    expect(runtimeExists).toBe(false);

    // Manifest should not have been written.
    const manifestExists = await fs
      .access(opts.manifestPath!)
      .then(() => true)
      .catch(() => false);
    expect(manifestExists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadManifest
// ---------------------------------------------------------------------------

describe('loadManifest', () => {
  it('returns a fresh manifest when file does not exist', async () => {
    const manifest = await loadManifest('/tmp/does-not-exist-manifest-9999.json');
    expect(manifest.version).toBe(1);
    expect(manifest.lastRun).toBeNull();
    expect(manifest.skills).toEqual({});
  });

  it('returns a fresh manifest when file contains invalid JSON', async () => {
    const tmp = await makeTmp();
    const badPath = path.join(tmp, 'bad.json');
    await fs.writeFile(badPath, '{ not valid json !!!', 'utf8');
    const manifest = await loadManifest(badPath);
    expect(manifest.skills).toEqual({});
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Slug derivation edge cases
// ---------------------------------------------------------------------------

describe('slug derivation', () => {
  it('uses single hermes-<name> for 1-level paths', async () => {
    // Create a minimal repo with a skill directly under skills/ (1-part path)
    const tmp = await makeTmp();
    const skillDir = path.join(tmp, 'skills', 'flat-skill');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Flat\n', 'utf8');

    const skills = await discoverSkills(tmp);
    expect(skills).toHaveLength(1);
    expect(skills[0].slug).toBe('hermes-flat-skill');
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('uses hermes-<a>--<b>--<c> for 3-level deep paths', async () => {
    const tmp = await makeTmp();
    const skillDir = path.join(tmp, 'skills', 'cat', 'sub', 'leaf');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Deep\n', 'utf8');

    const skills = await discoverSkills(tmp);
    expect(skills).toHaveLength(1);
    expect(skills[0].slug).toBe('hermes-cat--sub--leaf');
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
