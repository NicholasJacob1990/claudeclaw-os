/** Interfaces for the Skill Annotations system (S4). */

/** Result of the LLM judge call. */
export interface JudgeResult {
  verdict: 'yes' | 'no' | 'ambiguous';
  reason: string;
  model: string;
  duration_ms?: number | null;
  cost_usd_reported?: number | null;
  raw_unparseable?: string;
}

/** A (skill, user-message) pair detected in a transcript. */
export interface CorrectionPair {
  skill: string;
  excerpt: string;
  /** Keyword heuristic score (pre-LLM gate). */
  score: number;
  reason: string;
  ts: string;
}

/** Result from annotating a single skill file. */
export type AnnotationResult =
  | 'appended'
  | 'created+appended'
  | 'skip:dup'
  | 'skip:hermes'
  | 'skip:not-local'
  | 'skip:capped'
  | 'cap:marked'
  | `error:${string}`;

/** A single parsed message from a JSONL transcript. */
export interface TranscriptEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  timestamp?: string;
  [key: string]: unknown;
}

/** Idempotency key for preventing double-annotations. */
export interface AnnotationKey {
  skill: string;
  sessionId: string;
  excerptHash: string;
}
