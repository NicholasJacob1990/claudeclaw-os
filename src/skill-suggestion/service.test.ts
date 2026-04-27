import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { processSession, _resetDb } from './service.js';
import type { TranscriptMessage } from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeUserMsg(text: string): TranscriptMessage {
  return { type: 'user', message: { role: 'user', content: text } };
}

function makeAssistantWithTools(
  tools: Array<{ name: string; input?: Record<string, unknown> }>,
): TranscriptMessage {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: tools.map((t) => ({
        type: 'tool_use',
        name: t.name,
        input: t.input ?? {},
      })),
    },
  };
}

function complexMessages(): TranscriptMessage[] {
  return [
    makeUserMsg('Port skill-suggestion Python to TypeScript'),
    makeAssistantWithTools([
      { name: 'Read', input: {} },
      { name: 'Glob', input: {} },
      { name: 'Grep', input: {} },
      { name: 'Bash', input: { command: 'npm test' } },
      { name: 'Write', input: { file_path: '/proj/src/types.ts' } },
      { name: 'Write', input: { file_path: '/proj/src/detector.ts' } },
      { name: 'Edit', input: { file_path: '/proj/src/enrichment.ts' } },
      { name: 'Write', input: { file_path: '/proj/src/service.ts' } },
      { name: 'Bash', input: { command: 'npx tsc --noEmit' } },
      { name: 'Bash', input: { command: 'npm run build' } },
      { name: 'Edit', input: { file_path: '/proj/README.md' } },
    ]),
    makeUserMsg('Also add tests and update .env.example'),
    makeAssistantWithTools([
      { name: 'Write', input: { file_path: '/proj/src/detector.test.ts' } },
      { name: 'Edit', input: { file_path: '/proj/.env.example' } },
    ]),
  ];
}

// ── Test setup: isolated tmp dirs ────────────────────────────────────────────

let tmpDir: string;
let origOutputDir: string | undefined;
let origStoreDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-svc-test-'));
  origOutputDir = process.env.SKILL_SUGGESTION_OUTPUT_DIR;
  origStoreDir = process.env.CLAUDECLAW_STORE_DIR;
  process.env.SKILL_SUGGESTION_OUTPUT_DIR = path.join(tmpDir, '_pending');
  process.env.CLAUDECLAW_STORE_DIR = path.join(tmpDir, 'store');
  // Ensure no OAuth token so enrich() skips LLM calls in CI
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  _resetDb();
});

afterEach(() => {
  _resetDb();
  if (origOutputDir === undefined) delete process.env.SKILL_SUGGESTION_OUTPUT_DIR;
  else process.env.SKILL_SUGGESTION_OUTPUT_DIR = origOutputDir;
  if (origStoreDir === undefined) delete process.env.CLAUDECLAW_STORE_DIR;
  else process.env.CLAUDECLAW_STORE_DIR = origStoreDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('processSession()', () => {
  it('returns triggered=false for trivial session', async () => {
    const msgs: TranscriptMessage[] = [
      makeUserMsg('What is 2+2?'),
      makeAssistantWithTools([{ name: 'Bash', input: { command: 'echo 4' } }]),
    ];
    const result = await processSession(msgs, 'session-trivial');
    expect(result.triggered).toBe(false);
  });

  it('triggers for a complex session and writes a draft file', async () => {
    const result = await processSession(complexMessages(), 'session-complex-svc');
    expect(result.triggered).toBe(true);
    if (result.triggered) {
      expect(fs.existsSync(result.draftPath)).toBe(true);
      const content = fs.readFileSync(result.draftPath, 'utf-8');
      expect(content).toContain('session-complex-svc');
    }
  });

  it('is idempotent — second call with same session returns triggered=false', async () => {
    await processSession(complexMessages(), 'session-idem');
    const second = await processSession(complexMessages(), 'session-idem');
    expect(second.triggered).toBe(false);
    if (!second.triggered) {
      expect(second.reason).toContain('already handled');
    }
  });

  it('idempotency also works by signature (same files/tools, different session_id)', async () => {
    await processSession(complexMessages(), 'session-sig-1');
    // Same transcript → same signature → same files → idempotent
    const second = await processSession(complexMessages(), 'session-sig-2');
    expect(second.triggered).toBe(false);
  });

  it('draft file contains frontmatter with signature', async () => {
    const result = await processSession(complexMessages(), 'session-fm');
    if (result.triggered) {
      const content = fs.readFileSync(result.draftPath, 'utf-8');
      expect(content).toContain('signature:');
      expect(content).toContain('status: pending');
    }
  });

  it('enriched=false when CLAUDE_CODE_OAUTH_TOKEN is absent (template fallback)', async () => {
    const result = await processSession(complexMessages(), 'session-notoken');
    if (result.triggered) {
      expect(result.enriched).toBe(false);
    }
  });
});
