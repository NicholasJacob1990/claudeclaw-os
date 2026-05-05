import { EventEmitter } from 'node:events';

// ── Bot info (set once from onStart, read by dashboard) ─────────────

let _botUsername = '';
let _botName = '';

export function setBotInfo(username: string, name: string): void {
  _botUsername = username;
  _botName = name;
}

export function getBotInfo(): { username: string; name: string } {
  return { username: _botUsername, name: _botName };
}

// ── Telegram connection state ────────────────────────────────────────

let _telegramConnected = false;

export function getTelegramConnected(): boolean {
  return _telegramConnected;
}

export function setTelegramConnected(v: boolean): void {
  _telegramConnected = v;
}

// ── Chat event bus (SSE broadcasting) ────────────────────────────────

export interface ChatEvent {
  type: 'user_message' | 'assistant_message' | 'assistant_photo' | 'processing' | 'progress' | 'error' | 'hive_mind';
  chatId: string;
  agentId?: string;
  content?: string;
  source?: 'telegram' | 'dashboard' | 'signal';
  description?: string;
  processing?: boolean;
  // Inline photo payload — emitted alongside assistant_message when the
  // agent reply included a [SEND_PHOTO|http(s) URL] marker. The chat
  // SPA renders this as an <img> bubble.
  url?: string;
  caption?: string;
  timestamp: number;
}

export const chatEvents = new EventEmitter();
chatEvents.setMaxListeners(20);

export function emitChatEvent(event: Omit<ChatEvent, 'timestamp'>): void {
  const full: ChatEvent = { ...event, timestamp: Date.now() };
  chatEvents.emit('chat', full);
}

// ── Processing state ─────────────────────────────────────────────────

let _processing = false;
let _processingChatId = '';

export function setProcessing(chatId: string, v: boolean): void {
  _processing = v;
  _processingChatId = v ? chatId : '';
  emitChatEvent({ type: 'processing', chatId, processing: v });
}

export function getIsProcessing(): { processing: boolean; chatId: string } {
  return { processing: _processing, chatId: _processingChatId };
}

// ── Active query abort ──────────────────────────────────────────────

const _activeAbort = new Map<string, AbortController>();

export function setActiveAbort(chatId: string, ctrl: AbortController | null): void {
  if (ctrl) _activeAbort.set(chatId, ctrl);
  else _activeAbort.delete(chatId);
}

export function abortActiveQuery(chatId: string): boolean {
  const ctrl = _activeAbort.get(chatId);
  if (ctrl) {
    ctrl.abort();
    _activeAbort.delete(chatId);
    return true;
  }
  return false;
}

/** Aborts every registered controller whose key starts with `prefix`.
 *  Used by the text war room to kill all of a meeting's per-agent SDK
 *  queries at once — without this, cancellation has to wait up to 50ms
 *  for the in-orchestrator watcher poll to notice the cancelFlag flip. */
export function abortByPrefix(prefix: string): number {
  let count = 0;
  for (const [key, ctrl] of _activeAbort) {
    if (!key.startsWith(prefix)) continue;
    try { ctrl.abort(); count++; } catch { /* noop */ }
    _activeAbort.delete(key);
  }
  return count;
}
