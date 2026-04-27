/** Signals extracted from a session transcript by the detector. */
export interface DetectorSignals {
  tool_calls: number;
  distinct_files_edited: number;
  distinct_tool_types: number;
  skill_invocations: number;
  user_turns: number;
}

/**
 * A suggestion emitted by detect() when the session crosses the complexity
 * threshold. Pure data — no I/O, safe to serialize to SQLite or JSON.
 */
export interface Suggestion {
  /** 8-char sha1 over sorted tool names + sorted file paths. */
  signature: string;
  session_id: string;
  signals: DetectorSignals;
  /** Unique tool names in first-seen order, capped at 20. */
  tool_sequence: string[];
  /** Unique file paths touched, capped at 30. */
  files_touched: string[];
  first_user_msg: string;
  last_user_msg: string;
  /** Bash commands matching dangerous-pattern regex, capped at 5. */
  danger_hits: string[];
}

/**
 * Result from enrich(). Contains the generated SKILL.md text plus audit
 * metadata from the SDK call.
 */
export interface EnrichedSuggestion {
  skill_md: string;
  /** kebab-case name extracted from frontmatter. */
  name: string;
  model: string;
  duration_ms: number | null;
  /** Reported by SDK. Subscription = $0 real cost. */
  cost_usd_reported: number | null;
}

/** A raw message object from a JSONL transcript. */
export interface TranscriptMessage {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  [key: string]: unknown;
}

/** A tool-use block extracted from assistant message content. */
export interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input?: Record<string, unknown>;
}
