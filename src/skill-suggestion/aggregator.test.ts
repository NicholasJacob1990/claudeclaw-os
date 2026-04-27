/**
 * Tests for aggregator.ts — pure functions (jaccardSimilarity, signalsToToolSet, clusterRows).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

import {
  jaccardSimilarity,
  signalsToToolSet,
  clusterRows,
  _resetDb,
} from './aggregator.js';

// -- jaccardSimilarity() ---------------------------------------------------------

describe('jaccardSimilarity()', () => {
  it('returns 1 for identical sets', () => {
    const a = new Set(['Read', 'Write', 'Bash']);
    expect(jaccardSimilarity(a, a)).toBe(1);
  });

  it('returns 0 for completely disjoint sets', () => {
    const a = new Set(['Read', 'Write']);
    const b = new Set(['Grep', 'Glob']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('returns 1 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it('returns 0 when one set is empty', () => {
    expect(jaccardSimilarity(new Set(['Read']), new Set())).toBe(0);
  });

  it('computes correct similarity for partial overlap', () => {
    const a = new Set(['Read', 'Write', 'Bash']);
    const b = new Set(['Read', 'Write', 'Edit']);
    // intersection = {Read, Write} = 2, union = 4 -> 0.5
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
  });

  it('is commutative', () => {
    const a = new Set(['Read', 'Write', 'Bash']);
    const b = new Set(['Read', 'Write', 'Edit', 'Grep']);
    expect(jaccardSimilarity(a, b)).toBeCloseTo(jaccardSimilarity(b, a));
  });
});

// -- signalsToToolSet() -----------------------------------------------------------

describe('signalsToToolSet()', () => {
  it('extracts tool_sequence into a set', () => {
    const signals = JSON.stringify({ tool_calls: 10, tool_sequence: ['Read', 'Write', 'Bash'] });
    const set = signalsToToolSet(signals);
    expect(set.has('Read')).toBe(true);
    expect(set.has('Write')).toBe(true);
    expect(set.has('Bash')).toBe(true);
  });

  it('returns empty set when tool_sequence is missing', () => {
    const signals = JSON.stringify({ tool_calls: 5 });
    expect(signalsToToolSet(signals).size).toBe(0);
  });

  it('returns empty set for invalid JSON', () => {
    expect(signalsToToolSet('{bad json').size).toBe(0);
  });

  it('returns empty set for empty string', () => {
    expect(signalsToToolSet('').size).toBe(0);
  });
});

// -- clusterRows() ---------------------------------------------------------------

function makeRow(
  id: number,
  signature: string,
  toolSequence: string[],
  createdAt = 1000000,
): Parameters<typeof clusterRows>[0][0] {
  return {
    id,
    session_id: `session-${id}`,
    signature,
    status: 'pending',
    draft_path: null,
    skill_name: null,
    signals: JSON.stringify({ tool_calls: 12, tool_sequence: toolSequence }),
    created_at: createdAt,
  };
}

describe('clusterRows()', () => {
  it('returns empty array when all rows form singletons below threshold', () => {
    const rows = [
      makeRow(1, 'aaa', ['Read', 'Write', 'Bash']),
      makeRow(2, 'bbb', ['Grep', 'Glob', 'Edit']),
      makeRow(3, 'ccc', ['Skill', 'Bash', 'Read']),
    ];
    // With default threshold=3, a single cluster of 3 from identical sets would qualify.
    // But these are disjoint so no cluster of 3 forms.
    const clusters = clusterRows(rows, 0.4, 3);
    expect(clusters).toHaveLength(0);
  });

  it('groups similar sessions into a cluster', () => {
    const commonTools = ['Read', 'Write', 'Bash', 'Edit', 'Glob'];
    const rows = [
      makeRow(1, 'aaa', [...commonTools, 'Grep']),
      makeRow(2, 'bbb', [...commonTools, 'Bash']),
      makeRow(3, 'ccc', [...commonTools, 'Read']),
    ];
    const clusters = clusterRows(rows, 0.4, 3);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('does not include cluster smaller than threshold', () => {
    const commonTools = ['Read', 'Write', 'Bash', 'Edit', 'Glob'];
    const rows = [
      makeRow(1, 'aaa', [...commonTools, 'Grep']),
      makeRow(2, 'bbb', [...commonTools, 'Bash']),
      // Only 2 similar rows — below threshold of 3
    ];
    const clusters = clusterRows(rows, 0.4, 3);
    expect(clusters).toHaveLength(0);
  });

  it('handles empty input', () => {
    expect(clusterRows([], 0.4, 3)).toHaveLength(0);
  });

  it('merges by single-linkage (transitive similarity)', () => {
    // A is similar to B, B is similar to C (but A might not be similar to C directly)
    const rowA = makeRow(1, 'aaa', ['Read', 'Write', 'Bash', 'Edit', 'Glob']);
    const rowB = makeRow(2, 'bbb', ['Read', 'Write', 'Bash', 'Edit', 'Grep']);
    const rowC = makeRow(3, 'ccc', ['Read', 'Write', 'Bash', 'Edit', 'Read']);
    const clusters = clusterRows([rowA, rowB, rowC], 0.4, 3);
    // All three should cluster together given high overlap
    expect(clusters).toHaveLength(1);
  });
});
